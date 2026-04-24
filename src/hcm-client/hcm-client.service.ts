import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { AxiosError, AxiosResponse } from "axios";
import { firstValueFrom, TimeoutError } from "rxjs";
import { timeout } from "rxjs/operators";

import {
  HcmResult,
  HcmBalanceData,
  HcmDeductionData,
  HcmReversalData,
  ApplyDeductionPayload,
  ReverseDeductionPayload,
  HcmFailure,
} from "./hcm-result.type";

/**
 * HcmClientService
 *
 * The single point of contact between this microservice and the external HCM
 * system. Every outbound HCM call goes through this service.
 *
 * DESIGN PRINCIPLES:
 *  1. Never throw to callers. All outcomes — including timeouts, network
 *     failures, and HCM 4xx/5xx errors — are returned as a typed
 *     HcmResult<T> discriminated union. The compiler forces callers to
 *     handle both branches.
 *
 *  2. Every mutating call (APPLY, REVERSE) receives an Idempotency-Key
 *     header. This is the primary defence against double-deduction when the
 *     outbox worker retries after an ambiguous timeout.
 *
 *  3. Error classification is explicit. A 4xx (DOMAIN_ERROR) must not be
 *     retried — it indicates a permanent problem (invalid dimensions, no
 *     balance). A timeout or 5xx (TIMEOUT / SERVER_ERROR / NETWORK_ERROR)
 *     is transient and should be retried by the outbox worker with backoff.
 *     The caller decides retry policy; this service only classifies.
 *
 *  4. Raw HCM response bodies are always captured and returned in the
 *     HcmFailure shape so the outbox worker can persist them in
 *     outbox_events.hcm_response for post-incident debugging.
 */
