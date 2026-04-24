import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: InitialSchema
 *
 * Creates all six tables defined in the TRD Data Model (§3), including:
 *  - CHECK constraints that TypeORM's entity decorator system cannot emit on SQLite
 *  - The composite FOREIGN KEY with DEFERRABLE INITIALLY DEFERRED on time_off_requests
 *  - The partial index on outbox_events for efficient worker polling
 *  - All PRAGMA settings (foreign_keys, WAL, busy_timeout) are handled at
 *    connection time in database.module.ts, not in migrations.
 *
 * Run order matters: time_off_balances must exist before time_off_requests
 * (composite FK), and time_off_requests before outbox_events (FK).
 */
export class InitialSchema1714000000000 implements MigrationInterface {
  name = 'InitialSchema1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── 3.1 time_off_balances ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "time_off_balances" (
        "id"             TEXT     NOT NULL PRIMARY KEY,
        "employee_id"    TEXT     NOT NULL,
        "location_id"    TEXT     NOT NULL,
        "hcm_balance"    REAL     NOT NULL DEFAULT 0,
        "last_synced_at" DATETIME NOT NULL,
        "sync_source"    TEXT     NOT NULL
                         CHECK ("sync_source" IN ('REALTIME', 'BATCH', 'MANUAL')),
        "version"        INTEGER  NOT NULL DEFAULT 1,
        "created_at"     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        "updated_at"     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

        CONSTRAINT "uq_tob_employee_location" UNIQUE ("employee_id", "location_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tob_employee"
        ON "time_off_balances" ("employee_id")
    `);

    // ── 3.2 time_off_requests ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "time_off_requests" (
        "id"                 TEXT     NOT NULL PRIMARY KEY,
        "employee_id"        TEXT     NOT NULL,
        "location_id"        TEXT     NOT NULL,
        "days_requested"     REAL     NOT NULL CHECK ("days_requested" > 0),
        "start_date"         TEXT     NOT NULL,
        "end_date"           TEXT     NOT NULL,
        "leave_type"         TEXT     NOT NULL,
        "status"             TEXT     NOT NULL DEFAULT 'PENDING'
                             CHECK ("status" IN (
                               'PENDING', 'APPROVED', 'HCM_PENDING',
                               'FINALIZED', 'REJECTED', 'HCM_FAILED'
                             )),
        "submitted_by"       TEXT     NOT NULL,
        "reviewed_by"        TEXT,
        "rejection_reason"   TEXT,
        "idempotency_key"    TEXT     NOT NULL,
        "hcm_reference_id"   TEXT,
        "hcm_error_message"  TEXT,
        "balance_snapshot"   REAL     NOT NULL,
        "created_at"         DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        "updated_at"         DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

        CONSTRAINT "uq_tor_idempotency_key" UNIQUE ("idempotency_key"),

        /*
         * Composite FK to the (employee_id, location_id) unique pair on
         * time_off_balances. DEFERRABLE INITIALLY DEFERRED allows us to
         * insert both rows in the same transaction without ordering constraints.
         * TypeORM does not emit DEFERRABLE; this is why we use a manual migration.
         */
        CONSTRAINT "fk_tor_balance"
          FOREIGN KEY ("employee_id", "location_id")
          REFERENCES "time_off_balances" ("employee_id", "location_id")
          DEFERRABLE INITIALLY DEFERRED
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tor_employee_status"
        ON "time_off_requests" ("employee_id", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tor_idempotency"
        ON "time_off_requests" ("idempotency_key")
    `);

    // ── 3.3 balance_ledger ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "balance_ledger" (
        "id"           TEXT     NOT NULL PRIMARY KEY,
        "employee_id"  TEXT     NOT NULL,
        "location_id"  TEXT     NOT NULL,
        "delta"        REAL     NOT NULL,
        "event_type"   TEXT     NOT NULL
                       CHECK ("event_type" IN (
                         'HCM_SYNC_REALTIME',
                         'HCM_SYNC_BATCH',
                         'RESERVATION_CREATED',
                         'RESERVATION_RELEASED',
                         'RESERVATION_FINALIZED',
                         'COMPENSATING_CREDIT',
                         'MANUAL_ADJUSTMENT'
                       )),
        "reference_id" TEXT,
        "notes"        TEXT,
        "created_at"   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bl_employee"
        ON "balance_ledger" ("employee_id", "location_id", "created_at")
    `);

    // ── 3.4 outbox_events ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbox_events" (
        "id"                TEXT     NOT NULL PRIMARY KEY,
        "request_id"        TEXT     NOT NULL
                            REFERENCES "time_off_requests" ("id")
                            ON DELETE CASCADE,
        "event_type"        TEXT     NOT NULL
                            CHECK ("event_type" IN ('APPLY', 'CANCEL', 'COMPENSATING_CREDIT')),
        "payload"           TEXT     NOT NULL,
        "idempotency_key"   TEXT     NOT NULL,
        "status"            TEXT     NOT NULL DEFAULT 'PENDING'
                            CHECK ("status" IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
        "attempt_count"     INTEGER  NOT NULL DEFAULT 0,
        "max_attempts"      INTEGER  NOT NULL DEFAULT 5,
        "last_attempted_at" DATETIME,
        "next_attempt_at"   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        "hcm_response"      TEXT,
        "created_at"        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        "updated_at"        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

        CONSTRAINT "uq_oe_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);

    /*
     * Partial index: only rows that the worker might need to process are indexed.
     * This keeps the index small even after millions of PROCESSED/FAILED rows
     * accumulate over time.
     *
     * Note: SQLite supports partial indexes natively since 3.8.9 (2015).
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_oe_status_next"
        ON "outbox_events" ("status", "next_attempt_at")
        WHERE "status" IN ('PENDING', 'PROCESSING')
    `);

    // ── 3.5 hcm_batch_snapshots ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hcm_batch_snapshots" (
        "id"           TEXT     NOT NULL PRIMARY KEY,
        "batch_id"     TEXT     NOT NULL,
        "received_at"  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        "payload"      TEXT     NOT NULL,
        "status"       TEXT     NOT NULL DEFAULT 'RECEIVED'
                       CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'PARTIALLY_FAILED')),
        "processed_at" DATETIME,
        "error_notes"  TEXT,

        CONSTRAINT "uq_hbs_batch_id" UNIQUE ("batch_id")
      )
    `);

    // ── 3.6 idempotency_keys ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_keys" (
        "key"         TEXT     NOT NULL PRIMARY KEY,
        "endpoint"    TEXT     NOT NULL,
        "response"    TEXT     NOT NULL,
        "status_code" INTEGER  NOT NULL,
        "expires_at"  DATETIME NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ik_expires"
        ON "idempotency_keys" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order to avoid FK constraint violations.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ik_expires"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "hcm_batch_snapshots"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_oe_status_next"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_events"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_bl_employee"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "balance_ledger"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tor_idempotency"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tor_employee_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "time_off_requests"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tob_employee"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "time_off_balances"`);
  }
}
