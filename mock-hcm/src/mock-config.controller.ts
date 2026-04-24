import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { HcmStoreService, HcmBalance, Scenario } from "./hcm-store.service";

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

interface SetScenarioDto {
  scenario: Scenario;
  targetEmployeeId?: string;
  /**
   * If provided, the scenario fires only on this call number (1-based).
   * After triggering the rule is consumed.
   * Example: triggerAfterCount=2 → first call is NORMAL, second fires the scenario.
   */
  triggerAfterCount?: number;
}

interface AnniversaryCreditDto {
  employeeId: string;
  locationId: string;
  creditDays: number;
}

interface SeedBalanceDto {
  employeeId: string;
  locationId: string;
  availableDays: number;
  leaveType?: string;
}

interface ResetDto {
  seedBalances?: SeedBalanceDto[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MockConfigController
 *
 * Test control plane. Never ship this in production.
 * Exposed at /mock/* so it's trivially filterable from real HCM routes.
 */
@Controller("mock")
export class MockConfigController {
  constructor(private readonly store: HcmStoreService) {}

  // ── Scenario injection ──────────────────────────────────────────────────────

  /**
   * POST /mock/config
   * Set a scenario rule. Rules stack; first matching rule wins on each call.
   *
   * Body:
   *   { "scenario": "TIMEOUT", "targetEmployeeId": "emp_001", "triggerAfterCount": 2 }
   *
   * Scenarios:
   *   NORMAL            → 200 OK, normal processing
   *   TIMEOUT           → no response for 35 seconds (exceeds typical 10s client timeout)
   *   SERVER_ERROR      → 500 Internal Server Error
   *   INSUFFICIENT_BALANCE → 422 with code INSUFFICIENT_BALANCE
   *   SILENT_ACCEPT     → 200 OK but balance NOT deducted (simulates broken HCM)
   *   INVALID_DIMENSION → 422 with code INVALID_DIMENSION
   */
  @Post("config")
  @HttpCode(HttpStatus.OK)
  setScenario(@Body() dto: SetScenarioDto) {
    this.store.addScenario({
      scenario: dto.scenario,
      targetEmployeeId: dto.targetEmployeeId ?? null,
      triggerAfterCount: dto.triggerAfterCount ?? null,
    });
    return {
      ok: true,
      message: `Scenario '${dto.scenario}' registered`,
      targetEmployeeId: dto.targetEmployeeId ?? "global",
      triggerAfterCount: dto.triggerAfterCount ?? "every call",
    };
  }

  /**
   * DELETE /mock/config
   * Clear all active scenario rules. Resets to NORMAL behaviour.
   */
  @Delete("config")
  @HttpCode(HttpStatus.OK)
  clearScenarios() {
    this.store.clearScenarios();
    return { ok: true, message: "All scenario rules cleared" };
  }

  // ── Anniversary / external credit simulation ────────────────────────────────

  /**
   * POST /mock/events/anniversary-credit
   * Directly injects a balance credit to simulate an HCM work-anniversary event
   * or year-start reset — i.e., an HCM write that ReadyOn does NOT know about yet.
   */
  @Post("events/anniversary-credit")
  @HttpCode(HttpStatus.OK)
  anniversaryCredit(@Body() dto: AnniversaryCreditDto) {
    const updated = this.store.creditBalance(
      dto.employeeId,
      dto.locationId,
      dto.creditDays,
    );
    if (!updated) {
      return {
        ok: false,
        message: `No balance record found for ${dto.employeeId}/${dto.locationId}`,
      };
    }
    return {
      ok: true,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      creditedDays: dto.creditDays,
      newAvailableDays: updated.availableDays,
    };
  }

  // ── Seed / Reset ─────────────────────────────────────────────────────────────

  /**
   * POST /mock/reset
   * Wipes all state (balances, deductions, scenarios, call counters) and
   * optionally seeds fresh balance data. Call this in beforeEach.
   */
  @Post("reset")
  @HttpCode(HttpStatus.OK)
  reset(@Body() dto: ResetDto = {}) {
    const seedBalances: HcmBalance[] = (dto.seedBalances ?? []).map((b) => ({
      employeeId: b.employeeId,
      locationId: b.locationId,
      availableDays: b.availableDays,
      leaveType: b.leaveType ?? "ANNUAL",
    }));
    this.store.reset(seedBalances);
    return {
      ok: true,
      message: "Mock HCM state reset",
      seededRecords: seedBalances.length,
    };
  }

  /**
   * POST /mock/seed
   * Add or update a single balance record without wiping existing state.
   * Useful for mid-test setup within complex scenarios.
   */
  @Post("seed")
  @HttpCode(HttpStatus.OK)
  seed(@Body() dto: SeedBalanceDto) {
    this.store.setBalance({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      availableDays: dto.availableDays,
      leaveType: dto.leaveType ?? "ANNUAL",
    });
    return { ok: true, seeded: dto };
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────

  /**
   * GET /mock/telemetry
   * Returns call counts for assertions in tests.
   * Example: assert that the outbox worker retried exactly 3 times.
   */
  @Get("telemetry")
  getTelemetry() {
    return this.store.getCallCounts();
  }
}
