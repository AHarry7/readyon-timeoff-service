import { Body, Controller, HttpStatus, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { HcmStoreService } from "./hcm-store.service";

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

interface ApplyTimeOffDto {
  idempotencyKey: string;
  employeeId: string;
  locationId: string;
  daysRequested: number;
  leaveType: string;
  startDate: string;
  endDate: string;
}

interface CancelTimeOffDto {
  idempotencyKey: string;
  hcmReferenceId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TimeOffController
 *
 * Simulates the HCM mutation endpoints with full scenario support.
 *
 * SILENT_ACCEPT scenario:
 *   Returns 200 OK as if the deduction was applied, but deliberately does NOT
 *   deduct from the stored balance. This simulates a broken/non-compliant HCM
 *   that silently accepts requests without honouring them. Our microservice's
 *   reconciliation logic must catch this.
 *
 * TIMEOUT scenario:
 *   Holds the connection open for 35 seconds. Combined with a 10s client
 *   timeout, this reliably exercises the "did it apply or not?" ambiguity path.
 */
@Controller("timeoff")
export class TimeOffController {
  constructor(private readonly store: HcmStoreService) {}

  /**
   * POST /timeoff/apply
   *
   * Applies a time-off deduction against the HCM balance.
   * Fully idempotent: duplicate idempotencyKey returns the original result.
   */
  @Post("apply")
  async applyTimeOff(
    @Body() dto: ApplyTimeOffDto,
    @Res() res: Response,
  ): Promise<void> {
    this.store.incrementApplyCount();

    // ── Input validation ─────────────────────────────────────────────────────
    if (
      !dto.idempotencyKey ||
      !dto.employeeId ||
      !dto.locationId ||
      !dto.daysRequested
    ) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: "INVALID_REQUEST",
        message:
          "idempotencyKey, employeeId, locationId, daysRequested are required",
      });
      return;
    }

    if (dto.daysRequested <= 0) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        code: "INVALID_DAYS",
        message: "daysRequested must be greater than 0",
      });
      return;
    }

    const scenario = this.store.resolveScenario("apply", dto.employeeId);

    // ── Scenario: TIMEOUT ────────────────────────────────────────────────────
    if (scenario === "TIMEOUT") {
      // Hold the connection for 35s. The ReadyOn client should time out at 10s.
      // This exercises the "ambiguous — did HCM apply or not?" path.
      await new Promise<void>((resolve) => setTimeout(resolve, 35_000));
      res.status(503).json({ code: "TIMEOUT_SIMULATED" });
      return;
    }

    // ── Scenario: SERVER_ERROR ───────────────────────────────────────────────
    if (scenario === "SERVER_ERROR") {
      res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Simulated HCM internal server error",
      });
      return;
    }

    // ── Scenario: INVALID_DIMENSION ──────────────────────────────────────────
    if (scenario === "INVALID_DIMENSION") {
      res.status(422).json({
        code: "INVALID_DIMENSION",
        message: `Unknown dimension combination: employee=${dto.employeeId} location=${dto.locationId}`,
      });
      return;
    }

    // ── Scenario: INSUFFICIENT_BALANCE ───────────────────────────────────────
    // Forced rejection regardless of actual stored balance.
    if (scenario === "INSUFFICIENT_BALANCE") {
      res.status(422).json({
        code: "INSUFFICIENT_BALANCE",
        message: "HCM reports insufficient leave balance (simulated)",
      });
      return;
    }

    // ── Scenario: SILENT_ACCEPT ──────────────────────────────────────────────
    // Returns 200 OK but does NOT apply the actual deduction.
    // The balance in the store remains unchanged — simulating a broken HCM.
    if (scenario === "SILENT_ACCEPT") {
      const fakeReferenceId = `hcm_silent_${Date.now()}`;
      const currentBalance = this.store.getBalance(
        dto.employeeId,
        dto.locationId,
      );
      res.status(200).json({
        hcmReferenceId: fakeReferenceId,
        status: "APPLIED",
        remainingBalance: currentBalance?.availableDays ?? 0,
        _debug: "SILENT_ACCEPT: balance was NOT actually deducted",
      });
      return;
    }

    // ── Normal path ───────────────────────────────────────────────────────────
    const result = this.store.applyDeduction(
      dto.idempotencyKey,
      dto.employeeId,
      dto.locationId,
      dto.daysRequested,
    );

    if (!result.success) {
      if (result.reason === "BALANCE_NOT_FOUND") {
        res.status(404).json({
          code: "BALANCE_NOT_FOUND",
          message: `No balance record for employee=${dto.employeeId} location=${dto.locationId}`,
        });
        return;
      }
      if (result.reason === "INSUFFICIENT_BALANCE") {
        res.status(422).json({
          code: "INSUFFICIENT_BALANCE",
          message: "HCM reports insufficient leave balance",
        });
        return;
      }
    }

    if (result.success) {
      res.status(200).json({
        hcmReferenceId: result.hcmReferenceId,
        status: "APPLIED",
        remainingBalance: result.remainingBalance,
      });
    }
  }

  /**
   * POST /timeoff/cancel
   *
   * Reverses a previously applied deduction (compensating transaction).
   * Used when a FINALIZED request is later cancelled by HR.
   */
  @Post("cancel")
  async cancelTimeOff(
    @Body() dto: CancelTimeOffDto,
    @Res() res: Response,
  ): Promise<void> {
    if (!dto.idempotencyKey || !dto.hcmReferenceId) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: "INVALID_REQUEST",
        message: "idempotencyKey and hcmReferenceId are required",
      });
      return;
    }

    const result = this.store.cancelDeduction(
      dto.idempotencyKey,
      dto.hcmReferenceId,
    );

    if (!result.success) {
      res.status(404).json({
        code: result.reason,
        message: "Deduction not found or hcmReferenceId mismatch",
      });
      return;
    }

    res.status(200).json({
      status: "CANCELLED",
      restoredBalance: result.restoredBalance,
    });
  }
}
