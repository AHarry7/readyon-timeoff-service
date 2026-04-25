import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  Unique,
  VersionColumn,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
  CreateDateColumn,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { SyncSource } from "src/common/enums";
import { TimeOffRequest } from "./time-off-request.entity";

/**
 * time_off_balances
 *
 * Stores the last HCM-confirmed base balance per (employee_id, location_id) pair.
 * This is the anchor for all effective-balance calculations:
 *
 *   effective_balance = hcm_balance
 *                     - SUM(days_requested WHERE status IN ('PENDING', 'APPROVED', 'HCM_PENDING'))
 *
 * The `version` column is an optimistic-lock counter managed by TypeORM.
 * Any concurrent UPDATE must supply the current version; a mismatch throws
 * OptimisticLockVersionMismatchError, which the service layer catches and retries.
 */
@Entity("time_off_balances")
@Unique("uq_tob_employee_location", ["employeeId", "locationId"])
@Index("idx_tob_employee", ["employeeId"])
export class TimeOffBalance {
  /**
   * Primary key.
   * We generate a UUID v4 in @BeforeInsert rather than relying on the SQLite
   * lower(hex(randomblob(16))) default, so TypeORM always has the ID available
   * in memory immediately after save() without an extra SELECT.
   */
  @PrimaryColumn({ type: "text" })
  id: string;

  @Column({ name: "employee_id", type: "text", nullable: false })
  employeeId: string;

  @Column({ name: "location_id", type: "text", nullable: false })
  locationId: string;

  /**
   * The last balance value confirmed by the HCM system.
   * Uses REAL to support half-day increments (e.g. 0.5).
   * This value is NEVER reduced by local reservations — it is the raw HCM figure.
   * All effective-balance arithmetic is done at query time.
   */
  @Column({ name: "hcm_balance", type: "real", nullable: false, default: 0 })
  hcmBalance: number;

  /**
   * ISO 8601 UTC timestamp of the last successful HCM sync for this record.
   * Used to surface staleness warnings to the UI (e.g. last synced > 24h ago).
   */
  @Column({ name: "last_synced_at", type: "datetime", nullable: false })
  lastSyncedAt: Date;

  /**
   * Indicates which mechanism last wrote hcm_balance.
   * Maps to the SQL CHECK constraint: 'REALTIME' | 'BATCH' | 'MANUAL'
   */
  @Column({
    name: "sync_source",
    type: "text",
    nullable: false,
    enum: SyncSource,
  })
  syncSource: SyncSource;

  /**
   * Optimistic lock counter. TypeORM increments this automatically on every
   * UPDATE. Concurrent writers that supply a stale version get an error rather
   * than silently overwriting each other's changes.
   *
   * Maps to: version INTEGER NOT NULL DEFAULT 1
   */
  @VersionColumn({ name: "version", default: 1 })
  version: number;

  @Column({
    name: "created_at",
    type: "datetime",
    nullable: false,
  })
  createdAt: Date;

  @Column({
    name: "updated_at",
    type: "datetime",
    nullable: false,
  })
  updatedAt: Date;

  // ── Relations ──────────────────────────────────────────────────────────────

  /**
   * A single (employee, location) balance row can have many requests.
   * The composite join mirrors the FOREIGN KEY defined in the TRD:
   *   FOREIGN KEY (employee_id, location_id) REFERENCES time_off_balances(employee_id, location_id)
   */
  @OneToMany(() => TimeOffRequest, (request) => request.balance)
  requests: TimeOffRequest[];

  // ── Lifecycle Hooks ────────────────────────────────────────────────────────

  @BeforeInsert()
  protected onInsert(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  @BeforeUpdate()
  protected onUpdate(): void {
    this.updatedAt = new Date();
  }
}
