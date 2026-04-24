import { Injectable } from "@nestjs/common";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Scenario =
  | "NORMAL"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "INSUFFICIENT_BALANCE"
  | "SILENT_ACCEPT"
  | "INVALID_DIMENSION";

export interface ScenarioConfig {
  scenario: Scenario;
  /** If set, only applies to this employee. Null = global. */
  targetEmployeeId: string | null;
  /**
   * If set, the scenario fires only on the Nth call to the relevant endpoint
   * (1-based). After triggering, the rule is consumed and removed.
   */
  triggerAfterCount: number | null;
  /** Internal call counter, incremented each time a matching call is made. */
  _callCount: number;
}

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  availableDays: number;
  leaveType: string;
}

export interface AppliedDeduction {
  idempotencyKey: string;
  hcmReferenceId: string;
  employeeId: string;
  locationId: string;
  daysDeducted: number;
  appliedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HcmStoreService
 *
 * Central in-memory store for the mock HCM server.
 * All state lives here so controllers remain thin.
 * Call reset() between test cases to guarantee isolation.
 */
@Injectable()
export class HcmStoreService {
  // key: `${employeeId}::${locationId}`
  private balances = new Map<string, HcmBalance>();

  // key: idempotencyKey — prevents double-deductions on retried calls
  private deductions = new Map<string, AppliedDeduction>();

  // Active scenario rules (evaluated in insertion order; first match wins)
  private scenarioRules: ScenarioConfig[] = [];

  // Call counter per endpoint (for triggerAfterCount logic)
  private applyCallCount = 0;
  private balanceCallCount = 0;

  // ── Seed / Reset ────────────────────────────────────────────────────────────

  /**
   * Wipes all state and optionally seeds initial balances.
   * Call this from test beforeEach hooks.
   */
  reset(seedBalances: HcmBalance[] = []): void {
    this.balances.clear();
    this.deductions.clear();
    this.scenarioRules = [];
    this.applyCallCount = 0;
    this.balanceCallCount = 0;

    for (const b of seedBalances) {
      this.setBalance(b);
    }
  }

  // ── Balance CRUD ─────────────────────────────────────────────────────────────

  setBalance(balance: HcmBalance): void {
    const key = this.balanceKey(balance.employeeId, balance.locationId);
    this.balances.set(key, { ...balance });
  }

  getBalance(employeeId: string, locationId: string): HcmBalance | undefined {
    return this.balances.get(this.balanceKey(employeeId, locationId));
  }

  /** Apply an anniversary/year-start credit directly to the stored balance. */
  creditBalance(
    employeeId: string,
    locationId: string,
    creditDays: number,
  ): HcmBalance | null {
    const key = this.balanceKey(employeeId, locationId);
    const existing = this.balances.get(key);
    if (!existing) return null;
    existing.availableDays = parseFloat(
      (existing.availableDays + creditDays).toFixed(4),
    );
    return { ...existing };
  }

  /**
   * Deduct days from balance. Returns the updated balance or null if not found.
   * Does NOT apply scenario logic — callers must check scenarios first.
   */
  applyDeduction(
    idempotencyKey: string,
    employeeId: string,
    locationId: string,
    daysRequested: number,
  ):
    | { success: true; hcmReferenceId: string; remainingBalance: number }
    | { success: false; reason: string } {
    // Idempotency: already applied?
    const existing = this.deductions.get(idempotencyKey);
    if (existing) {
      const balance = this.getBalance(employeeId, locationId);
      return {
        success: true,
        hcmReferenceId: existing.hcmReferenceId,
        remainingBalance: balance?.availableDays ?? 0,
      };
    }

    const key = this.balanceKey(employeeId, locationId);
    const balance = this.balances.get(key);

    if (!balance) {
      return { success: false, reason: "BALANCE_NOT_FOUND" };
    }

    if (balance.availableDays < daysRequested) {
      return { success: false, reason: "INSUFFICIENT_BALANCE" };
    }

    balance.availableDays = parseFloat(
      (balance.availableDays - daysRequested).toFixed(4),
    );
    const hcmReferenceId = `hcm_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.deductions.set(idempotencyKey, {
      idempotencyKey,
      hcmReferenceId,
      employeeId,
      locationId,
      daysDeducted: daysRequested,
      appliedAt: new Date().toISOString(),
    });

    return {
      success: true,
      hcmReferenceId,
      remainingBalance: balance.availableDays,
    };
  }

  cancelDeduction(
    idempotencyKey: string,
    hcmReferenceId: string,
  ):
    | { success: true; restoredBalance: number }
    | { success: false; reason: string } {
    const deduction = this.deductions.get(idempotencyKey);
    if (!deduction || deduction.hcmReferenceId !== hcmReferenceId) {
      return { success: false, reason: "DEDUCTION_NOT_FOUND" };
    }

    const key = this.balanceKey(deduction.employeeId, deduction.locationId);
    const balance = this.balances.get(key);
    if (!balance) return { success: false, reason: "BALANCE_NOT_FOUND" };

    balance.availableDays = parseFloat(
      (balance.availableDays + deduction.daysDeducted).toFixed(4),
    );
    this.deductions.delete(idempotencyKey);

    return { success: true, restoredBalance: balance.availableDays };
  }

  // ── Scenario Management ──────────────────────────────────────────────────────

  addScenario(config: Omit<ScenarioConfig, "_callCount">): void {
    this.scenarioRules.push({ ...config, _callCount: 0 });
  }

  clearScenarios(): void {
    this.scenarioRules = [];
  }

  /**
   * Evaluates scenario rules for a given endpoint call.
   * Returns the active scenario (or 'NORMAL') and handles triggerAfterCount.
   */
  resolveScenario(
    endpoint: "apply" | "balance",
    employeeId?: string,
  ): Scenario {
    for (let i = 0; i < this.scenarioRules.length; i++) {
      const rule = this.scenarioRules[i];

      // Employee filter
      if (rule.targetEmployeeId && rule.targetEmployeeId !== employeeId)
        continue;

      rule._callCount++;

      // triggerAfterCount: only activate on the Nth call
      if (
        rule.triggerAfterCount !== null &&
        rule._callCount !== rule.triggerAfterCount
      ) {
        continue;
      }

      // If triggerAfterCount matched, consume the rule
      if (rule.triggerAfterCount !== null) {
        this.scenarioRules.splice(i, 1);
      }

      return rule.scenario;
    }
    return "NORMAL";
  }

  // ── Telemetry ────────────────────────────────────────────────────────────────

  incrementApplyCount(): number {
    return ++this.applyCallCount;
  }

  incrementBalanceCount(): number {
    return ++this.balanceCallCount;
  }

  getCallCounts(): { apply: number; balance: number } {
    return { apply: this.applyCallCount, balance: this.balanceCallCount };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private balanceKey(employeeId: string, locationId: string): string {
    return `${employeeId}::${locationId}`;
  }
}
