/**
 * hcm-result.type.ts
 *
 * Defines the discriminated union returned by every HcmClientService method.
 *
 * WHY A DISCRIMINATED UNION INSTEAD OF THROWING?
 * ─────────────────────────────────────────────
 * The TRD calls out explicitly that HCM errors must never crash the calling
 * service — a stale balance is preferable to a 500 bubbling to the employee.
 * If HcmClientService threw on timeout or 5xx, every caller would need its
 * own try/catch and its own interpretation of Axios error shapes. The union
 * forces the compiler to require the caller to handle both branches, making
 * the defensive policy impossible to forget.
 *
 * Pattern:
 *   const result = await this.hcmClient.getHcmBalance(empId, locId);
 *   if (!result.success) {
 *     // compiler knows result is HcmFailure here
 *     logger.warn(result.errorType, result.errorMessage);
 *     return serveStaleBalance();
 *   }
 *   // compiler knows result.data is HcmBalanceData here
 *   return result.data;
 */

// ── Error taxonomy ─────────────────────────────────────────────────────────

/**
 * TIMEOUT        — The HCM connection/response deadline was exceeded.
 *                  The request may or may not have been applied by HCM.
 *                  For write operations, the outbox idempotency key handles
 *                  the ambiguity on retry.
 *
 * SERVER_ERROR   — HCM returned an HTTP 5xx. Treat as transient; retry via
 *                  the outbox worker with exponential back-off.
 *
 * DOMAIN_ERROR   — HCM returned an HTTP 4xx (insufficient balance, invalid
 *                  dimension, unknown employee). Terminal; do not retry.
 *                  The caller must transition the request to HCM_FAILED.
 *
 * NETWORK_ERROR  — TCP-level failure (ECONNREFUSED, DNS failure, etc.).
 *                  Treat as transient; same retry policy as SERVER_ERROR.
 */
export type HcmErrorType =
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "DOMAIN_ERROR"
  | "NETWORK_ERROR";

export interface HcmSuccess<T> {
  success: true;
  data: T;
  /** Raw HTTP status code (200, 201, …) */
  statusCode: number;
}

export interface HcmFailure {
  success: false;
  errorType: HcmErrorType;
  errorMessage: string;
  /** Present when HCM responded with an HTTP status (4xx / 5xx). */
  statusCode?: number;
  /** Raw response body from HCM, if available. Stored in outbox_events.hcm_response. */
  rawResponse?: string;
}

export type HcmResult<T> = HcmSuccess<T> | HcmFailure;

// ── Response data shapes ───────────────────────────────────────────────────

/** Shape of the body returned by GET /api/balance/:employeeId/:locationId */
export interface HcmBalanceData {
  employeeId: string;
  locationId: string;
  /** HCM's authoritative balance in days (REAL, supports 0.5 increments). */
  balanceDays: number;
  /** ISO 8601 date string: the point in time HCM computed this value. */
  asOfDate: string;
}

/** Shape of the body returned by POST /api/timeoff/apply on success. */
export interface HcmDeductionData {
  /** HCM's own stable reference for this approved booking. */
  confirmationId: string;
  employeeId: string;
  locationId: string;
  deductedDays: number;
  /** HCM's remaining balance after the deduction. */
  remainingBalance: number;
}

/** Shape of the body returned by POST /api/timeoff/reverse on success. */
export interface HcmReversalData {
  reversalConfirmationId: string;
  employeeId: string;
  locationId: string;
  creditedDays: number;
  newBalance: number;
}

// ── Outbound payload DTOs ──────────────────────────────────────────────────

/** Body sent to POST /api/timeoff/apply */
export interface ApplyDeductionPayload {
  employeeId: string;
  locationId: string;
  daysRequested: number;
  leaveType: string;
  startDate: string;
  endDate: string;
  /** Our internal request ID — stored as HCM's referenceId for traceability. */
  referenceId: string;
}

/** Body sent to POST /api/timeoff/reverse */
export interface ReverseDeductionPayload {
  /** The confirmationId received from HCM when APPLY was first processed. */
  originalConfirmationId: string;
  employeeId: string;
  locationId: string;
  daysToCredit: number;
  reason: string;
}
