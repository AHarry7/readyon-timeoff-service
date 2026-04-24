import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  OneToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { OutboxEventType, OutboxStatus } from "../../common/enums";
import { TimeOffRequest } from "./time-off-request.entity";

/**
 * outbox_events
 *
 * Implements the Transactional Outbox pattern. Every intent to call the HCM
 * API is persisted here in the same SQLite transaction that changes the
 * parent request's status. The Outbox Worker polls this table and performs
 * the actual HTTP call asynchronously.
 *
 * WORKER CONTRACT:
 *  1. SELECT rows WHERE status IN ('PENDING','PROCESSING') AND next_attempt_at <= now()
 *  2. UPDATE status = 'PROCESSING', attempt_count++, last_attempted_at = now()
 *     (atomic claim to prevent double-processing in future multi-worker setups)
 *  3. POST to HCM with idempotency_key header
 *  4a. 200 OK → UPDATE status = 'PROCESSED', hcm_response = <body>
 *      Also: UPDATE time_off_requests.status, UPDATE time_off_balances.hcm_balance
 *  4b. 4xx terminal → UPDATE status = 'FAILED', hcm_response = <body>
 *      Also: UPDATE time_off_requests.status = 'HCM_FAILED', alert ops
 *  4c. 5xx / timeout → UPDATE status = 'PENDING',
 *      next_attempt_at = now + 2^attempt_count minutes (capped at 30m)
 *      If attempt_count >= max_attempts → status = 'FAILED'
 *
 * IDEMPOTENCY:
 *  The idempotency_key forwarded to HCM is identical to the key stored here.
 *  Format: "{requestId}:{eventType}:{attemptVersion}"
 *  This prevents double-deduction if the worker retries after a network
 *  timeout where HCM already applied the deduction but the response was lost.
 */
@Entity("outbox_events")
@Index("idx_oe_status_next", ["status", "nextAttemptAt"])
export class OutboxEvent {
  @PrimaryColumn({ type: "text" })
  id: string;

  /**
   * FK to time_off_requests.id
   * One request → one active outbox event.
   * Cancellation of a FINALIZED request creates a second event (COMPENSATING_CREDIT)
   * after the original APPLY event is PROCESSED.
   */
  @Column({ name: "request_id", type: "text", nullable: false })
  requestId: string;

  /**
   * Determines which HCM endpoint the worker will call:
   *   APPLY             → POST /api/timeoff/apply
   *   CANCEL            → POST /api/timeoff/cancel  (pre-HCM cancellation)
   *   COMPENSATING_CREDIT → POST /api/timeoff/reverse (post-HCM cancellation)
   */
  @Column({
    name: "event_type",
    type: "text",
    nullable: false,
    enum: OutboxEventType,
  })
  eventType: OutboxEventType;

  /**
   * JSON-serialised body to be sent to HCM.
   * Stored verbatim so the worker never needs to re-query the request table
   * to reconstruct the payload; the stored payload is the canonical call.
   * Schema: { employeeId, locationId, daysRequested, leaveType,
   *           startDate, endDate, referenceId }
   */
  @Column({ name: "payload", type: "text", nullable: false })
  payload: string;

  /**
   * Forwarded as the Idempotency-Key HTTP header on every HCM call.
   * Unique constraint ensures no two outbox events share a key.
   */
  @Column({
    name: "idempotency_key",
    type: "text",
    nullable: false,
    unique: true,
  })
  idempotencyKey: string;

  @Column({
    name: "status",
    type: "text",
    nullable: false,
    default: OutboxStatus.PENDING,
    enum: OutboxStatus,
  })
  status: OutboxStatus;

  /** Number of HCM call attempts made so far (0 = never attempted). */
  @Column({
    name: "attempt_count",
    type: "integer",
    nullable: false,
    default: 0,
  })
  attemptCount: number;

  /**
   * Maximum retries before the worker marks this event FAILED.
   * Defaults to 5 (1 initial + 4 retries = backoff up to ~16 minutes).
   * Configurable per event type if certain operations warrant more patience.
   */
  @Column({
    name: "max_attempts",
    type: "integer",
    nullable: false,
    default: 5,
  })
  maxAttempts: number;

  /** Timestamp of the most recent HCM call attempt. Null = never attempted. */
  @Column({ name: "last_attempted_at", type: "datetime", nullable: true })
  lastAttemptedAt: Date | null;

  /**
   * The worker skips any event where next_attempt_at > now().
   * Set to now() on INSERT so it is immediately eligible.
   * On a retriable failure: next_attempt_at = now() + 2^attempt_count minutes,
   *                         capped at 30 minutes.
   * Formula (in service layer):
   *   const delayMinutes = Math.min(2 ** attemptCount, 30);
   *   nextAttemptAt = new Date(Date.now() + delayMinutes * 60_000);
   */
  @Column({ name: "next_attempt_at", type: "datetime", nullable: false })
  nextAttemptAt: Date;

  /**
   * Raw HCM response body stored for every attempt (overwritten each time).
   * Invaluable for post-incident debugging without needing to replay the call.
   */
  @Column({ name: "hcm_response", type: "text", nullable: true })
  hcmResponse: string | null;

  @Column({ name: "created_at", type: "datetime", nullable: false })
  createdAt: Date;

  @Column({ name: "updated_at", type: "datetime", nullable: false })
  updatedAt: Date;

  // ── Relations ──────────────────────────────────────────────────────────────

  @OneToOne(() => TimeOffRequest, (request) => request.outboxEvent, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "request_id" })
  request: TimeOffRequest;

  // ── Lifecycle Hooks ────────────────────────────────────────────────────────

  @BeforeInsert()
  protected onInsert(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    // Make the event immediately eligible for the worker on first insert.
    if (!this.nextAttemptAt) {
      this.nextAttemptAt = now;
    }
  }

  @BeforeUpdate()
  protected onUpdate(): void {
    this.updatedAt = new Date();
  }

  // ── Domain Helper ──────────────────────────────────────────────────────────

  /**
   * Computes the next retry timestamp using exponential backoff.
   * Call this after a retriable failure, then persist the entity.
   *
   * @param currentAttemptCount — the attempt_count value AFTER incrementing.
   */
  computeNextAttemptAt(currentAttemptCount: number): Date {
    const CAP_MINUTES = 30;
    const delayMinutes = Math.min(
      Math.pow(2, currentAttemptCount),
      CAP_MINUTES,
    );
    return new Date(Date.now() + delayMinutes * 60_000);
  }
}
