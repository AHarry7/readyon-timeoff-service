import { Controller, Get, Param, Res, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { HcmStoreService } from "./hcm-store.service";

/**
 * BalanceController
 * * Simulates the HCM GET /balance endpoint.
 * Supports TIMEOUT and SERVER_ERROR scenarios for testing stale-balance logic.
 */
@Controller("balance")
export class BalanceController {
  constructor(private readonly store: HcmStoreService) {}

  @Get(":employeeId/:locationId")
  async getBalance(
    @Param("employeeId") employeeId: string,
    @Param("locationId") locationId: string,
    @Res() res: Response,
  ) {
    this.store.incrementBalanceCount();

    // Check if the test suite injected a failure scenario for this call
    const scenario = this.store.resolveScenario("balance", employeeId);

    if (scenario === "TIMEOUT") {
      await new Promise<void>((resolve) => setTimeout(resolve, 35_000));
      res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ code: "TIMEOUT_SIMULATED" });
      return;
    }

    if (scenario === "SERVER_ERROR") {
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ code: "INTERNAL_ERROR" });
      return;
    }

    if (scenario === "INVALID_DIMENSION") {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        code: "INVALID_DIMENSION",
        message: "Unknown locationId",
      });
      return;
    }

    // Happy Path
    const balance = this.store.getBalance(employeeId, locationId);

    if (!balance) {
      res.status(HttpStatus.NOT_FOUND).json({ code: "BALANCE_NOT_FOUND" });
      return;
    }

    res.status(HttpStatus.OK).json({
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      availableDays: balance.availableDays,
      leaveType: balance.leaveType,
      asOf: new Date().toISOString(),
    });
  }
}
