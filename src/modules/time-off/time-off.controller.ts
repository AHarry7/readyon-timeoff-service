import {
  Controller,
  Post,
  Patch,
  Delete,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
  Optional,
} from "@nestjs/common";
import { TimeOffService } from "./time-off.service";
import {
  SubmitRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
  CancelRequestDto,
} from "./dto/time-off-request.dto";

/**
 * TimeOffController
 *
 * Thin HTTP adapter. All business logic, transaction management, and error
 * classification live in TimeOffService. This controller's only jobs are:
 *   1. Map HTTP verbs / paths to service methods.
 *   2. Extract and forward the Idempotency-Key header (consumed by the
 *      global IdempotencyInterceptor AND forwarded to the service for
 *      storing on the request entity itself).
 *   3. Return the correct HTTP status codes.
 *
 * Error handling:
 *   NestJS's built-in exception filter maps our service exceptions to HTTP:
 *     NotFoundException          → 404
 *     BadRequestException        → 400
 *     UnprocessableEntityException → 422
 *     ConflictException          → 409
 *     BadGatewayException        → 502
 *   No try/catch is needed here — let the filter do its job.
 *
 * Global prefix is set in main.ts: app.setGlobalPrefix('api/v1')
 * Routes in this controller are therefore:
 *   POST   /api/v1/requests
 *   PATCH  /api/v1/requests/:id/approve
 *   PATCH  /api/v1/requests/:id/reject
 *   DELETE /api/v1/requests/:id
 *   GET    /api/v1/requests/:id
 *   GET    /api/v1/requests?employeeId=&status=&page=&limit=
 */
@Controller("requests")
export class TimeOffController {
  private readonly logger = new Logger(TimeOffController.name);

  constructor(private readonly timeOffService: TimeOffService) {}

  /**
   * POST /api/v1/requests
   *
   * Submits a new time-off request.
   * Idempotency-Key is required (enforced by the global IdempotencyInterceptor).
   *
   * Success:  201 Created
   * Errors:   400 (validation), 404 (no balance record), 422 (insufficient balance)
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submitRequest(
    @Body() dto: SubmitRequestDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    this.logger.log(
      `POST /requests — employee=${dto.employeeId} location=${dto.locationId} ` +
        `days=${dto.daysRequested} type=${dto.leaveType}`,
    );

    return this.timeOffService.submitRequest(dto, idempotencyKey);
  }

  /**
   * PATCH /api/v1/requests/:id/approve
   *
   * Manager approves a PENDING request.
   * Atomically transitions status to APPROVED and writes the HCM outbox event.
   *
   * Success:  200 OK
   * Errors:   404 (not found), 409 (not in PENDING status)
   */
  @Patch(":id/approve")
  @HttpCode(HttpStatus.OK)
  async approveRequest(
    @Param("id") requestId: string,
    @Body() dto: ApproveRequestDto,
  ) {
    this.logger.log(
      `PATCH /requests/${requestId}/approve — reviewer=${dto.reviewedBy}`,
    );

    return this.timeOffService.approveRequest(requestId, dto);
  }

  /**
   * PATCH /api/v1/requests/:id/reject
   *
   * Manager rejects a PENDING request.
   * Releases the reservation (no HCM call made).
   *
   * Success:  200 OK
   * Errors:   404 (not found), 409 (not in PENDING status)
   */
  @Patch(":id/reject")
  @HttpCode(HttpStatus.OK)
  async rejectRequest(
    @Param("id") requestId: string,
    @Body() dto: RejectRequestDto,
  ) {
    this.logger.log(
      `PATCH /requests/${requestId}/reject — reviewer=${dto.reviewedBy}`,
    );

    return this.timeOffService.rejectRequest(requestId, dto);
  }

  /**
   * DELETE /api/v1/requests/:id
   *
   * Employee or manager cancels a request.
   * Behaviour varies by current status (see TimeOffService.cancelRequest).
   * For FINALIZED requests: queues a compensating HCM credit asynchronously.
   *
   * We return 200 rather than 204 because the response body carries meaningful
   * state (compensatingCreditQueued, opsWarning) that clients need to act on.
   *
   * Success:  200 OK
   * Errors:   404 (not found), 409 (terminal status, cannot cancel)
   */
  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async cancelRequest(
    @Param("id") requestId: string,
    @Body() dto: CancelRequestDto,
  ) {
    this.logger.log(
      `DELETE /requests/${requestId} — cancelledBy=${dto.cancelledBy}`,
    );

    return this.timeOffService.cancelRequest(requestId, dto);
  }

  /**
   * GET /api/v1/requests/:id
   *
   * Returns the full detail of a single request.
   *
   * Success:  200 OK
   * Errors:   404 (not found)
   */
  @Get(":id")
  @HttpCode(HttpStatus.OK)
  async getRequest(@Param("id") requestId: string) {
    return this.timeOffService.getRequest(requestId);
  }

  /**
   * GET /api/v1/requests?employeeId=&status=&page=&limit=
   *
   * Paginated list of requests, filtered by employeeId and optionally by status.
   *
   * Success:  200 OK  →  { data: [], total, page, limit }
   *
   * Query params:
   *   employeeId  (required) — filter to a single employee's requests
   *   status      (optional) — filter to a specific lifecycle status
   *   page        (optional, default 1)
   *   limit       (optional, default 20, max 100)
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async listRequests(
    @Query("employeeId") employeeId: string,
    @Query("status") status?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    // Cap limit to prevent runaway queries.
    const safeLimit = Math.min(limit, 100);

    return this.timeOffService.listRequests(
      employeeId,
      status,
      page,
      safeLimit,
    );
  }
}
