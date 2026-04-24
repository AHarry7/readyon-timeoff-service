import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { LedgerEventType } from '../../common/enums';

/**
 * balance_ledger
 *
 * Append-only. Every event that materially affects a balance — whether from
 * a real-time HCM sync, a batch update, a reservation, or a compensating
 * credit — produces exactly one row here.
 *
 * DESIGN CONSTRAINTS:
 *  - This entity must NEVER be updated or deleted after insert.
 *  - Service-layer code must write a ledger row in the same transaction as
 *    any write to time_off_balances or time_off_requests that changes balance.
 *  - There is no @BeforeUpdate hook; any attempt to call repository.save()
 *    on an existing row in the service layer is a bug.
 *
 * The `delta` column uses signed arithmetic:
 *   positive (+) = balance increased (credit / sync refresh showing more days)
 *   negative (−) = balance decreased (debit / reservation created)
 */
@Entity('balance_ledger')
@Index('idx_bl_employee', ['employeeId', 'locationId', 'createdAt'])
export class BalanceLedger {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ name: 'employee_id', type: 'text', nullable: false })
  employeeId: string;

  @Column({ name: 'location_id', type: 'text', nullable: false })
  locationId: string;

  /**
   * Signed change in balance days.
   * Examples:
   *   +5.0  → HCM_SYNC_BATCH credited 5 days on year-start
   *   -3.0  → RESERVATION_CREATED (employee submitted 3-day request)
   *   +3.0  → RESERVATION_RELEASED (manager rejected the request)
   *   -3.0  → RESERVATION_FINALIZED (HCM confirmed the deduction)
   *   +3.0  → COMPENSATING_CREDIT (employee cancelled a finalized request)
   */
  @Column({ name: 'delta', type: 'real', nullable: false })
  delta: number;

  /**
   * Categorises the cause of this ledger entry.
   * Maps to the SQL CHECK constraint on event_type.
   */
  @Column({
    name: 'event_type',
    type: 'text',
    nullable: false,
    enum: LedgerEventType,
  })
  eventType: LedgerEventType;

  /**
   * Foreign reference to the entity that triggered this entry.
   * Value is a time_off_requests.id for request-driven events,
   * or an hcm_batch_snapshots.id for batch-driven events.
   * Stored as plain TEXT rather than a typed FK to keep the ledger generic
   * and avoid cascading deletes.
   */
  @Column({ name: 'reference_id', type: 'text', nullable: true })
  referenceId: string | null;

  /** Human-readable annotation for debugging and reconciliation. */
  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string | null;

  /**
   * Immutable insert timestamp.
   * No updatedAt column — this table is append-only by design.
   */
  @Column({ name: 'created_at', type: 'datetime', nullable: false })
  createdAt: Date;

  // ── Lifecycle Hooks ────────────────────────────────────────────────────────

  @BeforeInsert()
  protected onInsert(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
    this.createdAt = new Date();
  }
}
