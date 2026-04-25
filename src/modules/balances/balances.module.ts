import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  BalanceLedger,
  TimeOffBalance,
  TimeOffRequest,
} from "src/database/entities";
import { HcmClientModule } from "../../hcm-client/hcm-client.module";
import { BalancesService } from "./balances.service";
import { BalancesController } from "./balances.controller";

/**
 * BalancesModule
 *
 * Owns the balance read path and real-time HCM sync logic.
 *
 * Entities imported via forFeature():
 *  - TimeOffBalance  — the hcm_balance cache table being read and updated
 *  - TimeOffRequest  — needed to compute activeReservationDays inline
 *  - BalanceLedger   — written on every hcm_balance mutation
 *
 * HcmClientModule is imported (not declared) because HcmClientService is
 * provided and exported by that module. This keeps HCM communication
 * concerns in one place.
 *
 * BalancesService is exported so that:
 *  - TimeOffRequestModule can call getEffectiveBalance() during submission
 *    to validate the employee has sufficient balance.
 *  - OutboxWorkerModule can call forceSync() after an HCM DOMAIN_ERROR to
 *    reconcile the stale local cache.
 *  - SyncModule (batch processing) can call upsertFromBatch() for each row.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffBalance, TimeOffRequest, BalanceLedger]),
    HcmClientModule,
  ],
  providers: [BalancesService],
  controllers: [BalancesController],
  exports: [BalancesService],
})
export class BalancesModule {}
