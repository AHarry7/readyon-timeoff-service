import { Body, Controller, HttpStatus, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { HcmStoreService } from "./hcm-store.service";

interface BatchBalanceItem {
  employeeId: string;
  locationId: string;
  availableDays: number | null;
  leaveType: string;
}

interface BatchPayloadDto {
  batchId: string;
  generatedAt: string;
  balances: BatchBalanceItem[];
}

/**
 * BatchController
 *
 * Simulates the HCM-side batch sender. In production, HCM would POST to ReadyOn.
 * In the mock, this endpoint receives batch payloads and stores them in the
 * mock's own balance store (simulating what HCM "knows" after a batch event).
 *
 * This is used to test:
 *  - Edge Case 3: Batch arrives mid-approval
 *  - Edge Case 7: Batch with null-balance employees
 *  - Edge Case 8: Duplicate batch delivery
 *
 * Note: The mock server does NOT track batchIds for dedup — that is the
 * ReadyOn microservice's responsibility (tested in integration tests).
 * This endpoint just updates the mock's in-memory balance state so that
 * subsequent GET /balance calls return the post-batch values.
 */
@Controller("hcm")
export class BatchController {
  constructor(private readonly store: HcmStoreService) {}

  /**
   * POST /hcm/batch-update
   *
   * Updates mock HCM balances to reflect what a real HCM batch would set.
   * Call this from tests BEFORE triggering ReadyOn's batch ingest to set up
   * the expected HCM state.
   */
  @Post("batch-update")
  batchUpdate(@Body() dto: BatchPayloadDto, @Res() res: Response): void {
    const results: Array<{
      employeeId: string;
      locationId: string;
      status: string;
    }> = [];

    for (const item of dto.balances) {
      if (item.availableDays === null || item.availableDays === undefined) {
        // Edge Case 7: null balance — skip and log
        results.push({
          employeeId: item.employeeId,
          locationId: item.locationId,
          status: "SKIPPED_NULL_BALANCE",
        });
        continue;
      }

      this.store.setBalance({
        employeeId: item.employeeId,
        locationId: item.locationId,
        availableDays: item.availableDays,
        leaveType: item.leaveType ?? "ANNUAL",
      });

      results.push({
        employeeId: item.employeeId,
        locationId: item.locationId,
        status: "UPDATED",
      });
    }

    res.status(200).json({
      batchId: dto.batchId,
      processed: results.filter((r) => r.status === "UPDATED").length,
      skipped: results.filter((r) => r.status !== "UPDATED").length,
      results,
    });
  }
}