@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);

  /**
   * Request timeout in milliseconds. Applied via RxJS `timeout()` operator
   * rather than Axios's own timeout option so we get a typed TimeoutError
   * that maps cleanly to our HcmErrorType.TIMEOUT classification.
   *
   * Sourced from HCM_TIMEOUT_MS env var; defaults to 10 000 ms (10 s).
   */
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.timeoutMs = this.config.get<number>("HCM_TIMEOUT_MS", 10_000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetches the authoritative balance for a single (employeeId, locationId)
   * pair from the HCM real-time API.
   *
   * Maps to: GET /api/balance/:employeeId/:locationId
   *
   * Called by BalancesService when the local cache is absent or stale.
   * Read-only — no idempotency key required.
   */
  async getHcmBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmResult<HcmBalanceData>> {
    const url = `/api/balance/${encodeURIComponent(employeeId)}/${encodeURIComponent(locationId)}`;

    this.logger.debug(`GET ${url}`);

    return this.executeRequest<HcmBalanceData>(
      this.httpService.get<HcmBalanceData>(url),
      "GET balance",
    );
  }

  /**
   * Sends a time-off deduction request to HCM.
   *
   * Maps to: POST /api/timeoff/apply
   *
   * IDEMPOTENCY CONTRACT:
   * The idempotencyKey is forwarded as the Idempotency-Key HTTP header.
   * If HCM honours the header, a repeated call with the same key returns
   * the original confirmation without double-applying the deduction.
   * If HCM does NOT honour the header (or the mock `silentOverdraft` flag
   * is active), the outbox worker's PROCESSED status check prevents a
   * second call from being made at all.
   *
   * RESULT SEMANTICS FOR CALLERS:
   *  success: true  → transition request → FINALIZED, decrement hcm_balance
   *  TIMEOUT        → leave outbox event PENDING, retry later
   *  SERVER_ERROR   → leave outbox event PENDING, retry later
   *  NETWORK_ERROR  → leave outbox event PENDING, retry later
   *  DOMAIN_ERROR   → transition request → HCM_FAILED, alert ops, stop retrying
   */
  async applyDeduction(
    payload: ApplyDeductionPayload,
    idempotencyKey: string,
  ): Promise<HcmResult<HcmDeductionData>> {
    const url = "/api/timeoff/apply";

    this.logger.debug(
      `POST ${url} | idempotency=${idempotencyKey} | ref=${payload.referenceId}`,
    );

    return this.executeRequest<HcmDeductionData>(
      this.httpService.post<HcmDeductionData>(url, payload, {
        headers: { "Idempotency-Key": idempotencyKey },
      }),
      "POST apply",
    );
  }

  /**
   * Issues a compensating credit to HCM when a previously FINALIZED request
   * is cancelled by the employee.
   *
   * Maps to: POST /api/timeoff/reverse
   *
   * Same idempotency semantics as applyDeduction.
   */
  async reverseDeduction(
    payload: ReverseDeductionPayload,
    idempotencyKey: string,
  ): Promise<HcmResult<HcmReversalData>> {
    const url = "/api/timeoff/reverse";

    this.logger.debug(
      `POST ${url} | idempotency=${idempotencyKey} | originalRef=${payload.originalConfirmationId}`,
    );

    return this.executeRequest<HcmReversalData>(
      this.httpService.post<HcmReversalData>(url, payload, {
        headers: { "Idempotency-Key": idempotencyKey },
      }),
      "POST reverse",
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Wraps any Axios Observable in our timeout + error-classification logic.
   *
   * @param observable$ — the raw Axios observable from HttpService
   * @param label       — short string used in log messages
   */
  private async executeRequest<T>(
    observable$: ReturnType<typeof this.httpService.get>,
    label: string,
  ): Promise<HcmResult<T>> {
    try {
      const response = (await firstValueFrom(
        observable$.pipe(timeout(this.timeoutMs)),
      )) as AxiosResponse<T>;

      return {
        success: true,
        data: response.data,
        statusCode: response.status,
      };
    } catch (err) {
      return this.classifyError(err, label);
    }
  }

  /**
   * Classifies a caught error into one of our four HcmErrorType values.
   *
   * Classification rules (evaluated in order):
   *
   *  1. RxJS TimeoutError (our operator fired before Axios completed)
   *     → TIMEOUT
   *
   *  2. AxiosError with a response (HCM replied with an HTTP status)
   *     2a. status >= 500 → SERVER_ERROR  (transient, retry)
   *     2b. status 4xx   → DOMAIN_ERROR   (terminal, stop retrying)
   *
   *  3. AxiosError without a response (no TCP connection established)
   *     → NETWORK_ERROR
   *
   *  4. Anything else (unexpected JS error)
   *     → NETWORK_ERROR as a safe fallback (do not crash the caller)
   */
  private classifyError(err: unknown, label: string): HcmFailure {
    // ── 1. Timeout ────────────────────────────────────────────────────────
    if (err instanceof TimeoutError) {
      this.logger.warn(`[HCM] ${label} timed out after ${this.timeoutMs}ms`);
      return {
        success: false,
        errorType: "TIMEOUT",
        errorMessage: `HCM did not respond within ${this.timeoutMs}ms`,
      };
    }

    // ── 2. Axios error with an HTTP response ──────────────────────────────
    if (this.isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      const rawResponse = this.safeStringify(data);

      if (status >= 500) {
        this.logger.warn(`[HCM] ${label} server error: HTTP ${status}`);
        return {
          success: false,
          errorType: "SERVER_ERROR",
          errorMessage: `HCM returned HTTP ${status}`,
          statusCode: status,
          rawResponse,
        };
      }

      // 4xx — domain / validation error. Log at debug because this is an
      // expected code path (e.g. insufficient balance on re-check).
      this.logger.debug(
        `[HCM] ${label} domain error: HTTP ${status} — ${rawResponse}`,
      );
      return {
        success: false,
        errorType: "DOMAIN_ERROR",
        errorMessage:
          this.extractHcmErrorMessage(data) ??
          `HCM rejected with HTTP ${status}`,
        statusCode: status,
        rawResponse,
      };
    }

    // ── 3. Axios error without a response (network / DNS / ECONNREFUSED) ──
    if (this.isAxiosError(err)) {
      const code = err.code ?? "UNKNOWN";
      this.logger.warn(
        `[HCM] ${label} network error: ${code} — ${err.message}`,
      );
      return {
        success: false,
        errorType: "NETWORK_ERROR",
        errorMessage: `Network error reaching HCM: ${err.message}`,
      };
    }

    // ── 4. Unexpected error — safe fallback ───────────────────────────────
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[HCM] ${label} unexpected error: ${message}`,
      err instanceof Error ? err.stack : undefined,
    );
    return {
      success: false,
      errorType: "NETWORK_ERROR",
      errorMessage: `Unexpected error communicating with HCM: ${message}`,
    };
  }

  /**
   * Type guard for AxiosError. Avoids importing the AxiosError class directly
   * and relying on instanceof (which can fail across package boundaries).
   */
  private isAxiosError(err: unknown): err is AxiosError {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as AxiosError).isAxiosError === true
    );
  }

  /**
   * Safely extracts a human-readable error message from an HCM 4xx response
   * body. HCM error bodies follow the shape: { error: string; message: string }
   * but we never assume this — hence the optional chaining.
   */
  private extractHcmErrorMessage(body: unknown): string | null {
    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      if (typeof b["message"] === "string") return b["message"];
      if (typeof b["error"] === "string") return b["error"];
    }
    return null;
  }

  /** JSON.stringify that never throws (handles circular references, etc.). */
  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
