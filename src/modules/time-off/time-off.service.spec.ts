import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  BadRequestException,
} from "@nestjs/common";

import { TimeOffService } from "../../modules/time-off/time-off.service";
import { BalancesService } from "src/modules/balances/balances.service";
import {
  RequestStatus,
  OutboxEventType,
  OutboxStatus,
  LedgerEventType,
} from "../../common/enums";
import {
  SubmitRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
  CancelRequestDto,
} from "src/modules/time-off/dto/time-off-request.dto";

import {
  makeBalance,
  makeRequest,
  makeMockEntityManager,
  makeMockDataSource,
  makeQueryBuilderStub,
  MockEntityManager,
} from "src/test-helpers";

import {
  TimeOffRequest,
  BalanceLedger,
  OutboxEvent,
  TimeOffBalance,
} from "src/database/entities";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & fixtures
// ─────────────────────────────────────────────────────────────────────────────

const IDEM_KEY = "123e4567-e89b-4d3c-a456-426614174000";
const EMP = "emp-001";
const LOC = "loc-nyc";

const baseSubmitDto: SubmitRequestDto = {
  employeeId: EMP,
  locationId: LOC,
  daysRequested: 3,
  startDate: "2026-05-01",
  endDate: "2026-05-03",
  leaveType: "ANNUAL",
  submittedBy: EMP,
};

const baseApproveDto: ApproveRequestDto = {
  reviewedBy: "mgr-001",
  notes: "Approved.",
};

const baseRejectDto: RejectRequestDto = {
  reviewedBy: "mgr-001",
  rejectionReason: "Team coverage required.",
};

