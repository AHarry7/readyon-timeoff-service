import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { IdempotencyKey } from "src/database/entities";

/**
 * IdempotencyCleanupService
 *
 * Purges expired rows from the idempotency_keys table.
 * Without this job, the table grows unboundedly — every unique mutating
 * request permanently occupies a row.
 *
 * Schedule: every hour (EVERY_HOUR).
 * A 24-hour TTL means we only need to run this cleanup once per hour to
 * keep the table size proportional to the last 24 hours of traffic.
 *
 * The DELETE uses the idx_ik_expires index, making it an efficient range
 * delete even with millions of rows.
 *
 * Co-located in the OutboxModule because it shares the same scheduling
 * concern (background maintenance) and the same module lifecycle.
 */
@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly idempotencyRepo: Repository<IdempotencyKey>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredKeys(): Promise<void> {
    const now = new Date();

    try {
      const result = await this.idempotencyRepo.delete({
        expiresAt: LessThan(now),
      });

      const deleted = result.affected ?? 0;

      if (deleted > 0) {
        this.logger.log(
          `[IdempotencyCleanup] Purged ${deleted} expired key(s).`,
        );
      } else {
        this.logger.debug("[IdempotencyCleanup] No expired keys to purge.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[IdempotencyCleanup] Purge failed: ${msg}. Will retry on next hourly tick.`,
      );
    }
  }
}
