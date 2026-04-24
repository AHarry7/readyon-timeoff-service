import { Module } from "@nestjs/common";
import { HcmStoreService } from "./hcm-store.service";
import { MockConfigController } from "./mock-config.controller";
import { BalanceController } from "./balance.controller";
import { TimeOffController } from "./timeoff.controller";
import { BatchController } from "./batch.controller";

/**
 * AppModule
 *
 * HcmStoreService is provided at module scope so all controllers share
 * the same in-memory state instance. This is intentional — it lets the
 * test control plane (/mock/config, /mock/reset) affect the behaviour of
 * the business endpoints (/balance, /timeoff/apply) in real time.
 */
@Module({
  controllers: [
    MockConfigController,
    BalanceController,
    TimeOffController,
    BatchController,
  ],
  providers: [HcmStoreService],
})
export class AppModule {}
