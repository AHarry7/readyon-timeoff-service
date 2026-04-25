import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";

import { BalancesService } from "src/modules/balances/balances.service";
import { HcmClientService } from "../../hcm-client/hcm-client.service";
import { SyncSource, RequestStatus, LedgerEventType } from "../../common/enums";

import {
  makeBalance,
  makeMockEntityManager,
  makeMockDataSource,
  makeQueryBuilderStub,
  MockEntityManager,
} from "src/test-helpers";

import {
  TimeOffBalance,
  BalanceLedger,
  TimeOffRequest,
} from "src/database/entities";

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeHcmClientMock() {
  return {
    getHcmBalance: jest.fn(),
    applyDeduction: jest.fn(),
    reverseDeduction: jest.fn(),
  };
}

function makeRepositoryMock() {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn().mockImplementation((dto) => ({ ...dto })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("BalancesService", () => {
  let service: BalancesService;
  let hcmClient: ReturnType<typeof makeHcmClientMock>;
  let balanceRepo: ReturnType<typeof makeRepositoryMock>;
  let requestRepo: ReturnType<typeof makeRepositoryMock>;
  let ledgerRepo: ReturnType<typeof makeRepositoryMock>;
  let txManager: MockEntityManager;

  const EMP = "emp-001";
  const LOC = "loc-nyc";

  beforeEach(async () => {
    hcmClient = makeHcmClientMock();
    balanceRepo = makeRepositoryMock();
    requestRepo = makeRepositoryMock();
    ledgerRepo = makeRepositoryMock();
    txManager = makeMockEntityManager();

    const dataSource = makeMockDataSource(txManager);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(TimeOffBalance), useValue: balanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(BalanceLedger), useValue: ledgerRepo },
        { provide: "DataSource", useValue: dataSource },
        { provide: HcmClientService, useValue: hcmClient },
      ],
    }).compile();

    service = module.get(BalancesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── getEffectiveBalance ────────────────────────────────────────────────────

  describe("getEffectiveBalance()", () => {
    describe("when local balance is fresh (within 5 minutes)", () => {
      it("returns effectiveBalance = hcmBalance − activeReservations without calling HCM", async () => {
        const balance = makeBalance({
          hcmBalance: 10,
          lastSyncedAt: new Date(),
        });
        balanceRepo.findOne.mockResolvedValue(balance);

        // Stub the SUM query: 3 days reserved
        const qb = makeQueryBuilderStub({ total: "3" });
        requestRepo.createQueryBuilder.mockReturnValue(qb);

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(hcmClient.getHcmBalance).not.toHaveBeenCalled();
        expect(result.hcmBalance).toBe(10);
        expect(result.activeReservationDays).toBe(3);
        expect(result.effectiveBalance).toBe(7);
        expect(result.isStale).toBe(false);
      });

      it("returns effectiveBalance = hcmBalance when there are no active reservations", async () => {
        const balance = makeBalance({
          hcmBalance: 10,
          lastSyncedAt: new Date(),
        });
        balanceRepo.findOne.mockResolvedValue(balance);

        // COALESCE returns '0' when no requests match
        const qb = makeQueryBuilderStub({ total: "0" });
        requestRepo.createQueryBuilder.mockReturnValue(qb);

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.effectiveBalance).toBe(10);
        expect(result.activeReservationDays).toBe(0);
      });

      it("returns a negative effectiveBalance without throwing when reservations exceed hcmBalance (conflict scenario)", async () => {
        // TRD §7.3: batch arrived and set hcm_balance lower than active reservations.
        // The service must NOT throw — it returns the negative value so the controller
        // can block new submissions while allowing ops to reconcile.
        const balance = makeBalance({ hcmBalance: 2 });
        balanceRepo.findOne.mockResolvedValue(balance);

        const qb = makeQueryBuilderStub({ total: "5" });
        requestRepo.createQueryBuilder.mockReturnValue(qb);

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.effectiveBalance).toBe(-3);
        expect(result.isStale).toBe(false);
      });

      it("rounds effectiveBalance to 2 decimal places to avoid floating-point drift", async () => {
        const balance = makeBalance({ hcmBalance: 10 });
        balanceRepo.findOne.mockResolvedValue(balance);

        const qb = makeQueryBuilderStub({ total: "3.333333333" });
        requestRepo.createQueryBuilder.mockReturnValue(qb);

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.effectiveBalance).toBe(6.67);
      });
    });

    describe("when local balance is STALE (older than 5 minutes)", () => {
      it("calls HCM, updates hcm_balance, writes a ledger row, and returns fresh data", async () => {
        const staleBalance = makeBalance({
          hcmBalance: 8,
          lastSyncedAt: new Date(Date.now() - 6 * 60_000), // 6 min ago
        });
        balanceRepo.findOne.mockResolvedValue(staleBalance);

        hcmClient.getHcmBalance.mockResolvedValue({
          success: true,
          data: {
            employeeId: EMP,
            locationId: LOC,
            balanceDays: 13,
            asOfDate: "2026-04-25",
          },
          statusCode: 200,
        });

        // Transaction: findOne returns the existing record so the UPDATE path runs
        txManager.findOne.mockResolvedValue(staleBalance);
        txManager.save
          .mockImplementationOnce((_, entity) => Promise.resolve(entity)) // balance save
          .mockImplementationOnce((_, entity) => Promise.resolve(entity)); // ledger save

        // After the sync, re-read for the SUM query (re-fetch of updated record)
        balanceRepo.findOne
          .mockResolvedValueOnce(staleBalance) // stale — triggers sync
          .mockResolvedValueOnce({ ...staleBalance, hcmBalance: 13 }); // post-sync read

        const qb = makeQueryBuilderStub({ total: "0" });
        requestRepo.createQueryBuilder.mockReturnValue(qb);

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(hcmClient.getHcmBalance).toHaveBeenCalledWith(EMP, LOC);
        expect(result.hcmBalance).toBe(13);
        expect(result.isStale).toBe(false);
      });

      it("writes a ledger entry with event_type HCM_SYNC_REALTIME and the correct delta", async () => {
        const staleBalance = makeBalance({
          hcmBalance: 8,
          lastSyncedAt: new Date(Date.now() - 10 * 60_000),
        });
        balanceRepo.findOne.mockResolvedValue(staleBalance);
        hcmClient.getHcmBalance.mockResolvedValue({
          success: true,
          data: {
            employeeId: EMP,
            locationId: LOC,
            balanceDays: 15,
            asOfDate: "2026-04-25",
          },
          statusCode: 200,
        });
        txManager.findOne.mockResolvedValue(staleBalance);
        txManager.save.mockImplementation((_, entity) =>
          Promise.resolve(entity),
        );
        balanceRepo.findOne
          .mockResolvedValueOnce(staleBalance)
          .mockResolvedValueOnce({ ...staleBalance, hcmBalance: 15 });
        requestRepo.createQueryBuilder.mockReturnValue(
          makeQueryBuilderStub({ total: "0" }),
        );

        await service.getEffectiveBalance(EMP, LOC);

        // The second save() call inside the transaction is the ledger row
        const ledgerArg = txManager.save.mock.calls[1][1];
        expect(ledgerArg.eventType).toBe(LedgerEventType.HCM_SYNC_REALTIME);
        expect(ledgerArg.delta).toBe(7); // 15 - 8
        expect(ledgerArg.referenceId).toBeNull();
      });

      it("serves stale data with isStale=true when HCM times out", async () => {
        const staleBalance = makeBalance({
          hcmBalance: 7,
          lastSyncedAt: new Date(Date.now() - 10 * 60_000),
        });
        balanceRepo.findOne.mockResolvedValue(staleBalance);
        hcmClient.getHcmBalance.mockResolvedValue({
          success: false,
          errorType: "TIMEOUT",
          errorMessage: "HCM did not respond within 10000ms",
        });
        requestRepo.createQueryBuilder.mockReturnValue(
          makeQueryBuilderStub({ total: "2" }),
        );

        const result = await service.getEffectiveBalance(EMP, LOC);

        // Should NOT throw — stale data is served
        expect(result.isStale).toBe(true);
        expect(result.hcmBalance).toBe(7);
        expect(result.effectiveBalance).toBe(5); // 7 - 2
        expect(result.staleness?.errorType).toBe("TIMEOUT");
      });

      it("serves stale data with isStale=true when HCM returns 5xx", async () => {
        const staleBalance = makeBalance({
          lastSyncedAt: new Date(Date.now() - 10 * 60_000),
        });
        balanceRepo.findOne.mockResolvedValue(staleBalance);
        hcmClient.getHcmBalance.mockResolvedValue({
          success: false,
          errorType: "SERVER_ERROR",
          errorMessage: "HCM returned HTTP 503",
          statusCode: 503,
        });
        requestRepo.createQueryBuilder.mockReturnValue(
          makeQueryBuilderStub({ total: "0" }),
        );

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.isStale).toBe(true);
        expect(result.staleness?.errorType).toBe("SERVER_ERROR");
        expect(hcmClient.getHcmBalance).toHaveBeenCalledTimes(1);
      });
    });

    describe("when NO local balance record exists", () => {
      it("fetches from HCM, creates a new balance record, and returns it", async () => {
        balanceRepo.findOne.mockResolvedValue(null);

        hcmClient.getHcmBalance.mockResolvedValue({
          success: true,
          data: {
            employeeId: EMP,
            locationId: LOC,
            balanceDays: 10,
            asOfDate: "2026-04-25",
          },
          statusCode: 200,
        });

        txManager.findOne.mockResolvedValue(null); // no existing record in tx
        txManager.create.mockReturnValue({
          employeeId: EMP,
          locationId: LOC,
          hcmBalance: 10,
        });
        txManager.save.mockImplementation((_, e) => Promise.resolve(e));

        balanceRepo.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ ...makeBalance(), hcmBalance: 10 });

        requestRepo.createQueryBuilder.mockReturnValue(
          makeQueryBuilderStub({ total: "0" }),
        );

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.hcmBalance).toBe(10);
        expect(result.isStale).toBe(false);
      });

      it("throws NotFoundException when no record exists AND HCM fails", async () => {
        balanceRepo.findOne.mockResolvedValue(null);
        hcmClient.getHcmBalance.mockResolvedValue({
          success: false,
          errorType: "NETWORK_ERROR",
          errorMessage: "ECONNREFUSED",
        });

        await expect(service.getEffectiveBalance(EMP, LOC)).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe("syncSource propagation", () => {
      it("returns syncSource = BATCH after a batch update", async () => {
        const balance = makeBalance({
          hcmBalance: 15,
          syncSource: SyncSource.BATCH,
          lastSyncedAt: new Date(),
        });
        balanceRepo.findOne.mockResolvedValue(balance);
        requestRepo.createQueryBuilder.mockReturnValue(
          makeQueryBuilderStub({ total: "0" }),
        );

        const result = await service.getEffectiveBalance(EMP, LOC);

        expect(result.syncSource).toBe(SyncSource.BATCH);
      });
    });
  });

  // ─── forceSync ──────────────────────────────────────────────────────────────

  describe("forceSync()", () => {
    it("calls HCM regardless of staleness and returns fresh effective balance", async () => {
      // Balance is NOT stale — forceSync should still call HCM
      const freshBalance = makeBalance({
        hcmBalance: 10,
        lastSyncedAt: new Date(),
      });
      balanceRepo.findOne.mockResolvedValue(freshBalance);

      hcmClient.getHcmBalance.mockResolvedValue({
        success: true,
        data: {
          employeeId: EMP,
          locationId: LOC,
          balanceDays: 12,
          asOfDate: "2026-04-25",
        },
        statusCode: 200,
      });

      txManager.findOne.mockResolvedValue(freshBalance);
      txManager.save.mockImplementation((_, e) => Promise.resolve(e));

      balanceRepo.findOne
        .mockResolvedValueOnce(freshBalance)
        .mockResolvedValueOnce({ ...freshBalance, hcmBalance: 12 });

      requestRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ total: "0" }),
      );

      const result = await service.forceSync(EMP, LOC);

      expect(hcmClient.getHcmBalance).toHaveBeenCalledWith(EMP, LOC);
      expect(result.hcmBalance).toBe(12);
    });

    it("throws (does NOT serve stale) when HCM is unreachable during a forced sync", async () => {
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      hcmClient.getHcmBalance.mockResolvedValue({
        success: false,
        errorType: "TIMEOUT",
        errorMessage: "HCM timed out",
      });

      await expect(service.forceSync(EMP, LOC)).rejects.toThrow(
        /HCM real-time sync failed/i,
      );
    });
  });

  // ─── upsertFromBatch ────────────────────────────────────────────────────────

  describe("upsertFromBatch()", () => {
    const BATCH_SNAPSHOT_ID = "batch-snap-001";

    it("applies the new HCM balance and writes a HCM_SYNC_BATCH ledger row", async () => {
      const existing = makeBalance({ hcmBalance: 8 });
      txManager.findOne.mockResolvedValue(existing);

      // No active reservations
      const qb = makeQueryBuilderStub({ total: "0" });
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);

      txManager.update.mockResolvedValue({ affected: 1 });
      txManager.save.mockImplementation((_, e) => Promise.resolve(e));

      const result = await service.upsertFromBatch(
        txManager as any,
        EMP,
        LOC,
        15,
        BATCH_SNAPSHOT_ID,
      );

      expect(result.applied).toBe(true);
      expect(result.conflictDetected).toBe(false);
      expect(result.effectiveBalance).toBe(15);

      // The save call is for the ledger row
      const ledgerArg = txManager.save.mock.calls[0][1];
      expect(ledgerArg.eventType).toBe(LedgerEventType.HCM_SYNC_BATCH);
      expect(ledgerArg.delta).toBe(7); // 15 - 8
      expect(ledgerArg.referenceId).toBe(BATCH_SNAPSHOT_ID);
    });

    it("detects conflict when active reservations exceed the new HCM balance (TRD §5.4)", async () => {
      // Employee has 7 days reserved, but HCM batch says only 5 days total.
      // This means HCM's value is less than what we have reserved — conflict.
      const existing = makeBalance({ hcmBalance: 10 });
      txManager.findOne.mockResolvedValue(existing);

      const qb = makeQueryBuilderStub({ total: "7" }); // 7 days reserved
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);
      txManager.update.mockResolvedValue({ affected: 1 });
      txManager.save.mockImplementation((_, e) => Promise.resolve(e));

      const result = await service.upsertFromBatch(
        txManager as any,
        EMP,
        LOC,
        5,
        BATCH_SNAPSHOT_ID,
      );

      expect(result.conflictDetected).toBe(true);
      expect(result.effectiveBalance).toBe(-2); // 5 - 7
      expect(result.applied).toBe(true); // HCM value still applied (it is authoritative)
    });

    it("inserts a NEW record when no existing balance exists (new employee in batch)", async () => {
      txManager.findOne.mockResolvedValue(null); // no existing record

      const qb = makeQueryBuilderStub({ total: "0" });
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);
      txManager.create.mockReturnValue({
        employeeId: EMP,
        locationId: LOC,
        hcmBalance: 10,
      });
      txManager.save.mockImplementation((_, e) => Promise.resolve(e));

      const result = await service.upsertFromBatch(
        txManager as any,
        EMP,
        LOC,
        10,
        BATCH_SNAPSHOT_ID,
      );

      expect(result.applied).toBe(true);
      // create was called with TimeOffBalance entity class
      expect(txManager.create).toHaveBeenCalledWith(
        TimeOffBalance,
        expect.objectContaining({
          hcmBalance: 10,
          syncSource: SyncSource.BATCH,
        }),
      );
    });

    it("treats null balanceDays gracefully — applies zero, detects conflict if reservations exist", async () => {
      // Edge case TRD §7.1 row 7: null balance from HCM must not coerce to 0 silently
      // In our impl the service receives the parsed value; the SyncService guards null upstream.
      // Here we test that 0 is handled correctly when passed through.
      txManager.findOne.mockResolvedValue(makeBalance({ hcmBalance: 5 }));
      const qb = makeQueryBuilderStub({ total: "3" });
      txManager.createQueryBuilder = jest.fn().mockReturnValue(qb);
      txManager.update.mockResolvedValue({ affected: 1 });
      txManager.save.mockImplementation((_, e) => Promise.resolve(e));

      const result = await service.upsertFromBatch(
        txManager as any,
        EMP,
        LOC,
        0,
        BATCH_SNAPSHOT_ID,
      );

      expect(result.conflictDetected).toBe(true);
      expect(result.effectiveBalance).toBe(-3); // 0 - 3
    });
  });
});
