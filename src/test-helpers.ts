import { DataSource, EntityManager, QueryRunner } from "typeorm";
import { TimeOffBalance } from "./database/entities";
import { TimeOffRequest } from "./database/entities";
import { BalanceLedger } from "./database/entities";
import { OutboxEvent } from "./database/entities";
import {
  SyncSource,
  RequestStatus,
  OutboxStatus,
  OutboxEventType,
  LedgerEventType,
} from "./common/enums";

// ─────────────────────────────────────────────────────────────────────────────
// Entity builders
// All fields have sensible defaults so tests only override what they care about.
// ─────────────────────────────────────────────────────────────────────────────

export function makeBalance(
  overrides: Partial<TimeOffBalance> = {},
): TimeOffBalance {
  const b = new TimeOffBalance();
  b.id = "balance-001";
  b.employeeId = "emp-001";
  b.locationId = "loc-nyc";
  b.hcmBalance = 10;
  b.lastSyncedAt = new Date(Date.now() - 60_000); // 1 minute ago — fresh
  b.syncSource = SyncSource.REALTIME;
  b.version = 1;
  b.createdAt = new Date();
  b.updatedAt = new Date();
  return Object.assign(b, overrides);
}

export function makeRequest(
  overrides: Partial<TimeOffRequest> = {},
): TimeOffRequest {
  const r = new TimeOffRequest();
  r.id = "req-001";
  r.employeeId = "emp-001";
  r.locationId = "loc-nyc";
  r.daysRequested = 3;
  r.startDate = "2026-05-01";
  r.endDate = "2026-05-03";
  r.leaveType = "ANNUAL";
  r.status = RequestStatus.PENDING;
  r.submittedBy = "emp-001";
  r.reviewedBy = null;
  r.rejectionReason = null;
  r.idempotencyKey = "idem-key-001";
  r.hcmReferenceId = null;
  r.hcmErrorMessage = null;
  r.balanceSnapshot = 7;
  r.createdAt = new Date();
  r.updatedAt = new Date();
  return Object.assign(r, overrides);
}

export function makeLedgerRow(
  overrides: Partial<BalanceLedger> = {},
): BalanceLedger {
  const l = new BalanceLedger();
  l.id = "ledger-001";
  l.employeeId = "emp-001";
  l.locationId = "loc-nyc";
  l.delta = -3;
  l.eventType = LedgerEventType.RESERVATION_CREATED;
  l.referenceId = "req-001";
  l.notes = "Test ledger entry";
  l.createdAt = new Date();
  return Object.assign(l, overrides);
}

export function makeOutboxEvent(
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  const e = new OutboxEvent();
  e.id = "outbox-001";
  e.requestId = "req-001";
  e.eventType = OutboxEventType.APPLY;
  e.payload = JSON.stringify({
    employeeId: "emp-001",
    locationId: "loc-nyc",
    daysRequested: 3,
    leaveType: "ANNUAL",
    startDate: "2026-05-01",
    endDate: "2026-05-03",
    referenceId: "req-001",
  });
  e.idempotencyKey = "req-001:APPLY:1";
  e.status = OutboxStatus.PENDING;
  e.attemptCount = 0;
  e.maxAttempts = 5;
  e.lastAttemptedAt = null;
  e.nextAttemptAt = new Date();
  e.hcmResponse = null;
  e.createdAt = new Date();
  e.updatedAt = new Date();
  return Object.assign(e, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock DataSource / EntityManager factory
//
// TypeORM's DataSource.transaction() callback receives an EntityManager.
// We need to capture the callback and execute it with a mock manager so we
// can assert on what the service wrote inside the transaction.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockEntityManager {
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  createQueryBuilder: jest.Mock;
}

export function makeMockEntityManager(
  overrides: Partial<MockEntityManager> = {},
): MockEntityManager {
  return {
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((_, entity) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn().mockImplementation((_, dto) => ({ ...dto })),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

/**
 * Creates a DataSource mock whose transaction() method immediately invokes
 * the callback with the provided manager — no real DB connection needed.
 */
export function makeMockDataSource(
  manager: MockEntityManager,
): Partial<DataSource> {
  return {
    transaction: jest
      .fn()
      .mockImplementation(async (cb: (em: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    manager: manager as unknown as EntityManager,
  };
}

/**
 * Creates a TypeORM QueryBuilder stub that returns a fixed raw result.
 * Used to mock the COALESCE(SUM(...)) queries in both services.
 */
export function makeQueryBuilderStub(rawResult: Record<string, string>) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(rawResult),
  };
  return qb;
}
