import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule"; // <-- Added this
import { APP_INTERCEPTOR } from "@nestjs/core";

import { DatabaseModule } from "./database/database.module";
import { HcmClientModule } from "./hcm-client/hcm-client.module";
import { BalancesModule } from "./modules/balances/balances.module";
import { TimeOffModule } from "./modules/time-off/time-off.module";
import { OutboxModule } from "./outbox/outbox.module";
import { IdempotencyInterceptor } from "./common/interceptors/idempotency.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // <-- Added this so @Cron() works!
    DatabaseModule,
    HcmClientModule,
    BalancesModule,
    TimeOffModule,
    OutboxModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
