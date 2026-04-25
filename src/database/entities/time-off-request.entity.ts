import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  ManyToOne,
  OneToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { RequestStatus } from "src/common/enums";
import { TimeOffBalance } from "./time-off-balance.entity";
import { OutboxEvent } from "./outbox-event.entity";

/**
 * time_off_requests
 *
 * Central table. Each row is a single time-off request and carries its full
 * lifecycle status from PENDING through FINALIZED (or REJECTED / HCM_FAILED).
 *
 * State machine:
 *   PENDING → APPROVED → HCM_PENDING → FINALIZED
 *   PENDING → REJECTED
 *   APPROVED → REJECTED          (before outbox event fires)
 *   HCM_PENDING → HCM_FAILED    (after max outbox retries exhausted)
 *
 * The composite FOREIGN KEY to time_off_balances is implemented via
 * @ManyToOne with a two-column @JoinColumn. TypeORM will generate the FK
 * on the balance relation; the migration script adds the DEFERRABLE clause
 * manually because TypeORM does not expose that option.
 */
@Entity("time_off_requests")
@Index("idx_tor_employee_status", ["employeeId", "status"])
@Index("idx_tor_idempotency", ["idempotencyKey"], { unique: true })
export class TimeOffRequest {
  @PrimaryColumn({ type: "text" })
  id: string;

  // ── Dimension columns (also the FK join columns) ──────────────────────────

  @Column({ name: "employee_id", type: "text", nullable: false })
  employeeId: string;

  @Column({ name: "location_id", type: "text", nullable: false })
  locationId: string;

  // ── Business columns ───────────────────────────────────────────────────────

  /**
   * Number of working days requested.
   * CHECK (days_requested > 0) is enforced by the migration DDL.
   */
  @Column({ name: "days_requested", type: "real", nullable: false })
  daysRequested: number;

  /**
   * Stored as TEXT in SQLite (ISO 8601 date: 'YYYY-MM-DD').
   * Using string rather than Date avoids the timezone-shift pitfalls that
   * SQLite's date handling introduces when Node deserializes Date objects.
   */
  @Column({ name: "start_date", type: "text", nullable: false })
  startDate: string;

  @Column({ name: "end_date", type: "text", nullable: false })
  endDate: string;

  /** Free-form category: 'ANNUAL', 'SICK', 'UNPAID', etc. */
  @Column({ name: "leave_type", type: "text", nullable: false })
  leaveType: string;

  /**
   * Maps to the SQL CHECK constraint on status.
   * TypeORM does not emit CHECK constraints from the enum option on SQLite;
   * the constraint is added by the migration script.
   */
  @Column({
    name: "status",
    type: "text",
    nullable: false,
    default: RequestStatus.PENDING,
    enum: RequestStatus,
  })
  status: RequestStatus;

  /** The employeeId of the person submitting this request. */
  @Column({ name: "submitted_by", type: "text", nullable: false })
  submittedBy: string;

  /** Populated when a manager approves or rejects. */
  @Column({ name: "reviewed_by", type: "text", nullable: true })
  reviewedBy: string | null;

  @Column({ name: "rejection_reason", type: "text", nullable: true })
  rejectionReason: string | null;

  /**
   * Client-generated UUID used to make POST /requests idempotent.
   * The UNIQUE constraint is enforced both here (@Index unique) and in the
   * migration DDL.
   */
  @Column({ name: "idempotency_key", type: "text", nullable: false })
  idempotencyKey: string;

  /**
   * Populated once the outbox worker receives a successful HCM confirmation.
   * This is HCM's own reference ID for the approved leave booking.
   */
  @Column({ name: "hcm_reference_id", type: "text", nullable: true })
  hcmReferenceId: string | null;

  /** Stores the raw HCM error detail when status transitions to HCM_FAILED. */
  @Column({ name: "hcm_error_message", type: "text", nullable: true })
  hcmErrorMessage: string | null;

  /**
   * Snapshot of the effective_balance at the moment this request was submitted.
   * Used by reconciliation jobs to detect drift between what the employee saw
   * and what was later confirmed by HCM.
   */
  @Column({ name: "balance_snapshot", type: "real", nullable: false })
  balanceSnapshot: number;

  @Column({ name: "created_at", type: "datetime", nullable: false })
  createdAt: Date;

  @Column({ name: "updated_at", type: "datetime", nullable: false })
  updatedAt: Date;

  // ── Relations ──────────────────────────────────────────────────────────────

  /**
   * Composite FK to time_off_balances(employee_id, location_id).
   *
   * TypeORM resolves the join by matching both columns simultaneously.
   * This mirrors the TRD constraint:
   *   FOREIGN KEY (employee_id, location_id)
   *     REFERENCES time_off_balances (employee_id, location_id)
   *     DEFERRABLE INITIALLY DEFERRED
   *
   * The DEFERRABLE clause is added manually in the migration because
   * TypeORM's SchemaBuilder does not expose it for SQLite.
   */
  @ManyToOne(() => TimeOffBalance, (balance) => balance.requests, {
    nullable: false,
    onDelete: "RESTRICT",
  })
  @JoinColumn([
    { name: "employee_id", referencedColumnName: "employeeId" },
    { name: "location_id", referencedColumnName: "locationId" },
  ])
  balance: TimeOffBalance;

  /**
   * Each request has at most one active outbox event at a time.
   * Navigating this relation from the request side is useful for status dashboards.
   */
  @OneToOne(() => OutboxEvent, (event) => event.request)
  outboxEvent: OutboxEvent;

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
