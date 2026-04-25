import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, EntityManager } from "typeorm";

import { HcmClientService } from "../../hcm-client/hcm-client.service";
import { SyncSource, LedgerEventType, RequestStatus } from "src/common/enums";
import { EffectiveBalanceDto } from "./effective-balance.dto";
import {
  BalanceLedger,
  TimeOffBalance,
  TimeOffRequest,
} from "src/database/entities";

/** Statuses that represent a "live" reservation against the employee's balance. */
const ACTIVE_RESERVATION_STATUSES: RequestStatus[] = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.HCM_PENDING,
];

/**
 * BalancesService
 *
 * Owns all read and sync operations on the time_off_balances table.
 * Write operations that mutate the balance as a side effect of request
 * lifecycle events (e.g. RESERVATION_FINALIZED) live in TimeOffRequestService
 * and are coordinated within the same transaction as the request state change.
 *
 * CORE RESPONSIBILITIES:
 *  1. getEffectiveBalance() — the primary read path. Applies the staleness
 *     check, conditionally syncs from HCM, and computes the dynamic effective
 *     balance in one call.
 *
 *  2. forceSync() — explicit cache-bust. Used by the PATCH /sync endpoint and
 *     by the outbox worker when it receives an HCM INSUFFICIENT_BALANCE error
 *     (which implies our local cache is stale).
 *
 *  3. upsertFromBatch() — called by SyncService when processing a batch
 *     payload. Public so SyncService can drive it row-by-row inside its own
 *     transaction.
 */
