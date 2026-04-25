import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, EntityManager } from "typeorm";

import { TimeOffRequest } from "../../database/entities/time-off-request.entity";
import { TimeOffBalance } from "../../database/entities/time-off-balance.entity";
import { BalanceLedger } from "../../database/entities/balance-ledger.entity";
import { OutboxEvent } from "../../database/entities/outbox-event.entity";
import {
  RequestStatus,
  LedgerEventType,
  OutboxEventType,
  OutboxStatus,
} from "../../common/enums";
import { BalancesService } from "../../modules/balances/balances.service";
import {
  SubmitRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
  CancelRequestDto,
} from "./dto/time-off-request.dto";

/** Statuses whose days count as active reservations against the balance. */
const ACTIVE_RESERVATION_STATUSES: RequestStatus[] = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.HCM_PENDING,
];

/** The only status from which a request can be approved. */
const APPROVABLE_STATUSES = new Set([RequestStatus.PENDING]);

/** The only status from which a request can be rejected by a manager. */
const REJECTABLE_STATUSES = new Set([RequestStatus.PENDING]);

/** Statuses from which a cancellation is valid and what each implies. */
const CANCELLABLE_STATUSES = new Set([
  RequestStatus.PENDING, // Simple: release reservation, no HCM call.
  RequestStatus.APPROVED, // Simple: release reservation, no HCM call (outbox not yet fired).
  RequestStatus.HCM_PENDING, // Dangerous: outbox in-flight. Handled with advisory note.
  RequestStatus.FINALIZED, // Requires compensating HCM credit via new outbox event.
]);

/**
 * TimeOffService
 *
 * Owns the full lifecycle of a TimeOffRequest entity:
 *   submit → [approve | reject] → [finalize via outbox] → [cancel]
 *
 * TRANSACTION DISCIPLINE:
 *  Every method that mutates more than one table opens an explicit
 *  dataSource.transaction() call. The EntityManager passed to the callback
 *  is the ONLY way to interact with the DB inside that block — using
 *  injected repositories would bypass the transaction boundary.
 *
 * BALANCE ARITHMETIC:
 *  The hcm_balance column in time_off_balances is NEVER modified here.
 *  It is modified only by:
 *   - BalancesService (real-time/batch HCM sync)
 *   - OutboxWorkerService (after HCM confirms a deduction)
 *  Effective balance is always COMPUTED from hcm_balance minus the SUM of
 *  active reservations. The balance_ledger is the audit trail.
 */
