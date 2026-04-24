import {
  Controller,
  Get,
  Patch,
  Param,
  HttpCode,
  HttpStatus,
  Res,
  Logger,
  HttpException,
  BadGatewayException,
} from "@nestjs/common";
import { Response } from "express";
import { BalancesService } from "./balances.service";
import { EffectiveBalanceDto } from "./effective-balance.dto";

/**
 * BalancesController
 *
 * Exposes two endpoints:
 *
 *   GET  /api/v1/balances/:employeeId/:locationId
 *     Primary balance read. Returns effective balance with optional staleness info.
 *     Never returns 500 on HCM failure — always serves the best available data.
 *
 *   PATCH /api/v1/balances/:employeeId/:locationId/sync
 *     Explicit cache-bust. Forces a real-time HCM refresh.
 *     Returns 502 if HCM is unreachable (the caller explicitly wants fresh data).
 *
 * ROUTE PREFIX: 'api/v1/balances'
 * Set on the controller so AppModule can mount it cleanly via setGlobalPrefix()
 * or a RouterModule.
 *
 * AUTHENTICATION:
 * Assumed to be handled upstream by an API gateway or a NestJS Guard.
 * This controller does not implement auth — it trusts that :employeeId and
 * :locationId have been validated before the request reaches here.
 */
@Controller("api/v1/balances")
export class BalancesController {
  private readonly logger = new Logger(BalancesController.name);

  constructor(private readonly balancesService: BalancesService) {}

  /**
   * GET /api/v1/balances/:employeeId/:locationId
   *
   * Returns the effective balance breakdown for one (employee, location) pair.
   *
   * RESPONSE HEADERS (always set):
   *   Cache-Control: no-store
   *     Balance data must never be served from an HTTP cache — the content
   *     changes on every reservation or HCM sync event.
   *
   * RESPONSE HEADERS (when isStale=true):
   *   X-Balance-Stale: true
   *     Signals to API consumers that the hcm_balance was not refreshed
   *     from HCM on this request. Consumers that need guaranteed-fresh data
   *     should call the /sync endpoint instead.
   *   X-Balance-Last-Synced-At: <ISO timestamp>
   *     The timestamp of the last successful HCM sync, for display purposes.
   *
   * HTTP STATUS CODES:
   *   200 — Balance found and returned (may be stale; check isStale flag)
   *   404 — No local balance record exists AND HCM fetch failed
   *          (employee/location pair genuinely unknown, or HCM is down)
   */
  @Get(":employeeId/:locationId")
  @HttpCode(HttpStatus.OK)
  async getEffectiveBalance(
    @Param("employeeId") employeeId: string,
    @Param("locationId") locationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EffectiveBalanceDto> {
    this.logger.debug(
      `GET balance — employee=${employeeId} location=${locationId}`,
    );

    // Always prevent HTTP caching of balance responses.
    res.setHeader("Cache-Control", "no-store");

    const balance = await this.balancesService.getEffectiveBalance(
      employeeId,
      locationId,
    );

    // Set staleness headers so HTTP clients can react without parsing the body.
    if (balance.isStale) {
      res.setHeader("X-Balance-Stale", "true");
      res.setHeader("X-Balance-Last-Synced-At", balance.lastSyncedAt);

      this.logger.warn(
        `Serving stale balance for (${employeeId}, ${locationId}) — ` +
          `last synced ${balance.lastSyncedAt}. Reason: ${balance.staleness?.reason}`,
      );
    }

    return balance;
  }

  /**
   * PATCH /api/v1/balances/:employeeId/:locationId/sync
   *
   * Forces an immediate real-time HCM refresh, bypassing the 5-minute
   * staleness threshold.
   *
   * Use cases:
   *  - Manager wants guaranteed-fresh data before reviewing a request
   *  - Ops tooling triggering a reconciliation check
   *  - Integration tests asserting post-sync state
   *
   * Unlike the GET endpoint, this one DOES surface HCM errors to the caller:
   * if an explicit sync was requested but HCM is down, the caller needs to
   * know the data is not fresh.
   *
   * HTTP STATUS CODES:
   *   200 — Sync succeeded; returns freshly computed effective balance
   *   404 — No balance record exists for this (employee, location) pair
   *   502 — HCM was unreachable or returned a 5xx during the forced sync
   */
  @Patch(":employeeId/:locationId/sync")
  @HttpCode(HttpStatus.OK)
  async forceSync(
    @Param("employeeId") employeeId: string,
    @Param("locationId") locationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EffectiveBalanceDto> {
    this.logger.log(
      `PATCH /sync — employee=${employeeId} location=${locationId}`,
    );

    res.setHeader("Cache-Control", "no-store");

    try {
      const balance = await this.balancesService.forceSync(
        employeeId,
        locationId,
      );

      this.logger.log(
        `Force sync succeeded for (${employeeId}, ${locationId}) — ` +
          `effectiveBalance=${balance.effectiveBalance}d`,
      );

      return balance;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown HCM error";

      this.logger.error(
        `Force sync failed for (${employeeId}, ${locationId}): ${message}`,
      );

      // Re-throw NotFoundException as-is (404).
      if (err instanceof HttpException) {
        throw err;
      }

      // HCM unreachable / error → 502 Bad Gateway.
      throw new BadGatewayException(
        `HCM real-time sync failed: ${message}. ` +
          `The last cached balance can be fetched via GET /api/v1/balances/${employeeId}/${locationId}.`,
      );
    }
  }
}
