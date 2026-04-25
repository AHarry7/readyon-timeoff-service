import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, LessThanOrEqual } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";

import { OutboxEvent } from "src/database/entities";
import { TimeOffRequest } from "src/database/entities";
import { TimeOffBalance } from "src/database/entities";
import { BalanceLedger } from "src/database/entities";
import {
  OutboxStatus,
  OutboxEventType,
  RequestStatus,
  LedgerEventType,
} from "../common/enums";

import { HcmClientService } from "../hcm-client/hcm-client.service";
import { BalancesService } from "../modules/balances/balances.service";
import {
  ApplyDeductionPayload,
  HcmDeductionData,
  HcmReversalData,
  ReverseDeductionPayload,
} from "src/hcm-client/hcm-result.type";

/**
 * Maximum number of outbox events to process per cron tick.
 * Keeps each tick bounded in duration; remaining events are processed
 * on the next tick. Low enough to avoid overwhelming HCM with bursts.
 */
const BATCH_SIZE = 10;

/**
 * Error types that are transient — the event should be retried with backoff.
 * DOMAIN_ERROR is NOT here — it is terminal; retrying won't help.
 */
const TRANSIENT_ERROR_TYPES = new Set([
  "TIMEOUT",
  "SERVER_ERROR",
  "NETWORK_ERROR",
]);

/**
 * OutboxWorkerService
 *
 * The asynchronous engine that drives all HCM communication.
 * It polls the `outbox_events` table every 30 seconds, claims events
 * atomically, dispatches the appropriate HCM call, and commits the
 * resulting state changes in a single SQLite transaction.
 *
 * ── POLLING & CLAIMING ────────────────────────────────────────────────────
 * Events are fetched WHERE status='PENDING' AND next_attempt_at <= now().
 * Each event is then claimed via an atomic UPDATE...WHERE status='PENDING'
 * that transitions it to 'PROCESSING'. This is the concurrency guard: if
 * two worker instances ever run simultaneously (future scaling), only one
 * can claim a given event because SQLite serialises writes.
 * If 0 rows are affected by the claim UPDATE, the event was already claimed
 * by another worker — we skip it silently.
 *
 * ── PARENT REQUEST GUARD ─────────────────────────────────────────────────
 * Before calling HCM, the worker re-reads the parent request's current status.
 * If the request was CANCELLED while the event was PENDING (e.g. the employee
 * hit cancel between approval and the next worker tick), the HCM call is
 * skipped and the event is marked PROCESSED with a skip note. This prevents
 * deducting days for a request the employee has already rescinded.
 *
 * ── SUCCESS PATH (APPLY) ─────────────────────────────────────────────────
 * All four state changes below are committed in a SINGLE transaction:
 *   1. outbox_events  → status = PROCESSED
 *   2. time_off_requests → status = FINALIZED, hcm_reference_id = <HCM id>
 *   3. time_off_balances → hcm_balance = HCM's confirmed remainingBalance
 *      (We use HCM's remainingBalance rather than computing hcm_balance - days
 *       because HCM is the source of truth; this self-corrects any local drift.)
 *   4. balance_ledger → RESERVATION_FINALIZED entry
 *
 * ── TRANSIENT FAILURE PATH ───────────────────────────────────────────────
 * TIMEOUT / SERVER_ERROR / NETWORK_ERROR → retry with exponential backoff:
 *   next_attempt_at = now() + min(2^attemptCount, 30) minutes
 * If attempt_count reaches max_attempts → escalate to terminal failure.
 *
 * ── TERMINAL FAILURE PATH ────────────────────────────────────────────────
 * DOMAIN_ERROR (4xx) or exhausted retries:
 *   outbox_events  → status = FAILED
 *   time_off_requests → status = HCM_FAILED, hcm_error_message = <detail>
 * The reservation remains held (status is HCM_FAILED, not REJECTED) so ops
 * can inspect and decide whether to manually retry or release the balance.
 * BalancesService.forceSync() is called to reconcile the local balance cache
 * with HCM's actual state after a domain error.
 *
 * ── COMPENSATING CREDIT PATH ────────────────────────────────────────────
 * COMPENSATING_CREDIT events (raised when a FINALIZED request is cancelled)
 * call POST /api/timeoff/reverse on HCM. On success:
 *   outbox_events  → status = PROCESSED
 *   time_off_balances → hcm_balance += creditedDays (using HCM's newBalance)
 *   balance_ledger → COMPENSATING_CREDIT confirmed
 */
