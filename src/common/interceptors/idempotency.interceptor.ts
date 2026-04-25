import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan } from "typeorm";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import { Request, Response } from "express";
import { IdempotencyKey } from "../../database/entities/idempotency-key.entity";

/**
 * HTTP methods that require an Idempotency-Key header.
 * GET requests are read-only and inherently idempotent — no key needed.
 */
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * IdempotencyInterceptor
 *
 * Applied globally via APP_INTERCEPTOR in AppModule. Handles three cases
 * for every inbound mutating request:
 *
 *  A. REPLAY  — Key exists in DB, not expired:
 *       Return the cached HTTP response immediately.
 *       The real handler is NEVER called.
 *       Sets `Idempotency-Replay: true` header so clients can detect replays.
 *
 *  B. NEW     — Key does not exist (or was expired and pruned):
 *       Execute the real handler.
 *       On success: persist { key, endpoint, response body, status code } to DB.
 *       On error: do NOT cache. Client must retry with a new key or same key.
 *
 *  C. CONFLICT — Key exists but was used for a different endpoint:
 *       Return 409. A key is scoped to exactly one (key, endpoint) pair.
 *
 * ENDPOINT IDENTITY:
 *  We use `request.route.path` (the Express route template, e.g.
 *  `/api/v1/requests/:id/approve`) rather than `request.path` (the resolved
 *  URL, e.g. `/api/v1/requests/req_123/approve`). This prevents a client
 *  from reusing the same key for operations on *different* resources by
 *  varying the :id segment, while still allowing a genuine retry of the
 *  exact same operation on the same resource.
 *
 * TTL:
 *  Keys expire 24 hours after creation. A scheduled cleanup job
 *  (IdempotencyCleanupTask) prunes expired rows; the interceptor also prunes
 *  eagerly on first encounter of an expired key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly TTL_MS = 24 * 60 * 60_000; // 24 hours

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly idempotencyRepo: Repository<IdempotencyKey>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // ── Pass-through for non-mutating methods ──────────────────────────────
    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    const key = request.headers["idempotency-key"] as string | undefined;

    if (!key) {
      throw new BadRequestException(
        "Idempotency-Key header is required for all mutating requests. " +
          "Generate a UUID v4 and supply it on every POST, PATCH, and DELETE call.",
      );
    }

    // Basic UUID v4 format validation — prevents clients from accidentally
    // sending meaningful values (like request IDs) as idempotency keys.
    if (!this.isValidUuidV4(key)) {
      throw new BadRequestException(
        `Idempotency-Key "${key}" is not a valid UUID v4. ` +
          "Generate a fresh UUID v4 for each logical operation.",
      );
    }

    // Derive the endpoint template from the Express route definition.
    // Falls back to the raw path if the route hasn't been resolved yet
    // (e.g. during 404 handling — in practice this branch is never reached
    // for valid routes because NestJS resolves routes before interceptors run).
    const routeTemplate: string =
      (request as Request & { route?: { path?: string } }).route?.path ??
      request.path;
    const endpoint = `${request.method} ${routeTemplate}`;

    // Defer to async implementation so we can use await cleanly.
    return this.handleAsync(key, endpoint, response, next);
  }

  // ── Core async logic ────────────────────────────────────────────────────────

  /**
   * Wraps the async idempotency logic in an Observable so NestJS's reactive
   * pipeline receives a proper Observable regardless of which branch executes.
   *
   * We convert a Promise<Observable> → Observable via `from()` implicitly by
   * returning the inner Observable from within an async IIFE wrapped in `of()`.
   * The cleaner pattern here is to return a `new Observable(subscriber => ...)`,
   * but the approach below keeps the code readable by staying in async/await.
   */
  private handleAsync(
    key: string,
    endpoint: string,
    response: Response,
    next: CallHandler,
  ): Observable<unknown> {
    // We return a new Observable that drives its lifecycle from an async fn.
    // This is the idiomatic way to bridge async/await and RxJS in NestJS.
    return new Observable((subscriber) => {
      this.processIdempotency(key, endpoint, response, next)
        .then((obs$) => {
          obs$.subscribe({
            next: (val) => subscriber.next(val),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
        })
        .catch((err) => subscriber.error(err));
    });
  }

  private async processIdempotency(
    key: string,
    endpoint: string,
    response: Response,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const existing = await this.idempotencyRepo.findOne({ where: { key } });

    // ── Case C: Key reused for a different endpoint ──────────────────────
    if (existing && existing.endpoint !== endpoint) {
      throw new ConflictException(
        `Idempotency-Key "${key}" was already used for "${existing.endpoint}". ` +
          "Each key must be unique per logical operation. Generate a new UUID v4.",
      );
    }

    // ── Case A (expired): Prune and fall through to Case B ───────────────
    if (existing && new Date(existing.expiresAt) <= new Date()) {
      this.logger.debug(
        `Pruning expired idempotency key "${key}" (expired ${existing.expiresAt})`,
      );
      await this.idempotencyRepo.delete({ key });
      // Fall through to Case B — treat as a new request.
    }

    // ── Case A (valid): Replay the cached response ────────────────────────
    else if (existing) {
      this.logger.debug(
        `Replaying cached response for idempotency key "${key}" (${endpoint})`,
      );

      // Set the original status code and the replay indicator header before
      // returning the cached body. NestJS will serialise the returned object
      // as the response body with the status code we set here.
      response.status(existing.statusCode);
      response.setHeader("Idempotency-Replay", "true");

      return of(JSON.parse(existing.response));
    }

    // ── Case B: New request — execute handler and cache the result ─────────
    return next.handle().pipe(
      tap({
        next: (responseBody: unknown) => {
          // `tap` runs after the handler resolves. `responseBody` is the
          // object returned by the controller method, before serialisation.
          // We only cache 2xx responses (status code < 300).
          const statusCode = response.statusCode;

          if (statusCode < 300) {
            const entry = this.idempotencyRepo.create({
              key,
              endpoint,
              response: JSON.stringify(responseBody),
              statusCode,
              expiresAt: new Date(Date.now() + this.TTL_MS),
            });

            // Fire-and-forget: we cannot await inside tap() because the
            // observable stream has already emitted. A failure here means
            // the key is not cached — the next request with this key will
            // simply re-execute. This is a safe degradation (at-most-once
            // cache write) and is preferable to blocking the response stream.
            this.idempotencyRepo.save(entry).catch((err: Error) => {
              this.logger.error(
                `Failed to persist idempotency key "${key}": ${err.message}`,
              );
            });
          }
        },
        error: () => {
          // Do NOT cache error responses. The client must retry. The unique
          // constraint on the key column means a failed request leaves no
          // trace in the idempotency table, allowing a clean retry.
        },
      }),
    );
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private isValidUuidV4(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
