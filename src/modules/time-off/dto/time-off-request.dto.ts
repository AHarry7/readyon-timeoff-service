// ─────────────────────────────────────────────────────────────────────────────
// DTOs for the Time-Off Request module
//
// Validation is applied via class-validator decorators.
// ValidationPipe must be registered globally in main.ts:
//   app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsString,
  IsNotEmpty,
  IsPositive,
  IsNumber,
  IsDateString,
  IsOptional,
  Min,
  IsIn,
} from 'class-validator';

// ── Submit ─────────────────────────────────────────────────────────────────

const ALLOWED_LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY'] as const;
export type LeaveType = typeof ALLOWED_LEAVE_TYPES[number];

export class SubmitRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsNumber()
  @IsPositive()
  @Min(0.5) // Minimum half-day request
  daysRequested: number;

  /**
   * ISO 8601 date string: 'YYYY-MM-DD'
   * Validated as a date string; business-rule check (start <= end) is
   * performed in the service layer where both values are in scope.
   */
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsString()
  @IsIn(ALLOWED_LEAVE_TYPES, {
    message: `leaveType must be one of: ${ALLOWED_LEAVE_TYPES.join(', ')}`,
  })
  leaveType: LeaveType;

  /** The employee submitting the request. */
  @IsString()
  @IsNotEmpty()
  submittedBy: string;
}

// ── Approve ────────────────────────────────────────────────────────────────

export class ApproveRequestDto {
  /** The managerId performing the approval. */
  @IsString()
  @IsNotEmpty()
  reviewedBy: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ── Reject ─────────────────────────────────────────────────────────────────

export class RejectRequestDto {
  /** The managerId performing the rejection. */
  @IsString()
  @IsNotEmpty()
  reviewedBy: string;

  @IsString()
  @IsNotEmpty({ message: 'A rejection reason is required.' })
  rejectionReason: string;
}

// ── Cancel ─────────────────────────────────────────────────────────────────

export class CancelRequestDto {
  /**
   * The actor cancelling the request.
   * Must match the original submittedBy for employee-initiated cancellations,
   * or be a manager ID for admin cancellations. Authorisation enforcement is
   * handled upstream by the API gateway / auth guard.
   */
  @IsString()
  @IsNotEmpty()
  cancelledBy: string;

  @IsString()
  @IsOptional()
  reason?: string;
}

// ── List query ─────────────────────────────────────────────────────────────

export class ListRequestsQueryDto {
  @IsString()
  @IsOptional()
  status?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number;
}
