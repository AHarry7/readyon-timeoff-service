import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { HcmClientService } from "./hcm-client.service";

/**
 * HcmClientModule
 *
 * Self-contained module responsible for all outbound HCM communication.
 * Importing this module gives feature modules access to HcmClientService
 * without needing to know how the HTTP client is configured.
 *
 * Configuration (all sourced from environment / ConfigService):
 *
 *   HCM_BASE_URL     — Base URL of the HCM API.
 *                       Local dev:  http://localhost:3001
 *                       Test suite: http://localhost:3001 (mock HCM server)
 *
 *   HCM_TIMEOUT_MS   — Per-request timeout in milliseconds.
 *                       Defaults to 10 000 ms inside HcmClientService.
 *                       Set lower (e.g. 500) in unit tests to keep them fast.
 *
 * Axios default settings (set here, not in HcmClientService, to keep the
 * service constructor clean):
 *
 *   maxRedirects: 0  — HCM should never redirect; treat a redirect as an error
 *                      so we don't silently follow to an unexpected endpoint.
 *
 *   validateStatus   — Deliberately unset (Axios default: throw on >= 400).
 *                      We want Axios to resolve the observable for ALL HTTP
 *                      responses so that HcmClientService.classifyError()
 *                      can inspect the status code and body. If we let Axios
 *                      throw on 4xx, we'd lose the response body in some
 *                      Axios versions.
 *
 *                      WAIT — actually we DO want Axios to throw on 4xx so
 *                      that our catch block in executeRequest() is reached and
 *                      classifyError() runs. The default Axios behaviour
 *                      (throw on status >= 400) is correct for our pattern
 *                      because the catch block reads err.response.status and
 *                      err.response.data. Leaving validateStatus unset is
 *                      intentional.
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseURL: config.getOrThrow<string>("HCM_BASE_URL"),
        maxRedirects: 0,
        // Do NOT set a global `timeout` here. We apply per-request timeouts
        // via the RxJS `timeout()` operator in HcmClientService.executeRequest()
        // so that a timed-out observable produces a typed TimeoutError rather
        // than an Axios CancelledError, which is easier to classify correctly.
      }),
    }),
  ],
  providers: [HcmClientService],
  exports: [HcmClientService],
})
export class HcmClientModule {}
