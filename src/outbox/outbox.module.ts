import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { OutboxEvent } from "src/database/entities/";
import { TimeOffRequest } from "src/database/entities";
import { TimeOffBalance } from "src/database/entities";
import { BalanceLedger } from "src/database/entities";
import { IdempotencyKey } from "src/database/entities";

import { HcmClientModule } from "../hcm-client/hcm-client.module";
import { BalancesModule } from "../modules/balances/balances.module";

import { OutboxWorkerService } from "./outbox-worker.service";
import { IdempotencyCleanupService } from "./idempotency-cleanup.service";

/**
 * OutboxModule
 *
 * Owns all background processing: the HCM call worker and the idempotency
 * key cleanup job. Both are NestJS scheduled tasks driven by @Cron decorators,
 * which requires ScheduleModule.forRoot() to be registered somewhere in the
 * application. We import it here and let it be global.
 *
 * ENTITY REGISTRATIONS (forFeature):
 *  - OutboxEvent     — the primary table the worker reads and writes
 *  - TimeOffRequest  — updated (FINALIZED / HCM_FAILED) on each outcome
 *  - TimeOffBalance  — updated with HCM's confirmed remainingBalance on success
 *  - BalanceLedger   — appended on every finalization or compensating credit
 *  - IdempotencyKey  — managed by IdempotencyCleanupService
 *
 * CROSS-MODULE IMPORTS:
 *  - HcmClientModule  — provides HcmClientService for outbound HCM calls
 *  - BalancesModule   — provides BalancesService.forceSync() for post-failure
 *                       reconciliation of the local balance cache
 *
 * REGISTRATION IN AppModule:
 *  OutboxModule is imported in AppModule alongside TimeOffModule.
 *  ScheduleModule.forRoot() must only be called once per application;
 *  importing it here is sufficient because NestJS deduplicates module imports.
 *
 * Updated AppModule imports section:
 *   imports: [
 *     ConfigModule.forRoot({ isGlobal: true }),
 *     DatabaseModule,
 *     HcmClientModule,
 *     BalancesModule,
 *     TimeOffModule,
 *     OutboxModule,    ← add this
 *   ]
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OutboxEvent,
      TimeOffRequest,
      TimeOffBalance,
      BalanceLedger,
      IdempotencyKey,
    ]),
    HcmClientModule,
    BalancesModule,
  ],
  providers: [OutboxWorkerService, IdempotencyCleanupService],
  // No exports — these services are internal background workers.
  // Other modules interact with the outbox indirectly by writing rows
  // to outbox_events (via TimeOffService.approveRequest), not by calling
  // OutboxWorkerService methods directly.
})
export class OutboxModule {}