@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,

    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly balancesService: BalancesService,
  ) {}

  // ── Submit ─────────────────────────────────────────────────────────────────

  /**
   * Submits a new time-off request and creates a PENDING reservation.
   *
   * TRANSACTION CONTENTS (single BEGIN/COMMIT):
   *   1. Re-read effective balance inside the transaction (authoritative check).
   *   2. Reject with 422 if insufficient.
   *   3. INSERT time_off_requests (status = PENDING).
   *   4. INSERT balance_ledger (RESERVATION_CREATED).
   *
   * The pre-transaction balance fetch (via balancesService) may trigger a
   * real-time HCM sync if the cache is stale, giving the employee the
   * freshest number before we open the write transaction.
   */
  async submitRequest(
    dto: SubmitRequestDto,
    idempotencyKey: string,
  ): Promise<SubmitResponsePayload> {
    // ── Business rule: end_date >= start_date ─────────────────────────────
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException(
        `end_date (${dto.endDate}) must not be before start_date (${dto.startDate}).`,
      );
    }

    // ── Pre-transaction: warm the cache (may trigger real-time HCM sync) ──
    // If this throws NotFoundException (no balance record + HCM down), it
    // propagates as a 404 — the employee cannot submit without a known balance.
    await this.balancesService.getEffectiveBalance(
      dto.employeeId,
      dto.locationId,
    );

    // ── Atomic transaction ─────────────────────────────────────────────────
    const result = await this.dataSource.transaction(async (manager) => {
      // Step 1: Re-read hcm_balance inside the transaction so our check
      // reflects any concurrent writes that committed since the pre-fetch.
      const balance = await manager.findOne(TimeOffBalance, {
        where: { employeeId: dto.employeeId, locationId: dto.locationId },
      });

      if (!balance) {
        // Should not happen if pre-fetch succeeded, but guard defensively.
        throw new NotFoundException(
          `No balance record for employee ${dto.employeeId} / location ${dto.locationId}.`,
        );
      }

      // Step 2: Compute effective balance INSIDE the transaction.
      // This is the definitive overdraft guard. It sees the committed state
      // of all concurrent requests — SQLite serialises all writes, so no
      // other PENDING insert can interleave between this read and our INSERT.
      const activeReservations = await this.sumActiveReservations(
        manager,
        dto.employeeId,
        dto.locationId,
      );

      const effectiveBalance =
        Math.round((balance.hcmBalance - activeReservations) * 100) / 100;

      if (effectiveBalance < dto.daysRequested) {
        throw new UnprocessableEntityException({
          error: "INSUFFICIENT_BALANCE",
          message: `Insufficient balance. Requested ${dto.daysRequested}d but effective balance is ${effectiveBalance}d.`,
          hcmBalance: balance.hcmBalance,
          activeReservationDays: activeReservations,
          effectiveBalance,
          requestedDays: dto.daysRequested,
        });
      }

      // Step 3: INSERT time_off_requests.
      const request = manager.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        daysRequested: dto.daysRequested,
        startDate: dto.startDate,
        endDate: dto.endDate,
        leaveType: dto.leaveType,
        status: RequestStatus.PENDING,
        submittedBy: dto.submittedBy,
        idempotencyKey,
        balanceSnapshot: effectiveBalance,
        // Nullable fields left as null until manager reviews:
        reviewedBy: null,
        rejectionReason: null,
        hcmReferenceId: null,
        hcmErrorMessage: null,
      });

      const savedRequest = await manager.save(TimeOffRequest, request);

      // Step 4: Append RESERVATION_CREATED to the ledger.
      // delta is NEGATIVE — this is a debit against the balance.
      const ledgerRow = manager.create(BalanceLedger, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        delta: -dto.daysRequested,
        eventType: LedgerEventType.RESERVATION_CREATED,
        referenceId: savedRequest.id,
        notes: `${dto.daysRequested}d ${dto.leaveType} reserved by ${dto.submittedBy} (${dto.startDate} → ${dto.endDate})`,
      });

      await manager.save(BalanceLedger, ledgerRow);

      return {
        request: savedRequest,
        effectiveBalanceAfterReservation:
          Math.round((effectiveBalance - dto.daysRequested) * 100) / 100,
      };
    });

    this.logger.log(
      `Request ${result.request.id} PENDING — ` +
        `${dto.daysRequested}d for employee ${dto.employeeId} ` +
        `(balance after reservation: ${result.effectiveBalanceAfterReservation}d)`,
    );

    return {
      requestId: result.request.id,
      status: RequestStatus.PENDING,
      employeeId: result.request.employeeId,
      locationId: result.request.locationId,
      daysRequested: result.request.daysRequested,
      startDate: result.request.startDate,
      endDate: result.request.endDate,
      leaveType: result.request.leaveType,
      submittedAt: result.request.createdAt.toISOString(),
      effectiveBalanceAfterReservation: result.effectiveBalanceAfterReservation,
    };
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  /**
   * Approves a PENDING request and writes an APPLY outbox event atomically.
   *
   * CORRECTNESS NOTE (per review):
   * We do NOT re-validate the effective balance here. The days were already
   * deducted from the effective balance when the request was created as PENDING.
   * Re-checking would see effectiveBalance=0 for a perfectly valid full-balance
   * request and falsely block the approval. The HCM is the final arbiter of
   * balance sufficiency — the outbox worker handles any discrepancy after the
   * fact, transitioning to HCM_FAILED if HCM rejects.
   *
   * TRANSACTION CONTENTS (single BEGIN/COMMIT):
   *   1. Re-load the request with a write lock (concurrent-session guard).
   *   2. Re-check status === PENDING inside transaction.
   *   3. UPDATE time_off_requests → APPROVED.
   *   4. INSERT outbox_events (APPLY) — same transaction, same commit.
   *
   * The atomic write to both tables is the guarantee that no approval is
   * ever lost to a process crash: if the service restarts, the outbox worker
   * finds the PENDING outbox event and retries the HCM call.
   */
  async approveRequest(
    requestId: string,
    dto: ApproveRequestDto,
  ): Promise<ApproveResponsePayload> {
    // ── Pre-transaction read (fast-fail on obvious invalid states) ─────────
    const requestSnapshot = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    if (!requestSnapshot) {
      throw new NotFoundException(`Request ${requestId} not found.`);
    }

    if (!APPROVABLE_STATUSES.has(requestSnapshot.status)) {
      throw new ConflictException({
        error: "INVALID_STATUS_TRANSITION",
        message: `Request ${requestId} cannot be approved. Current status: ${requestSnapshot.status}.`,
        currentStatus: requestSnapshot.status,
        allowedFromStatuses: [...APPROVABLE_STATUSES],
      });
    }

    // ── Atomic transaction ─────────────────────────────────────────────────
    const result = await this.dataSource.transaction(async (manager) => {
      // Step 1: Re-load inside the transaction with a write lock.
      // In SQLite WAL mode, any write inside a transaction implicitly acquires
      // the WAL write lock. Two concurrent approvals for the same request will
      // be serialised; the second will see status = APPROVED and throw 409.
      const request = await manager.findOne(TimeOffRequest, {
        where: { id: requestId },
        lock: { mode: "pessimistic_write" },
      });

      if (!request) {
        throw new NotFoundException(`Request ${requestId} not found.`);
      }

      // Step 2: Re-check status INSIDE transaction — concurrent-session guard.
      if (request.status !== RequestStatus.PENDING) {
        throw new ConflictException({
          error: "CONCURRENT_STATUS_CHANGE",
          message:
            `Request ${requestId} status changed to ${request.status} ` +
            `while this approval was being processed.`,
          currentStatus: request.status,
        });
      }

      // Step 3: UPDATE status → APPROVED.
      request.status = RequestStatus.APPROVED;
      request.reviewedBy = dto.reviewedBy;
      const savedRequest = await manager.save(TimeOffRequest, request);

      // Step 4: INSERT outbox event — SAME transaction, same BEGIN/COMMIT.
      //
      // This INSERT is the durable record of intent to call HCM.
      // If the process crashes after COMMIT but before the worker fires,
      // the worker finds this row on restart and retries.
      //
      // idempotency_key format: "{requestId}:APPLY:1"
      //   - requestId: ties the outbox event back to the parent request
      //   - APPLY: the operation type (distinguishes from COMPENSATING_CREDIT)
      //   - :1: version suffix, allowing manual re-creation with :2 if needed
      //         without colliding with the original HCM idempotency key
      const outboxPayload = {
        employeeId: request.employeeId,
        locationId: request.locationId,
        daysRequested: request.daysRequested,
        leaveType: request.leaveType,
        startDate: request.startDate,
        endDate: request.endDate,
        referenceId: request.id,
      };

      const outboxEvent = manager.create(OutboxEvent, {
        requestId: request.id,
        eventType: OutboxEventType.APPLY,
        payload: JSON.stringify(outboxPayload),
        idempotencyKey: `${request.id}:APPLY:1`,
        status: OutboxStatus.PENDING,
        attemptCount: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(), // immediately eligible for the worker
      });

      const savedOutbox = await manager.save(OutboxEvent, outboxEvent);

      return { request: savedRequest, outboxEvent: savedOutbox };
    });

    this.logger.log(
      `Request ${requestId} APPROVED by ${dto.reviewedBy}. ` +
        `Outbox event ${result.outboxEvent.id} queued for HCM.`,
    );

    return {
      requestId: result.request.id,
      status: RequestStatus.APPROVED,
      reviewedBy: dto.reviewedBy,
      reviewedAt: result.request.updatedAt.toISOString(),
      outboxEventId: result.outboxEvent.id,
      message:
        "Request approved. HCM deduction has been queued and will be processed shortly.",
    };
  }

  // ── Reject ─────────────────────────────────────────────────────────────────

  /**
   * Rejects a PENDING request and releases the reservation.
   *
   * No HCM call is made — rejection is a local workflow event.
   * The effective balance "restores" automatically because REJECTED requests
   * are excluded from the active-reservation SUM. The ledger row is the
   * audit proof that the reservation was intentionally released.
   *
   * TRANSACTION CONTENTS (single BEGIN/COMMIT):
   *   1. Re-load with write lock + re-check status inside transaction.
   *   2. UPDATE time_off_requests → REJECTED.
   *   3. INSERT balance_ledger (RESERVATION_RELEASED, positive delta).
   */
  async rejectRequest(
    requestId: string,
    dto: RejectRequestDto,
  ): Promise<RejectResponsePayload> {
    // ── Pre-transaction fast-fail ──────────────────────────────────────────
    const requestSnapshot = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    if (!requestSnapshot) {
      throw new NotFoundException(`Request ${requestId} not found.`);
    }

    if (!REJECTABLE_STATUSES.has(requestSnapshot.status)) {
      // Provide actionable guidance per status.
      const guidance = this.getRejectionBlockedGuidance(requestSnapshot.status);
      throw new ConflictException({
        error: "INVALID_STATUS_TRANSITION",
        message: `Request ${requestId} cannot be rejected. Current status: ${requestSnapshot.status}. ${guidance}`,
        currentStatus: requestSnapshot.status,
      });
    }

    // ── Atomic transaction ─────────────────────────────────────────────────
    const result = await this.dataSource.transaction(async (manager) => {
      // Re-load with write lock inside the transaction.
      const request = await manager.findOne(TimeOffRequest, {
        where: { id: requestId },
        lock: { mode: "pessimistic_write" },
      });

      if (!request) {
        throw new NotFoundException(`Request ${requestId} not found.`);
      }

      // Re-check inside transaction — concurrent approve/reject guard.
      if (!REJECTABLE_STATUSES.has(request.status)) {
        throw new ConflictException({
          error: "CONCURRENT_STATUS_CHANGE",
          message:
            `Request ${requestId} status changed to ${request.status} ` +
            `while this rejection was being processed.`,
          currentStatus: request.status,
        });
      }

      // UPDATE status → REJECTED.
      request.status = RequestStatus.REJECTED;
      request.reviewedBy = dto.reviewedBy;
      request.rejectionReason = dto.rejectionReason;
      const savedRequest = await manager.save(TimeOffRequest, request);

      // INSERT ledger row — positive delta (credit back to effective balance).
      // Note: we do NOT touch time_off_balances.hcm_balance. The effective
      // balance improves automatically because this request no longer appears
      // in the active-reservations SUM once status = REJECTED.
      const ledgerRow = manager.create(BalanceLedger, {
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta: +request.daysRequested, // positive = credit back
        eventType: LedgerEventType.RESERVATION_RELEASED,
        referenceId: request.id,
        notes: `Reservation released — rejected by ${dto.reviewedBy}: "${dto.rejectionReason}"`,
      });

      await manager.save(BalanceLedger, ledgerRow);

      return savedRequest;
    });

    this.logger.log(
      `Request ${requestId} REJECTED by ${dto.reviewedBy}: "${dto.rejectionReason}"`,
    );

    return {
      requestId: result.id,
      status: RequestStatus.REJECTED,
      reviewedBy: dto.reviewedBy,
      rejectionReason: dto.rejectionReason,
      reviewedAt: result.updatedAt.toISOString(),
      message: "Request rejected. The reserved balance has been released.",
    };
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  /**
   * Cancels a request. Behaviour depends on current status:
   *
   *  PENDING / APPROVED:
   *    Simple cancellation. No HCM call has been made yet (or the outbox
   *    event has not been picked up). Release the local reservation.
   *    The outbox event (if any) is soft-cancelled by updating the request
   *    status — the outbox worker skips events whose parent request is CANCELLED.
   *
   *  HCM_PENDING:
   *    The outbox worker may be mid-flight. We mark the request CANCELLED.
   *    The worker detects the CANCELLED status and stops retrying. A
   *    compensating credit is NOT automatically queued here because we don't
   *    know if HCM applied the deduction. Ops must confirm and manually trigger
   *    a compensating credit if needed. This is surfaced in the response.
   *
   *  FINALIZED:
   *    HCM has confirmed the deduction. A COMPENSATING_CREDIT outbox event
   *    is written atomically — same pattern as approval. The worker will call
   *    POST /api/timeoff/reverse on HCM.
   */
  async cancelRequest(
    requestId: string,
    dto: CancelRequestDto,
  ): Promise<CancelResponsePayload> {
    const requestSnapshot = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    if (!requestSnapshot) {
      throw new NotFoundException(`Request ${requestId} not found.`);
    }

    if (!CANCELLABLE_STATUSES.has(requestSnapshot.status)) {
      throw new ConflictException({
        error: "INVALID_STATUS_TRANSITION",
        message: `Request ${requestId} cannot be cancelled. Current status: ${requestSnapshot.status}.`,
        currentStatus: requestSnapshot.status,
      });
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(TimeOffRequest, {
        where: { id: requestId },
        lock: { mode: "pessimistic_write" },
      });

      if (!request)
        throw new NotFoundException(`Request ${requestId} not found.`);

      if (!CANCELLABLE_STATUSES.has(request.status)) {
        throw new ConflictException({
          error: "CONCURRENT_STATUS_CHANGE",
          message: `Request ${requestId} status changed to ${request.status} during cancellation.`,
        });
      }

      const previousStatus = request.status;
      request.status = RequestStatus.REJECTED; // Reuse REJECTED as our cancelled terminal state

      // For FINALIZED: write a compensating credit outbox event.
      let compensatingCreditQueued = false;
      let opsWarning: string | undefined;

      if (previousStatus === RequestStatus.FINALIZED) {
        if (!request.hcmReferenceId) {
          // Should never happen on a FINALIZED request, but guard defensively.
          throw new ConflictException(
            `Request ${requestId} is FINALIZED but has no hcm_reference_id. ` +
              "Cannot issue compensating credit — manual ops intervention required.",
          );
        }

        const reversalPayload = {
          originalConfirmationId: request.hcmReferenceId,
          employeeId: request.employeeId,
          locationId: request.locationId,
          daysToCredit: request.daysRequested,
          reason: `Employee cancellation by ${dto.cancelledBy}`,
        };

        const compensatingEvent = manager.create(OutboxEvent, {
          requestId: request.id,
          eventType: OutboxEventType.COMPENSATING_CREDIT,
          payload: JSON.stringify(reversalPayload),
          idempotencyKey: `${request.id}:COMPENSATING_CREDIT:1`,
          status: OutboxStatus.PENDING,
          nextAttemptAt: new Date(),
        });

        await manager.save(OutboxEvent, compensatingEvent);
        compensatingCreditQueued = true;

        // Ledger: record the compensating credit intent.
        // The actual hcm_balance update happens in the outbox worker after HCM confirms.
        const ledgerRow = manager.create(BalanceLedger, {
          employeeId: request.employeeId,
          locationId: request.locationId,
          delta: +request.daysRequested,
          eventType: LedgerEventType.COMPENSATING_CREDIT,
          referenceId: request.id,
          notes: `Compensating credit queued for FINALIZED request. HCM ref: ${request.hcmReferenceId}`,
        });
        await manager.save(BalanceLedger, ledgerRow);
      } else if (previousStatus === RequestStatus.HCM_PENDING) {
        // Outbox worker may be mid-flight. We cannot guarantee the HCM call
        // won't succeed after we mark this CANCELLED. Surface an ops warning.
        opsWarning =
          "This request was in HCM_PENDING state. The outbox worker may have already " +
          "submitted the deduction to HCM. An ops check is required to confirm whether " +
          "a compensating credit must be manually issued.";
      } else {
        // PENDING or APPROVED: release the reservation via ledger.
        const ledgerRow = manager.create(BalanceLedger, {
          employeeId: request.employeeId,
          locationId: request.locationId,
          delta: +request.daysRequested,
          eventType: LedgerEventType.RESERVATION_RELEASED,
          referenceId: request.id,
          notes: `Reservation released — cancelled by ${dto.cancelledBy}`,
        });
        await manager.save(BalanceLedger, ledgerRow);
      }

      const savedRequest = await manager.save(TimeOffRequest, request);

      return { request: savedRequest, compensatingCreditQueued, opsWarning };
    });

    this.logger.log(`Request ${requestId} CANCELLED by ${dto.cancelledBy}.`);

    return {
      requestId: result.request.id,
      status: RequestStatus.REJECTED,
      cancelledBy: dto.cancelledBy,
      compensatingCreditQueued: result.compensatingCreditQueued,
      ...(result.opsWarning ? { opsWarning: result.opsWarning } : {}),
      message: result.compensatingCreditQueued
        ? "Request cancelled. A compensating HCM credit has been queued for async processing."
        : "Request cancelled. The reserved balance has been released.",
    };
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async getRequest(requestId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found.`);
    }

    return request;
  }

  async listRequests(
    employeeId: string,
    status?: string,
    page = 1,
    limit = 20,
  ): Promise<{
    data: TimeOffRequest[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.requestRepo
      .createQueryBuilder("r")
      .where("r.employeeId = :employeeId", { employeeId })
      .orderBy("r.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    if (status) {
      qb.andWhere("r.status = :status", { status });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Sums the reserved days for active requests inside an existing transaction.
   * Uses COALESCE to return 0 (not null) when no active requests exist.
   */
  private async sumActiveReservations(
    manager: EntityManager,
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder(TimeOffRequest, "r")
      .select("COALESCE(SUM(r.daysRequested), 0)", "total")
      .where("r.employeeId = :employeeId", { employeeId })
      .andWhere("r.locationId = :locationId", { locationId })
      .andWhere("r.status IN (:...statuses)", {
        statuses: ACTIVE_RESERVATION_STATUSES,
      })
      .getRawOne<{ total: string }>();

    return parseFloat(result?.total ?? "0");
  }

  /** Returns a human-readable explanation for why rejection is blocked. */
  private getRejectionBlockedGuidance(status: RequestStatus): string {
    switch (status) {
      case RequestStatus.APPROVED:
        return "The request has already been approved and an HCM call is queued. Use the cancel endpoint instead.";
      case RequestStatus.HCM_PENDING:
        return "The HCM submission is in-flight. Use the cancel endpoint after the request reaches FINALIZED or HCM_FAILED.";
      case RequestStatus.FINALIZED:
        return "The HCM deduction has been confirmed. Use the cancel endpoint to issue a compensating credit.";
      case RequestStatus.REJECTED:
        return "The request is already rejected.";
      case RequestStatus.HCM_FAILED:
        return "The request is in a terminal failure state. Ops intervention is required.";
      default:
        return "";
    }
  }
}

// ── Response payload shapes ─────────────────────────────────────────────────
// Defined here (co-located with the service) to keep the controller thin.

export interface SubmitResponsePayload {
  requestId: string;
  status: RequestStatus;
  employeeId: string;
  locationId: string;
  daysRequested: number;
  startDate: string;
  endDate: string;
  leaveType: string;
  submittedAt: string;
  effectiveBalanceAfterReservation: number;
}

export interface ApproveResponsePayload {
  requestId: string;
  status: RequestStatus;
  reviewedBy: string;
  reviewedAt: string;
  outboxEventId: string;
  message: string;
}

export interface RejectResponsePayload {
  requestId: string;
  status: RequestStatus;
  reviewedBy: string;
  rejectionReason: string;
  reviewedAt: string;
  message: string;
}

export interface CancelResponsePayload {
  requestId: string;
  status: RequestStatus;
  cancelledBy: string;
  compensatingCreditQueued: boolean;
  opsWarning?: string;
  message: string;
}
