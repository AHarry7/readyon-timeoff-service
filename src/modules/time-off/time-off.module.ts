import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { TimeOffRequest } from "../../database/entities/time-off-request.entity";
import { TimeOffBalance } from "../../database/entities/time-off-balance.entity";
import { BalanceLedger } from "../../database/entities/balance-ledger.entity";
import { OutboxEvent } from "../../database/entities/outbox-event.entity";
import { IdempotencyKey } from "../../database/entities/idempotency-key.entity";

import { BalancesModule } from "../../modules/balances/balances.module";
import { TimeOffService } from "./time-off.service";
import { TimeOffController } from "./time-off.controller";

/**
 * TimeOffModule
 *
 * Owns the time-off request lifecycle: submit, approve, reject, cancel, read.
 *
 * ENTITY REGISTRATIONS (forFeature):
 *  - TimeOffRequest  — the central entity this module writes
 *  - TimeOffBalance  — read inside transactions for balance validation
 *  - BalanceLedger   — written on every reservation event
 *  - OutboxEvent     — written atomically on approval and cancellation
 *  - IdempotencyKey  — written by IdempotencyInterceptor (also forFeature'd
 *                      here because the interceptor is provided by this module
 *                      via APP_INTERCEPTOR — see AppModule for the global
 *                      registration)
 *
 * CROSS-MODULE IMPORTS:
 *  - BalancesModule  — provides BalancesService, which TimeOffService calls
 *                      during submitRequest() to warm the balance cache and
 *                      perform the pre-transaction best-effort fetch.
 *
 * The IdempotencyInterceptor is NOT declared here — it is registered as a
 * global interceptor in AppModule via { provide: APP_INTERCEPTOR, useClass }.
 * That registration gives it access to the NestJS DI container globally.
 * However, it needs the IdempotencyKey repository, so IdempotencyKey must be
 * registered with forFeature() in at least one module in the same DI subtree.
 * We do it here because this module is the primary owner of idempotency logic.
 *
 * TimeOffService is exported so that future modules (e.g. an AdminModule or
 * a ReconciliationModule) can call getRequest() without duplicating query logic.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TimeOffRequest,
      TimeOffBalance,
      BalanceLedger,
      OutboxEvent,
      IdempotencyKey,
    ]),
    BalancesModule,
  ],
  providers: [TimeOffService],
  controllers: [TimeOffController],
  exports: [TimeOffService],
})
export class TimeOffModule {}