const baseCancelDto: CancelRequestDto = {
  cancelledBy: EMP,
  reason: "Changed my mind.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

function makeRepoMock() {
  return {
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    create: jest.fn().mockImplementation((dto) => ({ ...dto })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
}

function makeBalancesServiceMock() {
  return {
    getEffectiveBalance: jest.fn(),
    forceSync: jest.fn(),
    upsertFromBatch: jest.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("TimeOffService", () => {
  let service: TimeOffService;
  let balancesService: ReturnType<typeof makeBalancesServiceMock>;
  let requestRepo: ReturnType<typeof makeRepoMock>;
  let balanceRepo: ReturnType<typeof makeRepoMock>;
  let txManager: MockEntityManager;

  beforeEach(async () => {
    balancesService = makeBalancesServiceMock();
    requestRepo = makeRepoMock();
    balanceRepo = makeRepoMock();
    txManager = makeMockEntityManager();

    const dataSource = makeMockDataSource(txManager);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(TimeOffBalance), useValue: balanceRepo },
        {
          provide: getRepositoryToken(BalanceLedger),
          useValue: makeRepoMock(),
        },
        { provide: getRepositoryToken(OutboxEvent), useValue: makeRepoMock() },
        { provide: "DataSource", useValue: dataSource },
        { provide: BalancesService, useValue: balancesService },
      ],
    }).compile();

    service = module.get(TimeOffService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═══════════════════════════════════════════════════════════════════════════
  // submitRequest()
  // ═══════════════════════════════════════════════════════════════════════════

  describe("submitRequest()", () => {
    function setupSuccessfulSubmit(hcmBalance = 10, activeReservations = 0) {
      // Pre-transaction balance warm-up
      balancesService.getEffectiveBalance.mockResolvedValue({
        hcmBalance,
        activeReservationDays: activeReservations,
        effectiveBalance: hcmBalance - activeReservations,
        isStale: false,
        lastSyncedAt: new Date().toISOString(),
        syncSource: "REALTIME",
      });

      // Inside transaction: findOne returns the balance row
      txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance }));

      // Inside transaction: SUM of active reservations
      const qb = makeQueryBuilderStub({ total: String(activeReservations) });
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

      // Inside transaction: save returns the created request
      const savedRequest = makeRequest({
        daysRequested: baseSubmitDto.daysRequested,
        status: RequestStatus.PENDING,
      });
      txManager.save
        .mockResolvedValueOnce(savedRequest) // request save
        .mockResolvedValueOnce({}); // ledger save
      txManager.create.mockImplementation((_, dto) => ({
        ...dto,
        id: "req-new-001",
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    }

    describe("happy path", () => {
      it("returns a PENDING request with the correct effectiveBalanceAfterReservation", async () => {
        setupSuccessfulSubmit(10, 0);

        const result = await service.submitRequest(baseSubmitDto, IDEM_KEY);

        expect(result.status).toBe(RequestStatus.PENDING);
        expect(result.effectiveBalanceAfterReservation).toBe(7); // 10 - 0 - 3
      });

      it("stores the idempotency key on the request entity", async () => {
        setupSuccessfulSubmit(10, 0);
        await service.submitRequest(baseSubmitDto, IDEM_KEY);

        const createCall = txManager.create.mock.calls[0][1];
        expect(createCall.idempotencyKey).toBe(IDEM_KEY);
      });

      it("writes a RESERVATION_CREATED ledger entry with a negative delta", async () => {
        setupSuccessfulSubmit(10, 0);
        await service.submitRequest(baseSubmitDto, IDEM_KEY);

        // Second create() call is the ledger row
        const ledgerCreateCall = txManager.create.mock.calls[1][1];
        expect(ledgerCreateCall.eventType).toBe(
          LedgerEventType.RESERVATION_CREATED,
        );
        expect(ledgerCreateCall.delta).toBe(-3);
      });

      it("snapshots the effective balance at submission time on the request row", async () => {
        setupSuccessfulSubmit(10, 2); // effective = 8, requesting 3

        await service.submitRequest(
          { ...baseSubmitDto, daysRequested: 3 },
          IDEM_KEY,
        );

        const requestCreateCall = txManager.create.mock.calls[0][1];
        expect(requestCreateCall.balanceSnapshot).toBe(8); // 10 - 2
      });

      it("allows a half-day request (0.5 days) when balance is sufficient", async () => {
        setupSuccessfulSubmit(5, 0);

        const result = await service.submitRequest(
          { ...baseSubmitDto, daysRequested: 0.5 },
          IDEM_KEY,
        );

        expect(result.status).toBe(RequestStatus.PENDING);
        expect(result.effectiveBalanceAfterReservation).toBe(4.5);
      });

      it("allows a request that exactly exhausts the remaining balance (edge = 0)", async () => {
        setupSuccessfulSubmit(3, 0); // exactly 3 days left, requesting 3

        const result = await service.submitRequest(
          { ...baseSubmitDto, daysRequested: 3 },
          IDEM_KEY,
        );

        expect(result.status).toBe(RequestStatus.PENDING);
        expect(result.effectiveBalanceAfterReservation).toBe(0);
      });
    });

    describe("balance validation — the definitive inner-transaction check", () => {
      it("throws 422 INSUFFICIENT_BALANCE when effective balance < daysRequested", async () => {
        // Pre-fetch says 5 days (stale), but inner transaction SUM reveals only 1 day left
        balancesService.getEffectiveBalance.mockResolvedValue({
          hcmBalance: 5,
          activeReservationDays: 4,
          effectiveBalance: 1,
          isStale: false,
          lastSyncedAt: new Date().toISOString(),
          syncSource: "REALTIME",
        });
        txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance: 5 }));
        const qb = makeQueryBuilderStub({ total: "4" }); // 4 days reserved
        txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

        await expect(
          service.submitRequest(
            { ...baseSubmitDto, daysRequested: 3 },
            IDEM_KEY,
          ),
        ).rejects.toThrow(UnprocessableEntityException);
      });

      it("includes the live numbers in the 422 error body", async () => {
        balancesService.getEffectiveBalance.mockResolvedValue({
          hcmBalance: 10,
          activeReservationDays: 9,
          effectiveBalance: 1,
          isStale: false,
          lastSyncedAt: new Date().toISOString(),
          syncSource: "REALTIME",
        });
        txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance: 10 }));
        const qb = makeQueryBuilderStub({ total: "9" });
        txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

        try {
          await service.submitRequest(
            { ...baseSubmitDto, daysRequested: 3 },
            IDEM_KEY,
          );
          fail("expected to throw");
        } catch (e) {
          expect(e).toBeInstanceOf(UnprocessableEntityException);
          expect(e.getResponse()).toMatchObject({
            error: "INSUFFICIENT_BALANCE",
            hcmBalance: 10,
            activeReservationDays: 9,
            effectiveBalance: 1,
            requestedDays: 3,
          });
        }
      });

      it("throws 422 when a concurrent submission consumed the last available days (TRD §7.1 row 1)", async () => {
        // Pre-transaction: 5 days free (looks OK)
        balancesService.getEffectiveBalance.mockResolvedValue({
          hcmBalance: 5,
          activeReservationDays: 0,
          effectiveBalance: 5,
          isStale: false,
          lastSyncedAt: new Date().toISOString(),
          syncSource: "REALTIME",
        });
        txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance: 5 }));

        // Inside transaction: a concurrent request has now consumed all 5 days
        const qb = makeQueryBuilderStub({ total: "5" });
        txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

        await expect(
          service.submitRequest(
            { ...baseSubmitDto, daysRequested: 1 },
            IDEM_KEY,
          ),
        ).rejects.toThrow(UnprocessableEntityException);
      });
    });

    describe("input validation", () => {
      it("throws 400 BadRequest when endDate is before startDate", async () => {
        balancesService.getEffectiveBalance.mockResolvedValue({
          hcmBalance: 10,
          activeReservationDays: 0,
          effectiveBalance: 10,
          isStale: false,
          lastSyncedAt: new Date().toISOString(),
          syncSource: "REALTIME",
        });

        await expect(
          service.submitRequest(
            {
              ...baseSubmitDto,
              startDate: "2026-05-10",
              endDate: "2026-05-01",
            },
            IDEM_KEY,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it("throws NotFoundException when balance record does not exist for the given employee/location", async () => {
        balancesService.getEffectiveBalance.mockRejectedValue(
          new NotFoundException("No balance record"),
        );

        await expect(
          service.submitRequest(baseSubmitDto, IDEM_KEY),
        ).rejects.toThrow(NotFoundException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // approveRequest()
  // ═══════════════════════════════════════════════════════════════════════════

  describe("approveRequest()", () => {
    function setupPendingRequest(overrides: Partial<TimeOffRequest> = {}) {
      const req = makeRequest({ status: RequestStatus.PENDING, ...overrides });
      requestRepo.findOne.mockResolvedValue(req);
      txManager.findOne.mockResolvedValue(req);
      txManager.save.mockImplementation((_, e) =>
        Promise.resolve({ ...e, updatedAt: new Date() }),
      );
      txManager.create.mockImplementation((_, dto) => ({
        ...dto,
        id: "outbox-new-001",
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      return req;
    }

    describe("happy path", () => {
      it("transitions request to APPROVED and returns outboxEventId", async () => {
        setupPendingRequest();

        const result = await service.approveRequest("req-001", baseApproveDto);

        expect(result.status).toBe(RequestStatus.APPROVED);
        expect(result.outboxEventId).toBeDefined();
        expect(result.reviewedBy).toBe("mgr-001");
      });

      it("writes an APPLY outbox event with status PENDING in the SAME transaction as the request UPDATE", async () => {
        setupPendingRequest();

        await service.approveRequest("req-001", baseApproveDto);

        // Both saves happen inside the transaction manager, not the raw repo
        const saveCalls = txManager.save.mock.calls;
        const [requestSave, outboxSave] = saveCalls;

        expect(requestSave[1]).toMatchObject({
          status: RequestStatus.APPROVED,
        });
        expect(
          outboxSave[1] ?? txManager.create.mock.calls[0][1],
        ).toBeDefined();

        // Verify the outbox create was called with correct event shape
        const outboxCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        expect(outboxCreateCall).toBeDefined();
        expect(outboxCreateCall[1]).toMatchObject({
          eventType: OutboxEventType.APPLY,
          status: OutboxStatus.PENDING,
        });
      });

      it('sets the outbox idempotency_key to "{requestId}:APPLY:1"', async () => {
        const req = setupPendingRequest({ id: "req-abc" });

        await service.approveRequest("req-abc", baseApproveDto);

        const outboxCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        expect(outboxCreateCall[1].idempotencyKey).toBe("req-abc:APPLY:1");
      });

      it("sets next_attempt_at to approximately now() so the worker picks it up immediately", async () => {
        setupPendingRequest();
        const before = new Date();

        await service.approveRequest("req-001", baseApproveDto);

        const outboxCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        const nextAttemptAt: Date = outboxCreateCall[1].nextAttemptAt;
        const after = new Date();

        expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
          before.getTime() - 100,
        );
        expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(
          after.getTime() + 100,
        );
      });

      it("serialises all request fields into the outbox payload JSON", async () => {
        const req = setupPendingRequest({
          employeeId: EMP,
          locationId: LOC,
          daysRequested: 3,
          leaveType: "SICK",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
        });

        await service.approveRequest(req.id, baseApproveDto);

        const outboxCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        const payload = JSON.parse(outboxCreateCall[1].payload);
        expect(payload).toMatchObject({
          employeeId: EMP,
          locationId: LOC,
          daysRequested: 3,
          leaveType: "SICK",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
          referenceId: req.id,
        });
      });

      it("does NOT re-check the balance (the corrected behaviour from code review)", async () => {
        // A request for 10 days against an hcm_balance of 10 leaves effective=0.
        // Old (wrong) logic would evaluate 0 < 10 and throw 422.
        // Correct logic: once PENDING, the reservation is held — just check status.
        setupPendingRequest({ daysRequested: 10 });
        balancesService.getEffectiveBalance.mockResolvedValue({
          hcmBalance: 10,
          activeReservationDays: 10,
          effectiveBalance: 0,
          isStale: false,
          lastSyncedAt: new Date().toISOString(),
          syncSource: "REALTIME",
        });

        // Must NOT throw
        await expect(
          service.approveRequest("req-001", baseApproveDto),
        ).resolves.toBeDefined();

        // getEffectiveBalance must never have been called — no balance check in approve
        expect(balancesService.getEffectiveBalance).not.toHaveBeenCalled();
      });
    });

    describe("status guards", () => {
      it.each([
        RequestStatus.APPROVED,
        RequestStatus.HCM_PENDING,
        RequestStatus.FINALIZED,
        RequestStatus.REJECTED,
        RequestStatus.HCM_FAILED,
      ])(
        "throws 409 ConflictException when request is already in status %s",
        async (status) => {
          requestRepo.findOne.mockResolvedValue(makeRequest({ status }));

          await expect(
            service.approveRequest("req-001", baseApproveDto),
          ).rejects.toThrow(ConflictException);
        },
      );

      it("throws 404 NotFoundException when request does not exist", async () => {
        requestRepo.findOne.mockResolvedValue(null);

        await expect(
          service.approveRequest("req-nonexistent", baseApproveDto),
        ).rejects.toThrow(NotFoundException);
      });

      it("throws 409 when concurrent approval races and changes status inside the transaction (TRD §7.1 row 1)", async () => {
        // Pre-transaction snapshot says PENDING...
        requestRepo.findOne.mockResolvedValue(
          makeRequest({ status: RequestStatus.PENDING }),
        );
        // ...but inside the transaction the row has been updated to APPROVED by a concurrent request
        txManager.findOne.mockResolvedValue(
          makeRequest({ status: RequestStatus.APPROVED }),
        );

        await expect(
          service.approveRequest("req-001", baseApproveDto),
        ).rejects.toThrow(ConflictException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // rejectRequest()
  // ═══════════════════════════════════════════════════════════════════════════

  describe("rejectRequest()", () => {
    function setupPendingForReject() {
      const req = makeRequest({ status: RequestStatus.PENDING });
      requestRepo.findOne.mockResolvedValue(req);
      txManager.findOne.mockResolvedValue(req);
      txManager.save.mockImplementation((_, e) =>
        Promise.resolve({ ...e, updatedAt: new Date() }),
      );
      txManager.create.mockImplementation((_, dto) => ({ ...dto }));
      return req;
    }

    describe("happy path", () => {
      it("transitions request to REJECTED and returns the reason", async () => {
        setupPendingForReject();

        const result = await service.rejectRequest("req-001", baseRejectDto);

        expect(result.status).toBe(RequestStatus.REJECTED);
        expect(result.rejectionReason).toBe("Team coverage required.");
      });

      it("writes a RESERVATION_RELEASED ledger entry with a POSITIVE delta (credit back)", async () => {
        const req = setupPendingForReject();
        req.daysRequested = 3;

        await service.rejectRequest("req-001", baseRejectDto);

        const ledgerCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === BalanceLedger,
        );
        expect(ledgerCreateCall[1].eventType).toBe(
          LedgerEventType.RESERVATION_RELEASED,
        );
        expect(ledgerCreateCall[1].delta).toBe(3); // positive — credit back
      });

      it("does NOT write an outbox event (rejection is a local-only operation)", async () => {
        setupPendingForReject();

        await service.rejectRequest("req-001", baseRejectDto);

        const outboxCreateCall = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        expect(outboxCreateCall).toBeUndefined();
      });

      it("does NOT modify hcm_balance — effective balance restores via SUM exclusion", async () => {
        setupPendingForReject();

        await service.rejectRequest("req-001", baseRejectDto);

        // No update on TimeOffBalance
        const balanceUpdateCall = txManager.update.mock.calls.find(
          (c) => c[0] === TimeOffBalance,
        );
        expect(balanceUpdateCall).toBeUndefined();
      });
    });

    describe("status guards", () => {
      it.each([
        RequestStatus.APPROVED,
        RequestStatus.HCM_PENDING,
        RequestStatus.FINALIZED,
        RequestStatus.HCM_FAILED,
      ])("throws 409 when request is in status %s", async (status) => {
        requestRepo.findOne.mockResolvedValue(makeRequest({ status }));

        await expect(
          service.rejectRequest("req-001", baseRejectDto),
        ).rejects.toThrow(ConflictException);
      });

      it("throws 409 with actionable guidance text when request is already FINALIZED", async () => {
        requestRepo.findOne.mockResolvedValue(
          makeRequest({ status: RequestStatus.FINALIZED }),
        );

        try {
          await service.rejectRequest("req-001", baseRejectDto);
          fail("expected to throw");
        } catch (e) {
          expect(e).toBeInstanceOf(ConflictException);
          const body = e.getResponse() as Record<string, string>;
          expect(body.message).toMatch(/cancel endpoint/i);
        }
      });

      it("throws 404 when request does not exist", async () => {
        requestRepo.findOne.mockResolvedValue(null);

        await expect(
          service.rejectRequest("req-nonexistent", baseRejectDto),
        ).rejects.toThrow(NotFoundException);
      });

      it("throws 409 when concurrent approval changes status inside the transaction", async () => {
        requestRepo.findOne.mockResolvedValue(
          makeRequest({ status: RequestStatus.PENDING }),
        );
        // Concurrent approve happened between pre-tx read and tx lock
        txManager.findOne.mockResolvedValue(
          makeRequest({ status: RequestStatus.APPROVED }),
        );

        await expect(
          service.rejectRequest("req-001", baseRejectDto),
        ).rejects.toThrow(ConflictException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // cancelRequest()
  // ═══════════════════════════════════════════════════════════════════════════

  describe("cancelRequest()", () => {
    function setupForCancel(
      status: RequestStatus,
      overrides: Partial<TimeOffRequest> = {},
    ) {
      const req = makeRequest({
        status,
        hcmReferenceId: "hcm-ref-001",
        ...overrides,
      });
      requestRepo.findOne.mockResolvedValue(req);
      txManager.findOne.mockResolvedValue(req);
      txManager.save.mockImplementation((_, e) =>
        Promise.resolve({ ...e, updatedAt: new Date() }),
      );
      txManager.create.mockImplementation((_, dto) => ({ ...dto }));
      return req;
    }

    describe("cancelling a PENDING request (no HCM involvement)", () => {
      it("transitions to REJECTED and releases the reservation via ledger", async () => {
        setupForCancel(RequestStatus.PENDING);

        const result = await service.cancelRequest("req-001", baseCancelDto);

        expect(result.compensatingCreditQueued).toBe(false);
        const ledger = txManager.create.mock.calls.find(
          (c) => c[0] === BalanceLedger,
        );
        expect(ledger[1].eventType).toBe(LedgerEventType.RESERVATION_RELEASED);
        expect(ledger[1].delta).toBeGreaterThan(0);
      });

      it("does NOT write an outbox event for a PENDING cancellation", async () => {
        setupForCancel(RequestStatus.PENDING);

        await service.cancelRequest("req-001", baseCancelDto);

        const outbox = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        expect(outbox).toBeUndefined();
      });
    });

    describe("cancelling an APPROVED request (outbox not yet fired)", () => {
      it("releases reservation, sets REJECTED, no compensating credit queued", async () => {
        setupForCancel(RequestStatus.APPROVED);

        const result = await service.cancelRequest("req-001", baseCancelDto);

        expect(result.compensatingCreditQueued).toBe(false);
        expect(result.message).toMatch(/reserved balance has been released/i);
      });
    });

    describe("cancelling a FINALIZED request (TRD §7.1 row 6 — compensating credit)", () => {
      it("writes a COMPENSATING_CREDIT outbox event atomically", async () => {
        setupForCancel(RequestStatus.FINALIZED, {
          hcmReferenceId: "hcm-conf-9999",
        });

        const result = await service.cancelRequest("req-001", baseCancelDto);

        expect(result.compensatingCreditQueued).toBe(true);

        const outboxCreate = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        expect(outboxCreate).toBeDefined();
        expect(outboxCreate[1].eventType).toBe(
          OutboxEventType.COMPENSATING_CREDIT,
        );
        expect(outboxCreate[1].idempotencyKey).toBe(
          "req-001:COMPENSATING_CREDIT:1",
        );
      });

      it("serialises the original HCM reference into the compensating credit payload", async () => {
        setupForCancel(RequestStatus.FINALIZED, {
          hcmReferenceId: "hcm-conf-9999",
        });

        await service.cancelRequest("req-001", baseCancelDto);

        const outboxCreate = txManager.create.mock.calls.find(
          (c) => c[0] === OutboxEvent,
        );
        const payload = JSON.parse(outboxCreate[1].payload);
        expect(payload.originalConfirmationId).toBe("hcm-conf-9999");
        expect(payload.daysToCredit).toBe(3);
      });

      it("writes a COMPENSATING_CREDIT ledger entry with a positive delta", async () => {
        setupForCancel(RequestStatus.FINALIZED, {
          hcmReferenceId: "hcm-conf-9999",
        });

        await service.cancelRequest("req-001", baseCancelDto);

        const ledgerCreate = txManager.create.mock.calls.find(
          (c) => c[0] === BalanceLedger,
        );
        expect(ledgerCreate[1].eventType).toBe(
          LedgerEventType.COMPENSATING_CREDIT,
        );
        expect(ledgerCreate[1].delta).toBe(3); // positive — credit back
      });

      it("throws 409 when hcm_reference_id is missing on a FINALIZED request (defensive guard)", async () => {
        setupForCancel(RequestStatus.FINALIZED, { hcmReferenceId: null });

        await expect(
          service.cancelRequest("req-001", baseCancelDto),
        ).rejects.toThrow(ConflictException);
      });
    });

    describe("cancelling an HCM_PENDING request (in-flight warning — TRD §7.1 row 9)", () => {
      it("marks REJECTED and returns an opsWarning without queuing a compensating credit", async () => {
        setupForCancel(RequestStatus.HCM_PENDING);

        const result = await service.cancelRequest("req-001", baseCancelDto);

        expect(result.compensatingCreditQueued).toBe(false);
        expect(result.opsWarning).toMatch(/ops check is required/i);
      });
    });

    describe("terminal status guards (cannot cancel)", () => {
      it.each([RequestStatus.REJECTED, RequestStatus.HCM_FAILED])(
        "throws 409 when request is in terminal status %s",
        async (status) => {
          requestRepo.findOne.mockResolvedValue(makeRequest({ status }));

          await expect(
            service.cancelRequest("req-001", baseCancelDto),
          ).rejects.toThrow(ConflictException);
        },
      );

      it("throws 404 when request does not exist", async () => {
        requestRepo.findOne.mockResolvedValue(null);

        await expect(
          service.cancelRequest("req-nonexistent", baseCancelDto),
        ).rejects.toThrow(NotFoundException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getRequest() / listRequests()
  // ═══════════════════════════════════════════════════════════════════════════

  describe("getRequest()", () => {
    it("returns the request when found", async () => {
      const req = makeRequest();
      requestRepo.findOne.mockResolvedValue(req);

      const result = await service.getRequest("req-001");

      expect(result).toBe(req);
    });

    it("throws 404 when not found", async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.getRequest("req-missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("listRequests()", () => {
    it("returns paginated results filtered by employeeId", async () => {
      const requests = [makeRequest(), makeRequest({ id: "req-002" })];
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([requests, 2]),
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listRequests(EMP, undefined, 1, 20);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
    });

    it("applies status filter when provided", async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listRequests(EMP, "FINALIZED", 1, 20);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("status"),
        expect.objectContaining({ status: "FINALIZED" }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRD §7 edge cases — explicit regression tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("TRD §7.1 edge case regression tests", () => {
    it("[Row 1] Concurrent submissions: inner-transaction SUM is the definitive overdraft guard", async () => {
      // Both submissions arrive simultaneously with 5 days free.
      // The second one to reach the inner SUM sees 5 days already reserved.
      balancesService.getEffectiveBalance.mockResolvedValue({
        hcmBalance: 5,
        activeReservationDays: 0,
        effectiveBalance: 5,
        isStale: false,
        lastSyncedAt: new Date().toISOString(),
        syncSource: "REALTIME",
      });
      txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance: 5 }));
      const qb = makeQueryBuilderStub({ total: "5" }); // concurrent winner consumed all 5
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

      await expect(
        service.submitRequest({ ...baseSubmitDto, daysRequested: 1 }, IDEM_KEY),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it("[Row 5] Work anniversary credit: approval of full-balance request does NOT re-check balance", async () => {
      // Employee requested 5/5 days (effective = 0). HCM then credited 5 more (effective = 5).
      // The correct behaviour: approve() does NOT look at balance at all.
      const req = makeRequest({
        status: RequestStatus.PENDING,
        daysRequested: 5,
      });
      requestRepo.findOne.mockResolvedValue(req);
      txManager.findOne.mockResolvedValue(req);
      txManager.save.mockImplementation((_, e) =>
        Promise.resolve({ ...e, updatedAt: new Date() }),
      );
      txManager.create.mockImplementation((_, dto) => ({ ...dto }));

      // Even with effective_balance = 5 now (post-anniversary), approve must still succeed
      balancesService.getEffectiveBalance.mockResolvedValue({
        hcmBalance: 10,
        activeReservationDays: 5,
        effectiveBalance: 5,
        isStale: false,
        lastSyncedAt: new Date().toISOString(),
        syncSource: "REALTIME",
      });

      await expect(
        service.approveRequest("req-001", baseApproveDto),
      ).resolves.toBeDefined();
      expect(balancesService.getEffectiveBalance).not.toHaveBeenCalled();
    });

    it("[Row 6] Reject-after-finalize is blocked with correct 409 guidance", async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.FINALIZED }),
      );

      try {
        await service.rejectRequest("req-001", baseRejectDto);
        fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect(JSON.stringify(e.getResponse())).toMatch(
          /compensating credit|cancel endpoint/i,
        );
      }
    });

    it("[Row 9] HCM_PENDING cancellation surfaces opsWarning instead of silently queuing credit", async () => {
      const req = makeRequest({ status: RequestStatus.HCM_PENDING });
      requestRepo.findOne.mockResolvedValue(req);
      txManager.findOne.mockResolvedValue(req);
      txManager.save.mockImplementation((_, e) =>
        Promise.resolve({ ...e, updatedAt: new Date() }),
      );
      txManager.create.mockReturnValue({});

      const result = await service.cancelRequest("req-001", baseCancelDto);

      expect(result.opsWarning).toBeDefined();
      expect(result.compensatingCreditQueued).toBe(false);

      // No COMPENSATING_CREDIT outbox event written
      const outbox = txManager.create.mock.calls.find(
        (c) => c[0] === OutboxEvent,
      );
      expect(outbox).toBeUndefined();
    });
  });
});
