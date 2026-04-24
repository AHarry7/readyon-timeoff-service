import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { BatchSnapshotStatus } from '../common/enums';

/**
 * hcm_batch_snapshots
 *
 * Stores the raw payload of every batch update received from HCM.
 * Serves two purposes:
 *
 *  1. IDEMPOTENCY — The unique constraint on batch_id means a duplicate
 *     delivery from HCM (e.g. due to HCM retry logic) returns 409 Conflict
 *     without re-processing any records.
 *
 *  2. AUDIT — The full payload is retained so that any merge decision made
 *     by the SyncService can be replayed or inspected post-incident.
 *
 * Processing is asynchronous: the HTTP handler for POST /sync/batch
 * inserts a row with status = 'RECEIVED' and responds 202 immediately.
 * The BatchSyncWorker then reads RECEIVED rows, runs the merge algorithm,
 * and updates status to 'PROCESSED' or 'PARTIALLY_FAILED'.
 */
@Entity('hcm_batch_snapshots')
export class HcmBatchSnapshot {
  @PrimaryColumn({ type: 'text' })
  id: string;

  /**
   * The identifier assigned by HCM to this batch run.
   * Unique constraint guards against duplicate deliveries.
   */
  @Column({ name: 'batch_id', type: 'text', nullable: false, unique: true })
  batchId: string;

  /** Timestamp at which ExampleHR received this batch payload. */
  @Column({ name: 'received_at', type: 'datetime', nullable: false })
  receivedAt: Date;

  /**
   * Complete JSON body of the HCM batch push.
   * Schema: { batchId, generatedAt, records: [{ employeeId, locationId, balanceDays, leaveType }] }
   * Stored verbatim to ensure the raw source-of-truth is always recoverable.
   */
  @Column({ name: 'payload', type: 'text', nullable: false })
  payload: string;

  @Column({
    name: 'status',
    type: 'text',
    nullable: false,
    default: BatchSnapshotStatus.RECEIVED,
    enum: BatchSnapshotStatus,
  })
  status: BatchSnapshotStatus;

  /**
   * Populated by the BatchSyncWorker once all records have been processed.
   * Null while status is RECEIVED (processing not yet started).
   */
  @Column({ name: 'processed_at', type: 'datetime', nullable: true })
  processedAt: Date | null;

  /**
   * Free-text field populated when status = 'PARTIALLY_FAILED'.
   * Contains a JSON-serialised summary of which (employeeId, locationId)
   * records failed and why, for ops / reconciliation use.
   */
  @Column({ name: 'error_notes', type: 'text', nullable: true })
  errorNotes: string | null;

  // ── Lifecycle Hooks ────────────────────────────────────────────────────────

  @BeforeInsert()
  protected onInsert(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
    this.receivedAt = new Date();
  }
}
