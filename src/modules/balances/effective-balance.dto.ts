/**
 * EffectiveBalanceDto
 *
 * The response shape returned by GET /api/v1/balances/:employeeId/:locationId.
 *
 * We surface all three terms of the balance formula explicitly so the UI can
 * render a transparent breakdown rather than just a single number:
 *
 *   effectiveBalance = hcmBalance - activeReservationDays
 *
 * The staleness flag allows the UI to show a visual warning when the local
 * cache could not be refreshed (HCM was unreachable).
 */
export class EffectiveBalanceDto {
  employeeId: string;
  locationId: string;

  /**
   * The last HCM-confirmed balance in days.
   * This is the raw value stored in time_off_balances.hcm_balance.
   * It does NOT account for active reservations.
   */
  hcmBalance: number;

  /**
   * Sum of days_requested for all requests in PENDING | APPROVED | HCM_PENDING
   * status for this (employeeId, locationId) pair.
   * These days are "spoken for" but not yet confirmed by HCM.
   */
  activeReservationDays: number;

  /**
   * The number the employee and manager should act on.
   * effectiveBalance = hcmBalance - activeReservationDays
   * This value can be negative in a conflict scenario (see TRD §7, case 3).
   */
  effectiveBalance: number;

  /**
   * ISO 8601 UTC timestamp of the last successful HCM sync.
   * The UI uses this to show "Balance as of X minutes ago".
   */
  lastSyncedAt: string;

  /**
   * Which mechanism last wrote hcm_balance. One of: REALTIME | BATCH | MANUAL.
   */
  syncSource: string;

  /**
   * True when the local hcm_balance was served from cache because the HCM
   * real-time call failed (timeout / server error). The displayed balance is
   * the last known good value, which may be stale.
   *
   * When stale=true, the response also carries the X-Balance-Stale: true
   * HTTP header so API consumers can react programmatically without parsing
   * the body.
   */
  isStale: boolean;

  /**
   * Only present when isStale=true. Describes why the refresh failed.
   * Example: "HCM did not respond within 10000ms"
   * Intended for logging/ops dashboards, not for display to end users.
   */
  staleness?: {
    reason: string;
    errorType: string;
  };
}
