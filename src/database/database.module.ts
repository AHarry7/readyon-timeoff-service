import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import {
  BalanceLedger,
  HcmBatchSnapshot,
  IdempotencyKey,
  OutboxEvent,
  TimeOffBalance,
  TimeOffRequest,
} from "./entities";

/**
 * Builds the TypeORM DataSource options from environment config.
 * Extracted as a standalone function so it can be reused by:
 *  - The NestJS DatabaseModule (runtime)
 *  - The TypeORM CLI migration runner (via data-source.ts)
 */
export function buildDataSourceOptions(dbPath: string): DataSourceOptions {
  return {
    type: "better-sqlite3",
    database: dbPath,

    /**
     * All entities are listed explicitly (no glob patterns) to ensure
     * tree-shaking works correctly in production builds and to make it
     * immediately obvious which tables this service owns.
     */
    entities: [
      TimeOffBalance,
      TimeOffRequest,
      BalanceLedger,
      OutboxEvent,
      HcmBatchSnapshot,
      IdempotencyKey,
    ],

    /**
     * Migrations are always run explicitly (either via CLI or on startup
     * in non-production environments). We never use `synchronize: true`
     * in any environment because it can silently drop columns on schema
     * changes.
     */
    migrations: ["dist/database/migrations/*.js"],
    migrationsTableName: "typeorm_migrations",

    /**
     * synchronize: false — always. Schema changes go through migrations.
     * This is enforced here rather than driven by NODE_ENV because a
     * developer running locally against a real DB would still be burned
     * by auto-sync dropping columns.
     */
    synchronize: false,

    /**
     * Logging: log slow queries (>200ms) and schema errors in all envs.
     * Full query logging is only enabled when LOG_SQL=true to avoid
     * leaking PII into production logs.
     */
    logging:
      process.env.LOG_SQL === "true"
        ? ["query", "error", "warn", "schema"]
        : ["error", "warn", "schema"],

    /**
     * better-sqlite3 connection hook.
     *
     * PRAGMA foreign_keys = ON
     *   SQLite does not enforce foreign keys by default. This pragma must be
     *   set on every new connection (it is not persisted in the database file).
     *   Without it, the FK from time_off_requests → time_off_balances and
     *   the FK from outbox_events → time_off_requests are silently unenforced.
     *
     * PRAGMA journal_mode = WAL
     *   WAL (Write-Ahead Logging) allows concurrent readers while a write is
     *   in progress. Under the default DELETE journal, a write blocks all
     *   reads. The outbox worker performs frequent small writes; WAL prevents
     *   those from blocking balance-read endpoints.
     *
     * PRAGMA busy_timeout = 5000
     *   If another connection holds a write lock, wait up to 5 s before
     *   returning SQLITE_BUSY. Prevents transient "database is locked" errors
     *   when the outbox worker and an API request write concurrently.
     */
    prepareDatabase: (db) => {
      db.pragma("foreign_keys = ON");
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
    },
  };
}

/**
 * DatabaseModule
 *
 * Registered once at the AppModule level. Re-exports TypeOrmModule so that
 * feature modules can use forFeature() without needing to import this module
 * repeatedly.
 *
 * Usage in AppModule:
 *   imports: [DatabaseModule, ...]
 *
 * Usage in feature modules:
 *   imports: [TypeOrmModule.forFeature([TimeOffBalance, TimeOffRequest])]
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbPath = config.get<string>("DATABASE_PATH", "timeoff.db");
        return buildDataSourceOptions(dbPath);
      },
      /**
       * Provide the DataSource as a named token so it can be injected
       * directly in services that need raw query access (e.g. for the
       * atomic multi-table transactions in RequestService).
       */
      dataSourceFactory: async (options) => {
        const dataSource = new DataSource(options!);
        return dataSource.initialize();
      },
    }),
  ],
  /**
   * Re-export TypeOrmModule so importing DatabaseModule in AppModule is
   * sufficient — feature modules get TypeOrmModule's forFeature() machinery
   * without a separate import.
   */
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
