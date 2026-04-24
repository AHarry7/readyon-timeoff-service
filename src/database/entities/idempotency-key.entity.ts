import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  BeforeInsert,
} from 'typeorm';

/**
 * idempotency_keys
 *
 * Deduplicates inbound requests to our own API endpoints.
 * Distinct from the HCM-side idempotency tracked in outbox_events.
 *
 * HOW IT WORKS:
 *  - Clients supply an `Idempotency-Key: <UUID>` header on every mutating call.
 *  - On the first call: execute handler, cache {status_code, response}, return result.
 *  - On a repeat call within 24 hours: return the cached response without re-executing.
 *  - On a repeat call after 24 hours: treat as a new request (key has expired).
 *
 * CONFLICT DETECTION:
 *  A request with a key that already exists but differs in endpoint is a client
 *  bug. The service returns 409 Conflict with an explanatory message.
 *
 * STORAGE HYGIENE:
 *  A scheduled NestJS cron job (IdempotencyCleanupTask) purges rows where
 *  expires_at < now() to prevent unbounded table growth.
 *  The idx_ik_expires index makes this purge an efficient range delete.
 *
 * NOTE:
 *  This entity uses `key` as the primary key (a plain string) rather than
 *  a surrogate UUID, because lookups are always by the client-supplied key
 *  value and there is no need for an additional unique index.
 */
@Entity('idempotency_keys')
@Index('idx_ik_expires', ['expiresAt'])
export class IdempotencyKey {
  /**
   * The client-supplied UUID v4 idempotency key.
   * This is the primary key — no surrogate ID is needed.
   */
  @PrimaryColumn({ name: 'key', type: 'text' })
  key: string;

  /**
   * The endpoint path this key is scoped to.
   * Format: "{HTTP_METHOD} {path_template}"
   * Examples:
   *   "POST /requests"
   *   "PATCH /requests/:id/approve"
   *   "DELETE /requests/:id"
   *
   * Scoping to endpoint prevents cross-endpoint key collisions (where a client
   * accidentally reuses the same UUID for a different operation type).
   */
  @Column({ name: 'endpoint', type: 'text', nullable: false })
  endpoint: string;

  /**
   * JSON-serialised HTTP response body returned on the original request.
   * Returned verbatim on replay to give the client identical semantics
   * regardless of whether this is the first or a subsequent call.
   */
  @Column({ name: 'response', type: 'text', nullable: false })
  response: string;

  /** HTTP status code returned on the original request. */
  @Column({ name: 'status_code', type: 'integer', nullable: false })
  statusCode: number;

  /**
   * TTL boundary: expires_at = created_at + 24 hours.
   * After this point the key is treated as absent by the lookup logic and will
   * eventually be purged by the cleanup cron.
   */
  @Column({ name: 'expires_at', type: 'datetime', nullable: false })
  expiresAt: Date;

  // ── Lifecycle Hook ─────────────────────────────────────────────────────────

  @BeforeInsert()
  protected onInsert(): void {
    // Set TTL to 24 hours from now if not explicitly provided.
    if (!this.expiresAt) {
      this.expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    }
  }
}