@Injectable()
export class OutboxWorkerService {
  private readonly logger = new Logger(OutboxWorkerService.name);

  /** Guards against overlapping ticks if an iteration runs longer than 30s. */
  private isProcessing = false;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,

    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,

    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly hcmClient: HcmClientService,
    private readonly balancesService: BalancesService,
  ) {}

  // ── Cron entry point ────────────────────────────────────────────────────────

  /**
   * Main polling loop. Runs every 30 seconds.
   * Processes up to BATCH_SIZE events per tick, sequentially.
   * Sequential processing (not Promise.all) keeps SQLite write contention low.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async processPendingEvents(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug("Skipping tick — previous batch still processing.");
      return;
    }

    this.isProcessing = true;

    try {
      const events = await this.fetchEligibleEvents();

      if (events.length === 0) return;

      this.logger.log(`[OutboxWorker] Processing ${events.length} event(s).`);

      for (const event of events) {
        await this.processOneEvent(event);
      }
    } catch (err) {
      // An error here means the fetch query itself failed (DB unavailable).
      // Log and release the lock so the next tick can try again.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OutboxWorker] Fatal tick error: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────

  /**
   * Selects events eligible for processing:
   *  - status = 'PENDING'  (not already claimed or finished)
   *  - next_attempt_at <= now()  (backoff has elapsed)
   * Ordered by next_attempt_at ASC so older/high-priority events are
   * processed before freshly-scheduled retries.
   */
  private async fetchEligibleEvents(): Promise<OutboxEvent[]> {
    return this.outboxRepo.find({
      where: {
        status: OutboxStatus.PENDING,
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
      order: { nextAttemptAt: "ASC" },
      take: BATCH_SIZE,
    });
  }

  // ── Claim & dispatch ────────────────────────────────────────────────────────

  /**
   * Processes a single outbox event end-to-end.
   * Each step is designed so that a crash at any point leaves the DB in a
   * state the next tick can safely recover from.
   */
  private async processOneEvent(event: OutboxEvent): Promise<void> {
    // ── Step 1: Atomic claim ──────────────────────────────────────────────
    const claimed = await this.claimEvent(event);
    if (!claimed) {
      // Another worker claimed it first — skip silently.
      return;
    }

    this.logger.debug(
      `[OutboxWorker] Claimed event ${event.id} (${event.eventType}, attempt #${event.attemptCount + 1})`,
    );

    // ── Step 2: Parent request guard ──────────────────────────────────────
    const request = await this.requestRepo.findOne({
      where: { id: event.requestId },
    });

    if (!request) {
      // The parent request was deleted (should never happen with FK ON DELETE CASCADE,
      // but guard defensively).
      this.logger.warn(
        `[OutboxWorker] Event ${event.id} references missing request ${event.requestId}. Marking FAILED.`,
      );
      await this.markFailed(
        event,
        "Parent request not found.",
        null /* no request to update */,
      );
      return;
    }

    // If the request was cancelled after approval, skip the HCM call and
    // clean up the outbox event without touching HCM.
    if (this.isRequestCancelled(request)) {
      this.logger.log(
        `[OutboxWorker] Event ${event.id} skipped — request ${request.id} was ` +
          `cancelled (status: ${request.status}).`,
      );
      await this.markProcessed(
        event,
        null,
        '{"skipped": "request was cancelled"}',
      );
      return;
    }

    // ── Step 3: Dispatch to type-specific handler ─────────────────────────
    switch (event.eventType) {
      case OutboxEventType.APPLY:
        await this.handleApply(event, request);
        break;

      case OutboxEventType.COMPENSATING_CREDIT:
        await this.handleCompensatingCredit(event, request);
        break;

      case OutboxEventType.CANCEL:
        // CANCEL events represent pre-HCM cancellations that don't require
        // an HCM call. The reservation was released by cancelRequest().
        // We simply mark the event processed.
        this.logger.log(
          `[OutboxWorker] Event ${event.id} CANCEL — no HCM call needed.`,
        );
        await this.markProcessed(
          event,
          null,
          '{"skipped": "pre-hcm cancellation"}',
        );
        break;

      default:
        this.logger.error(
          `[OutboxWorker] Unknown event type: ${(event as OutboxEvent).eventType}`,
        );
        await this.markFailed(
          event,
          `Unknown event type: ${event.eventType}`,
          request,
        );
    }
  }

  // ── APPLY handler ───────────────────────────────────────────────────────────

  /**
   * Handles an APPLY outbox event by calling POST /api/timeoff/apply on HCM.
   *
   * On success: atomically commits all four state changes (outbox, request,
   * balance, ledger) in a single SQLite transaction.
   *
   * On transient failure: resets to PENDING with exponential backoff.
   *
   * On terminal failure (DOMAIN_ERROR or exhausted retries): marks FAILED
   * and transitions the request to HCM_FAILED. Triggers a forceSync() on
   * the balance to reconcile the local cache with HCM's actual state.
   */
  private async handleApply(
    event: OutboxEvent,
    request: TimeOffRequest,
  ): Promise<void> {
    const payload = JSON.parse(event.payload) as ApplyDeductionPayload;

    const hcmResult = await this.hcmClient.applyDeduction(
      payload,
      event.idempotencyKey,
    );

    if (hcmResult.success) {
      this.logger.log(
        `[OutboxWorker] HCM confirmed APPLY for request ${request.id}. ` +
          `HCM ref: ${hcmResult.data.confirmationId}. ` +
          `Remaining balance: ${hcmResult.data.remainingBalance}d`,
      );
      await this.commitApplySuccess(event, request, hcmResult.data);
      return;
    }

    // ── Failure handling ──────────────────────────────────────────────────
    const isTransient = TRANSIENT_ERROR_TYPES.has(hcmResult.errorType);
    const nextAttemptCount = event.attemptCount + 1;
    const isExhausted = nextAttemptCount >= event.maxAttempts;

    if (isTransient && !isExhausted) {
      const delayMinutes = Math.min(Math.pow(2, nextAttemptCount), 30);
      this.logger.warn(
        `[OutboxWorker] Transient HCM failure for event ${event.id} ` +
          `[${hcmResult.errorType}]: "${hcmResult.errorMessage}". ` +
          `Retry #${nextAttemptCount} in ${delayMinutes}m.`,
      );
      await this.scheduleRetry(
        event,
        hcmResult.rawResponse ?? hcmResult.errorMessage,
      );
      return;
    }

    // Terminal: DOMAIN_ERROR or retries exhausted.
    const reason = isExhausted
      ? `Exhausted ${event.maxAttempts} attempts. Last error [${hcmResult.errorType}]: ${hcmResult.errorMessage}`
      : `HCM domain error [${hcmResult.errorType}]: ${hcmResult.errorMessage}`;

    this.logger.error(
      `[OutboxWorker] Terminal failure for event ${event.id} on request ${request.id}: ${reason}`,
    );

    await this.markFailed(event, reason, request, hcmResult.rawResponse);

    // Trigger a balance reconciliation after a domain error — HCM may have a
    // different balance than our local cache (e.g. another system deducted first).
    if (hcmResult.errorType === "DOMAIN_ERROR") {
      this.reconcileBalanceAsync(request.employeeId, request.locationId);
    }
  }

  // ── COMPENSATING_CREDIT handler ─────────────────────────────────────────────

  /**
   * Handles a COMPENSATING_CREDIT outbox event by calling POST /api/timeoff/reverse.
   * This is raised when a FINALIZED request is cancelled by the employee.
   *
   * On success: uses HCM's confirmed `newBalance` to update hcm_balance,
   * which self-corrects any local drift accumulated since the original deduction.
   */
  private async handleCompensatingCredit(
    event: OutboxEvent,
    request: TimeOffRequest,
  ): Promise<void> {
    const payload = JSON.parse(event.payload) as ReverseDeductionPayload;

    const hcmResult = await this.hcmClient.reverseDeduction(
      payload,
      event.idempotencyKey,
    );

    if (hcmResult.success) {
      this.logger.log(
        `[OutboxWorker] HCM confirmed COMPENSATING_CREDIT for request ${request.id}. ` +
          `HCM reversal ref: ${hcmResult.data.reversalConfirmationId}. ` +
          `New balance: ${hcmResult.data.newBalance}d`,
      );
      await this.commitCompensatingCreditSuccess(
        event,
        request,
        hcmResult.data,
      );
      return;
    }

    const isTransient = TRANSIENT_ERROR_TYPES.has(hcmResult.errorType);
    const nextAttemptCount = event.attemptCount + 1;
    const isExhausted = nextAttemptCount >= event.maxAttempts;

    if (isTransient && !isExhausted) {
      const delayMinutes = Math.min(Math.pow(2, nextAttemptCount), 30);
      this.logger.warn(
        `[OutboxWorker] Transient failure on COMPENSATING_CREDIT event ${event.id}: ` +
          `"${hcmResult.errorMessage}". Retry in ${delayMinutes}m.`,
      );
      await this.scheduleRetry(
        event,
        hcmResult.rawResponse ?? hcmResult.errorMessage,
      );
      return;
    }

    const reason = isExhausted
      ? `Exhausted ${event.maxAttempts} attempts on COMPENSATING_CREDIT.`
      : `HCM rejected COMPENSATING_CREDIT [${hcmResult.errorType}]: ${hcmResult.errorMessage}`;

    this.logger.error(
      `[OutboxWorker] COMPENSATING_CREDIT failed for event ${event.id}: ${reason}. ` +
        "Manual ops intervention required to issue the credit directly in HCM.",
    );

    // Mark the event FAILED. We do NOT update the request status here —
    // the request is already REJECTED (cancelled). Ops must apply the
    // credit in HCM manually and then call forceSync to update local balance.
    await this.outboxRepo.update(
      { id: event.id },
      {
        status: OutboxStatus.FAILED,
        hcmResponse: hcmResult.rawResponse ?? hcmResult.errorMessage,
        updatedAt: new Date(),
      },
    );
  }

  // ── Transactional success commits ────────────────────────────────────────────

  /**
   * Commits all four state changes for a successful APPLY event atomically.
   *
   * WHY ALL FOUR IN ONE TRANSACTION?
   * If we committed them separately and crashed between steps, the DB would
   * be in a partially updated state:
   *   - Outbox PROCESSED but request still APPROVED → worker would re-fire
   *   - Request FINALIZED but balance not updated → effective balance wrong
   * A single COMMIT eliminates all partial-update failure modes.
   */
  private async commitApplySuccess(
    event: OutboxEvent,
    request: TimeOffRequest,
    hcmData: HcmDeductionData,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // 1. Mark outbox event PROCESSED.
      await manager.update(
        OutboxEvent,
        { id: event.id },
        {
          status: OutboxStatus.PROCESSED,
          hcmResponse: JSON.stringify(hcmData),
          updatedAt: new Date(),
        },
      );

      // 2. Transition request to FINALIZED, store HCM's reference ID.
      await manager.update(
        TimeOffRequest,
        { id: request.id },
        {
          status: RequestStatus.FINALIZED,
          hcmReferenceId: hcmData.confirmationId,
          updatedAt: new Date(),
        },
      );

      // 3. Update hcm_balance to HCM's confirmed remainingBalance.
      //
      // CRITICAL DESIGN CHOICE: we set hcm_balance = hcmData.remainingBalance
      // rather than hcm_balance = hcm_balance - deductedDays.
      //
      // Reason: HCM is the source of truth. Between our approval and this
      // confirmation, HCM may have received other mutations (work anniversary
      // credits, another system's deduction). Using HCM's returned balance
      // self-corrects all such drift in a single write, rather than compounding
      // any local error by doing arithmetic on a potentially stale local value.
      const balance = await manager.findOne(TimeOffBalance, {
        where: {
          employeeId: request.employeeId,
          locationId: request.locationId,
        },
      });

      const previousHcmBalance = balance?.hcmBalance ?? 0;

      if (balance) {
        await manager.update(
          TimeOffBalance,
          { employeeId: request.employeeId, locationId: request.locationId },
          {
            hcmBalance: hcmData.remainingBalance,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          },
        );
      }

      // 4. Append RESERVATION_FINALIZED to the ledger.
      // delta = new hcm_balance - old hcm_balance (will be negative — debit).
      const delta = hcmData.remainingBalance - previousHcmBalance;
      const ledgerRow = manager.create(BalanceLedger, {
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta,
        eventType: LedgerEventType.RESERVATION_FINALIZED,
        referenceId: request.id,
        notes:
          `HCM confirmed ${hcmData.deductedDays}d deduction. ` +
          `HCM remaining: ${hcmData.remainingBalance}d. ` +
          `HCM ref: ${hcmData.confirmationId}.`,
      });
      await manager.save(BalanceLedger, ledgerRow);
    });

    this.logger.log(
      `[OutboxWorker] Request ${request.id} FINALIZED. ` +
        `hcm_balance set to ${hcmData.remainingBalance}d (HCM confirmed).`,
    );
  }

  /**
   * Commits all state changes for a successful COMPENSATING_CREDIT event.
   * Uses HCM's `newBalance` to update hcm_balance, same self-correction
   * logic as commitApplySuccess.
   */
  private async commitCompensatingCreditSuccess(
    event: OutboxEvent,
    request: TimeOffRequest,
    hcmData: HcmReversalData,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // 1. Mark outbox event PROCESSED.
      await manager.update(
        OutboxEvent,
        { id: event.id },
        {
          status: OutboxStatus.PROCESSED,
          hcmResponse: JSON.stringify(hcmData),
          updatedAt: new Date(),
        },
      );

      // 2. Update hcm_balance to HCM's confirmed post-credit balance.
      const balance = await manager.findOne(TimeOffBalance, {
        where: {
          employeeId: request.employeeId,
          locationId: request.locationId,
        },
      });

      const previousHcmBalance = balance?.hcmBalance ?? 0;

      if (balance) {
        await manager.update(
          TimeOffBalance,
          { employeeId: request.employeeId, locationId: request.locationId },
          {
            hcmBalance: hcmData.newBalance,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          },
        );
      }

      // 3. Ledger entry for confirmed credit.
      const delta = hcmData.newBalance - previousHcmBalance; // positive
      const ledgerRow = manager.create(BalanceLedger, {
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta,
        eventType: LedgerEventType.COMPENSATING_CREDIT,
        referenceId: request.id,
        notes:
          `HCM confirmed compensating credit of ${hcmData.creditedDays}d. ` +
          `New HCM balance: ${hcmData.newBalance}d. ` +
          `HCM reversal ref: ${hcmData.reversalConfirmationId}.`,
      });
      await manager.save(BalanceLedger, ledgerRow);
    });

    this.logger.log(
      `[OutboxWorker] Compensating credit for request ${request.id} confirmed. ` +
        `hcm_balance set to ${hcmData.newBalance}d.`,
    );
  }

  // ── State mutation helpers ───────────────────────────────────────────────────

  /**
   * Atomically claims the event by transitioning PENDING → PROCESSING.
   * Returns true if the claim succeeded (this worker owns it).
   * Returns false if 0 rows were affected (another worker claimed it first).
   */
  private async claimEvent(event: OutboxEvent): Promise<boolean> {
    const result = await this.outboxRepo
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({
        status: OutboxStatus.PROCESSING,
        attemptCount: () => "attempt_count + 1",
        lastAttemptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id = :id AND status = :status", {
        id: event.id,
        status: OutboxStatus.PENDING,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Schedules a retry by resetting status to PENDING with a computed backoff.
   * Called after a transient HCM failure where retries remain available.
   */
  private async scheduleRetry(
    event: OutboxEvent,
    rawResponse: string | undefined,
  ): Promise<void> {
    // attempt_count was already incremented by claimEvent(). Use that value
    // to compute the next delay so the backoff series is 2^1, 2^2, 2^3…
    const delayMinutes = Math.min(Math.pow(2, event.attemptCount + 1), 30);
    const nextAttemptAt = new Date(Date.now() + delayMinutes * 60_000);

    await this.outboxRepo.update(
      { id: event.id },
      {
        status: OutboxStatus.PENDING,
        nextAttemptAt,
        hcmResponse: rawResponse,
        updatedAt: new Date(),
      },
    );
  }

  /**
   * Terminally fails an event and transitions the parent request to HCM_FAILED.
   * Both writes are in a single transaction — if the request update fails,
   * the outbox event stays in PROCESSING so the next tick can re-inspect.
   */
  private async markFailed(
    event: OutboxEvent,
    reason: string,
    request: TimeOffRequest | null,
    rawResponse?: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        OutboxEvent,
        { id: event.id },
        {
          status: OutboxStatus.FAILED,
          hcmResponse: rawResponse ?? reason,
          updatedAt: new Date(),
        },
      );

      if (request) {
        await manager.update(
          TimeOffRequest,
          { id: request.id },
          {
            status: RequestStatus.HCM_FAILED,
            hcmErrorMessage: reason,
            updatedAt: new Date(),
          },
        );
      }
    });

    this.logger.error(
      `[OutboxWorker] Event ${event.id} FAILED. ` +
        `Request ${request?.id ?? "N/A"} set to HCM_FAILED. Ops alert required.`,
    );
  }

  /**
   * Marks an event PROCESSED without an HCM call.
   * Used for skipped events (cancelled request, pre-HCM CANCEL type).
   */
  private async markProcessed(
    event: OutboxEvent,
    _request: TimeOffRequest | null,
    responseNote: string,
  ): Promise<void> {
    await this.outboxRepo.update(
      { id: event.id },
      {
        status: OutboxStatus.PROCESSED,
        hcmResponse: responseNote,
        updatedAt: new Date(),
      },
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Returns true for request statuses that indicate the request was withdrawn
   * before HCM was involved and the HCM call should therefore be skipped.
   *
   * REJECTED covers both manager-rejected and employee-cancelled pre-HCM paths
   * (our cancelRequest() service reuses REJECTED as the cancellation terminal).
   * HCM_FAILED is included because a previously-failed apply event should not
   * be re-attempted for a request already in a terminal failure state.
   */
  private isRequestCancelled(request: TimeOffRequest): boolean {
    return (
      request.status === RequestStatus.REJECTED ||
      request.status === RequestStatus.HCM_FAILED ||
      request.status === RequestStatus.FINALIZED // already finalised by a previous attempt
    );
  }

  /**
   * Fire-and-forget balance reconciliation after a DOMAIN_ERROR.
   * If HCM rejected our deduction citing insufficient balance, our local
   * hcm_balance is stale — another system deducted first. forceSync()
   * corrects this so the next effective-balance read is accurate.
   *
   * We do NOT await this call because reconciliation is best-effort and
   * should not block the worker's main loop or affect the event's final status.
   */
  private reconcileBalanceAsync(employeeId: string, locationId: string): void {
    this.balancesService
      .forceSync(employeeId, locationId)
      .then(() => {
        this.logger.log(
          `[OutboxWorker] Post-failure reconciliation succeeded for (${employeeId}, ${locationId}).`,
        );
      })
      .catch((err: Error) => {
        this.logger.warn(
          `[OutboxWorker] Post-failure reconciliation failed for (${employeeId}, ${locationId}): ` +
            err.message,
        );
      });
  }
}