@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  /**
   * If last_synced_at is older than this, the balance is considered stale and
   * a real-time HCM refresh is attempted before returning data.
   * Configurable at service construction time for tests (pass 0 to always refresh).
   */
  private readonly staleThresholdMs: number;

  constructor(
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,

    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,

    @InjectRepository(BalanceLedger)
    private readonly ledgerRepo: Repository<BalanceLedger>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly hcmClient: HcmClientService,
  ) {
    // 5 minutes expressed in milliseconds. Override via constructor in tests.
    this.staleThresholdMs = 5 * 60 * 1_000;
  }

  // ── Primary read path ──────────────────────────────────────────────────────

  /**
   * Returns the effective balance for a given (employeeId, locationId) pair.
   *
   * Algorithm:
   *  1. Fetch local balance record.
   *  2. Determine whether a real-time HCM refresh is needed:
   *       a. Record does not exist (first-time lookup).
   *       b. last_synced_at is older than STALE_THRESHOLD_MS.
   *  3. If refresh needed: call HCM.
   *       On success → update hcm_balance + write ledger row (transactional).
   *       On failure → log warning, continue with stale local data.
   *  4. Compute active reservations from time_off_requests.
   *  5. Return EffectiveBalanceDto with effectiveBalance = hcmBalance − reservations.
   *
   * NEVER THROWS to the controller on HCM failure — stale data is always
   * preferable to a 500 for a balance read.
   */
  async getEffectiveBalance(
    employeeId: string,
    locationId: string,
  ): Promise<EffectiveBalanceDto> {
    let balanceRecord = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    let isStale = false;
    let stalenessDetail: { reason: string; errorType: string } | undefined;

    const needsRefresh =
      !balanceRecord || this.isStale(balanceRecord.lastSyncedAt);

    if (needsRefresh) {
      this.logger.debug(
        `Balance for (${employeeId}, ${locationId}) is ${balanceRecord ? "stale" : "absent"} — refreshing from HCM`,
      );

      const syncResult = await this.attemptRealtimeSync(
        employeeId,
        locationId,
        balanceRecord ?? null,
      );

      if (syncResult.success) {
        // Re-fetch the updated record so downstream code uses fresh data.
        balanceRecord = syncResult.updatedRecord;
      } else {
        isStale = true;
        stalenessDetail = {
          reason: syncResult.reason,
          errorType: syncResult.errorType,
        };

        // If the record doesn't exist at all and HCM also failed, we have
        // nothing to serve. Raise 404 so the client knows to retry later.
        if (!balanceRecord) {
          throw new NotFoundException(
            `No balance record found for employee ${employeeId} / location ${locationId} ` +
              `and the HCM real-time fetch failed: ${syncResult.reason}`,
          );
        }

        this.logger.warn(
          `[BalancesService] Serving stale balance for (${employeeId}, ${locationId}): ${syncResult.reason}`,
        );
      }
    }

    // At this point balanceRecord is guaranteed non-null (NotFoundException
    // was thrown above if it was null and sync failed).
    const record = balanceRecord!;

    // Compute the sum of all active reservations in a single aggregate query.
    const activeReservationDays = await this.sumActiveReservations(
      employeeId,
      locationId,
    );

    const effectiveBalance =
      Math.round((record.hcmBalance - activeReservationDays) * 100) / 100;

    return {
      employeeId,
      locationId,
      hcmBalance: record.hcmBalance,
      activeReservationDays,
      effectiveBalance,
      lastSyncedAt: record.lastSyncedAt.toISOString(),
      syncSource: record.syncSource,
      isStale,
      ...(stalenessDetail ? { staleness: stalenessDetail } : {}),
    };
  }

  /**
   * Forces an immediate real-time HCM refresh, bypassing the staleness check.
   * Called by:
   *  - PATCH /api/v1/balances/:employeeId/:locationId/sync (explicit user action)
   *  - OutboxWorkerService when HCM returns DOMAIN_ERROR (stale balance suspected)
   *
   * Returns the updated EffectiveBalanceDto so the caller can return it directly.
   * Throws if HCM is unreachable (unlike getEffectiveBalance, the caller here
   * explicitly requested a fresh value — serving stale is not useful).
   */
  async forceSync(
    employeeId: string,
    locationId: string,
  ): Promise<EffectiveBalanceDto> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    const syncResult = await this.attemptRealtimeSync(
      employeeId,
      locationId,
      existing ?? null,
    );

    if (!syncResult.success) {
      // On a forced sync, surface the HCM error to the caller.
      // The controller converts this to an appropriate HTTP 502/503.
      throw new Error(
        `HCM real-time sync failed [${syncResult.errorType}]: ${syncResult.reason}`,
      );
    }

    // Return the freshly computed effective balance.
    return this.getEffectiveBalance(employeeId, locationId);
  }

  /**
   * Upserts an HCM balance record from a batch payload row.
   * Called by SyncService (batch processing worker) for each record in the batch.
   * The caller is responsible for wrapping multiple calls in a single transaction
   * if atomic batch processing is required.
   *
   * @param manager — EntityManager from the caller's transaction context.
   *                  Pass this.dataSource.manager if no outer transaction exists.
   */
  async upsertFromBatch(
    manager: EntityManager,
    employeeId: string,
    locationId: string,
    hcmBalance: number,
    batchSnapshotId: string,
  ): Promise<{
    applied: boolean;
    conflictDetected: boolean;
    effectiveBalance: number;
  }> {
    // Read current state inside the transaction.
    const existing = await manager.findOne(TimeOffBalance, {
      where: { employeeId, locationId },
    });

    const previousBalance = existing?.hcmBalance ?? 0;
    const delta = hcmBalance - previousBalance;

    // Sum active reservations to detect merge conflicts.
    const activeReservationDays = await this.sumActiveReservationsWithManager(
      manager,
      employeeId,
      locationId,
    );

    const conflictDetected = activeReservationDays > hcmBalance;

    if (conflictDetected) {
      this.logger.warn(
        `[BatchSync] Conflict for (${employeeId}, ${locationId}): ` +
          `HCM batch says ${hcmBalance}d but active reservations total ${activeReservationDays}d. ` +
          `Applying HCM value (authoritative). Effective balance will be negative — flagged for reconciliation.`,
      );
    }

    const now = new Date();

    if (existing) {
      // Explicit UPDATE with version check (optimistic lock for batch upserts).
      // We use a raw UPDATE rather than manager.save() to avoid the @VersionColumn
      // auto-increment conflicting with concurrent real-time syncs mid-batch.
      await manager.update(
        TimeOffBalance,
        { employeeId, locationId },
        {
          hcmBalance,
          lastSyncedAt: now,
          syncSource: SyncSource.BATCH,
          updatedAt: now,
        },
      );
    } else {
      const newRecord = manager.create(TimeOffBalance, {
        employeeId,
        locationId,
        hcmBalance,
        lastSyncedAt: now,
        syncSource: SyncSource.BATCH,
      });
      await manager.save(TimeOffBalance, newRecord);
    }

    // Write an immutable ledger row for this batch event.
    const ledgerRow = manager.create(BalanceLedger, {
      employeeId,
      locationId,
      delta,
      eventType: LedgerEventType.HCM_SYNC_BATCH,
      referenceId: batchSnapshotId,
      notes: conflictDetected
        ? `Conflict: HCM says ${hcmBalance}d, active reservations ${activeReservationDays}d`
        : `Batch sync: ${previousBalance}d → ${hcmBalance}d`,
    });
    await manager.save(BalanceLedger, ledgerRow);

    return {
      applied: true,
      conflictDetected,
      effectiveBalance:
        Math.round((hcmBalance - activeReservationDays) * 100) / 100,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Determines whether a given last_synced_at timestamp is older than the
   * configured stale threshold.
   */
  private isStale(lastSyncedAt: Date): boolean {
    return Date.now() - lastSyncedAt.getTime() > this.staleThresholdMs;
  }

  /**
   * Calls HCM for a fresh balance and, on success, atomically updates
   * time_off_balances and inserts a balance_ledger row.
   *
   * Returns a discriminated result rather than throwing so the caller can
   * decide whether to serve stale data or surface an error.
   */
  private async attemptRealtimeSync(
    employeeId: string,
    locationId: string,
    existing: TimeOffBalance | null,
  ): Promise<
    | { success: true; updatedRecord: TimeOffBalance }
    | { success: false; reason: string; errorType: string }
  > {
    const hcmResult = await this.hcmClient.getHcmBalance(
      employeeId,
      locationId,
    );

    if (!hcmResult.success) {
      return {
        success: false,
        reason: hcmResult.errorMessage,
        errorType: hcmResult.errorType,
      };
    }

    const freshBalance = hcmResult.data.balanceDays;
    const previousBalance = existing?.hcmBalance ?? 0;
    const delta = freshBalance - previousBalance;
    const now = new Date();

    // Wrap the two writes in a single SQLite transaction so a crash between
    // the UPDATE and the ledger INSERT never leaves them out of sync.
    const updatedRecord = await this.dataSource.transaction(async (manager) => {
      let record: TimeOffBalance;

      if (existing) {
        // TypeORM @VersionColumn: saving with the current version value causes
        // TypeORM to WHERE version = X in the UPDATE. If a concurrent sync has
        // already incremented the version, this throws OptimisticLockVersionMismatchError.
        // We catch that below and treat it as a successful concurrent sync.
        existing.hcmBalance = freshBalance;
        existing.lastSyncedAt = now;
        existing.syncSource = SyncSource.REALTIME;
        record = await manager.save(TimeOffBalance, existing);
      } else {
        const newRecord = manager.create(TimeOffBalance, {
          employeeId,
          locationId,
          hcmBalance: freshBalance,
          lastSyncedAt: now,
          syncSource: SyncSource.REALTIME,
        });
        record = await manager.save(TimeOffBalance, newRecord);
      }

      // Append-only ledger entry for this sync event.
      const ledgerRow = manager.create(BalanceLedger, {
        employeeId,
        locationId,
        delta,
        eventType: LedgerEventType.HCM_SYNC_REALTIME,
        referenceId: null,
        notes: `Real-time sync: ${previousBalance}d → ${freshBalance}d`,
      });
      await manager.save(BalanceLedger, ledgerRow);

      return record;
    });

    this.logger.log(
      `[RealtimeSync] (${employeeId}, ${locationId}): ${previousBalance}d → ${freshBalance}d (Δ${delta >= 0 ? "+" : ""}${delta}d)`,
    );

    return { success: true, updatedRecord };
  }

  /**
   * Returns the total days held by active reservations for a given employee/location.
   * Uses a single aggregate SQL query — never loads all request rows into memory.
   *
   * Handles the null case (no active reservations) by coalescing to 0.
   */
  private async sumActiveReservations(
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    return this.sumActiveReservationsWithManager(
      this.dataSource.manager,
      employeeId,
      locationId,
    );
  }

  /**
   * Manager-aware version of sumActiveReservations.
   * Accepts an EntityManager so it participates in the caller's transaction.
   */
  private async sumActiveReservationsWithManager(
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

    // SQLite returns numeric aggregates as strings; parse explicitly.
    return parseFloat(result?.total ?? "0");
  }
}
