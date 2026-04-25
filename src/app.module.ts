import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";

import { DatabaseModule } from "./database/database.module";
import { HcmClientModule } from "./hcm-client/hcm-client.module";
import { BalancesModule } from "./modules/balances/balances.module";
import { TimeOffModule } from "./modules/time-off/time-off.module";

import { IdempotencyInterceptor } from "./common/interceptors/idempotency.interceptor";

/**
 * AppModule — root module.
 *
 * GLOBAL INTERCEPTOR REGISTRATION:
 *  APP_INTERCEPTOR is a NestJS multi-provider token. Providing
 *  IdempotencyInterceptor with this token registers it for every route in
 *  the application, regardless of which module owns the controller.
 *
 *  The interceptor depends on @InjectRepository(IdempotencyKey). NestJS
 *  resolves this from the TypeOrmModule.forFeature([IdempotencyKey]) call
 *  inside TimeOffModule — providers registered globally (via APP_INTERCEPTOR)
 *  share the root DI container and can access repositories from any forFeature
 *  registration in the application.
 *
 * MODULE ORDER:
 *  DatabaseModule must be first — it initialises the TypeORM DataSource that
 *  all other modules depend on.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    HcmClientModule,
    BalancesModule,
    TimeOffModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
