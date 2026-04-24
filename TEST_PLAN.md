# Integration Test Plan
## Time-Off Microservice — All 10 TRD Edge Cases

**Framework**: Jest + Supertest  
**Test Type**: Integration (real SQLite DB, real Mock HCM server on localhost:4001)  
**Coverage Target**: All 10 edge cases from the TRD Failure Modes section

---

## Test Infrastructure Setup

### Global Setup (`jest.setup.ts`)

```typescript
// jest.setup.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';       // ReadyOn microservice
import { AppModule as MockHcmModule } from '../mock-hcm/src/app.module';

let readyOnApp: INestApplication;
let mockHcmApp: INestApplication;

export let api: request.SuperTest<request.Test>;    // ReadyOn
export let hcm: request.SuperTest<request.Test>;    // Mock HCM control plane

beforeAll(async () => {
  // 1. Start Mock HCM server
  const mockHcmFixture = await Test.createTestingModule({
    imports: [MockHcmModule],
  }).compile();
  mockHcmApp = mockHcmFixture.createNestApplication();
  await mockHcmApp.listen(4001);

  // 2. Start ReadyOn microservice (pointed at the mock)
  //    HCM_BASE_URL=http://localhost:4001 is set in jest.config.js env
  const readyOnFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  readyOnApp = readyOnFixture.createNestApplication();
  await readyOnApp.init();

  api = request(readyOnApp.getHttpServer());
  hcm = request(mockHcmApp.getHttpServer());
});

afterAll(async () => {
  await readyOnApp.close();
  await mockHcmApp.close();
});
```

### Per-Test Reset Helper

```typescript
// test/helpers/reset.ts
import { hcm } from '../jest.setup';

/**
 * Call in beforeEach. Resets mock HCM state and seeds standard fixtures.
 * The ReadyOn DB is reset separately via a test-specific SQLite in-memory DB.
 */
export async function resetAndSeed(balances: Array<{
  employeeId: string;
  locationId: string;
  availableDays: number;
}>) {
  await hcm
    .post('/mock/reset')
    .send({ seedBalances: balances.map(b => ({ ...b, leaveType: 'ANNUAL' })) })
    .expect(200);
}
```

### Standard Fixtures

```typescript
// test/fixtures.ts
export const EMP_A = 'emp_alice_001';
export const EMP_B = 'emp_bob_002';
export const LOC_NYC = 'loc_nyc';
export const LOC_SF  = 'loc_sf';

export const DEFAULT_BALANCE = 10; // days

export const makeRequest = (overrides = {}) => ({
  employeeId: EMP_A,
  locationId: LOC_NYC,
  leaveType: 'ANNUAL',
  startDate: '2025-08-01',
  endDate: '2025-08-03',
  daysRequested: 3,
  notes: 'Test vacation',
  ...overrides,
});
```

---

## Edge Case 1: Concurrent Requests Exhausting Balance (TOCTOU Race)

**TRD Reference**: Edge Case 1  
**What we're proving**: Two simultaneous submissions against a 5-day balance, each requesting 4 days, must result in exactly one approval and one rejection. SQLite's `BEGIN IMMEDIATE` serialisation is the guard.

### Test File: `test/edge-cases/ec1-concurrent-requests.spec.ts`

```typescript
describe('EC1: Concurrent requests exhausting balance', () => {
  const BALANCE = 5;
  const REQUEST_DAYS = 4; // Each request wants 4, only one can succeed

  beforeEach(async () => {
    await resetAndSeed([{ employeeId: EMP_A, locationId: LOC_NYC, availableDays: BALANCE }]);
    // Sync ReadyOn's local balance from mock HCM
    await api.post(`/hcm/sync/${EMP_A}/${LOC_NYC}`).expect(200);
  });

  it('should allow exactly one of two concurrent identical-sized requests', async () => {
    // ── Step 1: Fire both requests simultaneously ──────────────────────────
    // Promise.all preserves concurrency — both HTTP calls are in-flight before
    // either response is processed.
    const [res1, res2] = await Promise.all([
      api
        .post('/time-off/requests')
        .set('Idempotency-Key', 'idem-concurrent-001')
        .send(makeRequest({ daysRequested: REQUEST_DAYS })),
      api
        .post('/time-off/requests')
        .set('Idempotency-Key', 'idem-concurrent-002')
        .send(makeRequest({ daysRequested: REQUEST_DAYS })),
    ]);

    // ── Step 2: Exactly one must succeed, one must fail ───────────────────
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 422]);

    // ── Step 3: The successful request should show correct remaining balance
    const successResponse = [res1, res2].find(r => r.status === 201)!;
    expect(successResponse.body.remainingAfterRequest).toBe(BALANCE - REQUEST_DAYS); // 1 day

    // ── Step 4: The effective balance should now reflect only one reservation
    const balanceRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(balanceRes.body.effectiveBalance).toBe(BALANCE - REQUEST_DAYS); // 1 day remaining
    expect(balanceRes.body.reservedDays).toBe(REQUEST_DAYS); // 4 days reserved

    // ── Step 5: The failed request should carry the right error code
    const failResponse = [res1, res2].find(r => r.status === 422)!;
    expect(failResponse.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('should handle N=10 concurrent requests against a balance of 2 days (1-day each)', async () => {
    // Seed exactly 2 days; fire 10 x 1-day requests
    await resetAndSeed([{ employeeId: EMP_A, locationId: LOC_NYC, availableDays: 2 }]);
    await api.post(`/hcm/sync/${EMP_A}/${LOC_NYC}`).expect(200);

    const promises = Array.from({ length: 10 }, (_, i) =>
      api
        .post('/time-off/requests')
        .set('Idempotency-Key', `idem-mass-${i}`)
        .send(makeRequest({ daysRequested: 1 })),
    );

    const responses = await Promise.all(promises);
    const successes = responses.filter(r => r.status === 201);
    const failures  = responses.filter(r => r.status === 422);

    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(8);

    // Final effective balance must be 0, not negative
    const balanceRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(balanceRes.body.effectiveBalance).toBe(0);
    expect(balanceRes.body.effectiveBalance).toBeGreaterThanOrEqual(0);
  });

  it('should never produce a negative effective balance under any concurrency', async () => {
    // Property-based style: any combination of concurrent requests should leave
    // effectiveBalance >= 0. Run multiple rounds with different sizes.
    for (const [balance, requestDays, concurrency] of [
      [3, 2, 5],
      [10, 7, 3],
      [1, 1, 4],
    ]) {
      await resetAndSeed([{ employeeId: EMP_A, locationId: LOC_NYC, availableDays: balance }]);
      await api.post(`/hcm/sync/${EMP_A}/${LOC_NYC}`).expect(200);

      await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          api
            .post('/time-off/requests')
            .set('Idempotency-Key', `idem-prop-${balance}-${i}`)
            .send(makeRequest({ daysRequested: requestDays })),
        ),
      );

      const balRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
      expect(balRes.body.effectiveBalance).toBeGreaterThanOrEqual(0);
    }
  });
});
```

---

## Edge Case 2: HCM Timeout on Deduction

**TRD Reference**: Edge Case 2  
**What we're proving**: When HCM hangs, the request stays in `HCM_PENDING` (reservation held). The outbox worker retries with the same idempotency key. When HCM eventually recovers, the request finalises exactly once with no double-deduction.

### Test File: `test/edge-cases/ec2-hcm-timeout.spec.ts`

```typescript
describe('EC2: HCM timeout on deduction', () => {
  // Allow enough time for retry cycles; outbox poll interval = 500ms in test env
  jest.setTimeout(30_000);

  beforeEach(async () => {
    await resetAndSeed([{ employeeId: EMP_A, locationId: LOC_NYC, availableDays: 10 }]);
    await api.post(`/hcm/sync/${EMP_A}/${LOC_NYC}`).expect(200);
  });

  it('should leave request in HCM_PENDING while HCM is timing out', async () => {
    // ── Step 1: Inject TIMEOUT scenario into mock HCM ─────────────────────
    await hcm.post('/mock/config').send({ scenario: 'TIMEOUT' }).expect(200);

    // ── Step 2: Submit and approve request ────────────────────────────────
    const submitRes = await api
      .post('/time-off/requests')
      .set('Idempotency-Key', 'idem-timeout-001')
      .send(makeRequest({ daysRequested: 3 }))
      .expect(201);
    const requestId = submitRes.body.requestId;

    await api
      .patch(`/time-off/requests/${requestId}/approve`)
      .set('Idempotency-Key', 'idem-approve-timeout-001')
      .send({ reviewedBy: 'mgr_001' })
      .expect(200);

    // ── Step 3: Immediately after approval, status should be HCM_PENDING ──
    // The outbox worker will have tried to call HCM, but HCM timed out.
    // We must NOT have advanced to FINALIZED.
    // (Poll briefly — the outbox worker may need one tick to mark it.)
    await sleep(1000);
    const pendingRes = await api.get(`/time-off/requests/${requestId}`).expect(200);
    expect(pendingRes.body.status).toBe('HCM_PENDING');

    // ── Step 4: Reservation must still be held ────────────────────────────
    const balRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(balRes.body.reservedDays).toBe(3);
    expect(balRes.body.effectiveBalance).toBe(7); // 10 - 3 = 7

    // ── Step 5: Confirm outbox worker has retried (telemetry) ──────────────
    const telemetry = await hcm.get('/mock/telemetry').expect(200);
    expect(telemetry.body.apply).toBeGreaterThanOrEqual(1);
  });

  it('should finalise and not double-deduct when HCM recovers after timeout', async () => {
    // ── Step 1: Force TIMEOUT on first call only; recover on second ────────
    await hcm.post('/mock/config').send({
      scenario: 'TIMEOUT',
      triggerAfterCount: 1,  // Only the 1st apply call times out
    }).expect(200);

    // ── Step 2: Submit and approve ────────────────────────────────────────
    const submitRes = await api
      .post('/time-off/requests')
      .set('Idempotency-Key', 'idem-timeout-recovery-001')
      .send(makeRequest({ daysRequested: 3 }))
      .expect(201);
    const requestId = submitRes.body.requestId;

    await api
      .patch(`/time-off/requests/${requestId}/approve`)
      .set('Idempotency-Key', 'idem-approve-timeout-rec-001')
      .send({ reviewedBy: 'mgr_001' })
      .expect(200);

    // ── Step 3: Wait for outbox worker to retry and succeed ───────────────
    // 1st attempt: times out (35s mock delay → client 10s timeout → retry)
    // 2nd attempt: NORMAL → FINALIZED
    // In test env, outbox retry interval is 500ms; we poll for FINALIZED.
    await waitForStatus(requestId, 'FINALIZED', { pollMs: 500, timeoutMs: 25_000 });

    // ── Step 4: Check HCM received exactly 2 apply calls ──────────────────
    const telemetry = await hcm.get('/mock/telemetry').expect(200);
    expect(telemetry.body.apply).toBe(2); // 1 timeout + 1 success

    // ── Step 5: HCM balance should show exactly one deduction ─────────────
    const hcmBalance = await hcm.get(`/balance/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(hcmBalance.body.availableDays).toBe(7); // 10 - 3, NOT 10 - 6

    // ── Step 6: ReadyOn effective balance must agree ───────────────────────
    const balRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(balRes.body.effectiveBalance).toBe(7);
    expect(balRes.body.reservedDays).toBe(0); // reservation converted to finalized deduction
  });

  it('should transition to HCM_FAILED after exhausting max retry attempts', async () => {
    // ── Step 1: Force permanent SERVER_ERROR ──────────────────────────────
    await hcm.post('/mock/config').send({ scenario: 'SERVER_ERROR' }).expect(200);

    const submitRes = await api
      .post('/time-off/requests')
      .set('Idempotency-Key', 'idem-max-retry-001')
      .send(makeRequest({ daysRequested: 3 }))
      .expect(201);
    const requestId = submitRes.body.requestId;

    await api
      .patch(`/time-off/requests/${requestId}/approve`)
      .set('Idempotency-Key', 'idem-approve-max-retry-001')
      .send({ reviewedBy: 'mgr_001' })
      .expect(200);

    // ── Step 2: Wait for all retries to be exhausted ──────────────────────
    // max_attempts=5 in test config; each retry back-off is shortened to 200ms
    await waitForStatus(requestId, 'HCM_FAILED', { pollMs: 500, timeoutMs: 15_000 });

    // ── Step 3: Verify the request carries the error message ──────────────
    const req = await api.get(`/time-off/requests/${requestId}`).expect(200);
    expect(req.body.status).toBe('HCM_FAILED');
    expect(req.body.hcmErrorMessage).toBeTruthy();

    // ── Step 4: Reservation must still be held (not auto-released on FAILED)
    // Per TRD: we cannot tell if HCM applied it or not.
    const balRes = await api.get(`/balances/${EMP_A}/${LOC_NYC}`).expect(200);
    expect(balRes.body.reservedDays).toBe(3);
  });
});
```

---

## Edge Case 3: Batch Arrives Mid-Approval

**TRD Reference**: Edge Case 3  
**What we're proving**: A batch reset does not wipe active reservations. Effective balance = new HCM base − active reservations.

### Test Sequence Outline (`ec3-batch-mid-approval.spec.ts`)

```
beforeEach: Seed balance = 10 days. Sync ReadyOn.

Test: 'batch overwrite must not erase active reservation'

  Step 1: Submit 3-day request → status PENDING (reservation held)
  Step 2: Approve the request → status APPROVED (still not sent to HCM)

  Step 3: POST /hcm/batch with batchId='batch_annual_reset', availableDays=10
          (HCM reset to 10 — does NOT know about our pending 3-day reservation)

  Step 4: Assert GET /balances/EMP_A/LOC_NYC
          → hcmBalance = 10
          → reservedDays = 3
          → effectiveBalance = 7   ← must be 7, NOT 10

  Step 5: Assert outbox event still present (request not finalized yet)
  Step 6: Let outbox worker run → request reaches FINALIZED
          GET /balances → effectiveBalance = 7 (deduction confirmed, reservation cleared)

Test: 'batch with higher balance than current must not block approval'

  Step 1: Seed balance = 2 days
  Step 2: Submit 2-day request → PENDING
  Step 3: POST /hcm/batch with availableDays=15 (anniversary reset mid-flight)
  Step 4: Approve → APPROVED
  Step 5: Wait for FINALIZED
  Step 6: effectiveBalance = 15 - 2 = 13 ✓

Test: 'reconciliation flag raised when batch value < active reservations'

  Step 1: Seed balance = 10 days
  Step 2: Submit 8-day request → PENDING
  Step 3: POST /hcm/batch with availableDays=5 (HCM was manually reduced)
  Step 4: GET /balances → effectiveBalance = -3 is flagged as reconciliation case
          Assert response includes { reconciliationRequired: true }
  Step 5: Assert a balance_ledger entry with notes='RECONCILIATION_REQUIRED'
```

---

## Edge Case 4: HCM Rejects with No Reason Code / Ambiguous Error

**TRD Reference**: Edge Case 4  
**What we're proving**: Ambiguous HCM rejection → `HCM_FAILED`, reservation preserved, alert raised.

### Test Sequence Outline (`ec4-ambiguous-hcm-rejection.spec.ts`)

```
Test: 'SERVER_ERROR from HCM must not release reservation'

  Step 1: Seed balance = 10, sync ReadyOn
  Step 2: Inject scenario SERVER_ERROR (permanent)
  Step 3: Submit 3-day request → PENDING
  Step 4: Approve → APPROVED → outbox fires → HCM returns 500
  Step 5: After max_attempts exhausted → status = HCM_FAILED
  Step 6: GET /balances → reservedDays = 3 (NOT 0)
          effectiveBalance = 7 (reservation preserved)
  Step 7: hcmErrorMessage contains 'AMBIGUOUS' or 'INTERNAL_ERROR'

Test: 'INVALID_DIMENSION rejection must not release reservation'

  (Same sequence but scenario = INVALID_DIMENSION)
  Key assertion: reservation held because dimension error ≠ balance error.
  The balance may still be valid; HCM rejection may be transient.

Test: 'INSUFFICIENT_BALANCE rejection must release reservation'

  (Same sequence but scenario = INSUFFICIENT_BALANCE)
  Key assertion: after HCM_FAILED, status = HCM_FAILED,
                 but reservedDays = 0 (explicitly safe to release for 422-balance error).
  effectiveBalance returns to 10.
  [Note: This is the one case where we CAN release the reservation safely.]
```

---

## Edge Case 5: Anniversary Credit Between Submit and Approve

**TRD Reference**: Edge Case 5  
**What we're proving**: An HCM credit event mid-workflow must not block a valid approval. The system is safely pessimistic but not erroneously blocking.

### Test Sequence Outline (`ec5-anniversary-credit-mid-workflow.spec.ts`)

```
Test: 'anniversary credit mid-workflow does not block approval'

  Step 1: Seed balance = 5 days, sync ReadyOn
  Step 2: Submit 5-day request → PENDING (balance_snapshot = 5, effectiveBalance = 0)
  Step 3: POST /mock/events/anniversary-credit { creditDays: 5 }
          → HCM balance is now 10, but ReadyOn doesn't know yet
  Step 4: Manager approves → expect 200 (approval must succeed)
          effectiveBalance at this point = 5 - 5 = 0 (stale pessimistic view)
  Step 5: POST /hcm/sync/EMP_A/LOC_NYC → ReadyOn syncs; hcmBalance updates to 10
          effectiveBalance = 10 - 5 = 5 ✓
  Step 6: Wait for FINALIZED; final effectiveBalance = 5 ✓

Test: 'stale pessimistic balance does not cause false INSUFFICIENT_BALANCE rejection'

  Step 1: Seed balance = 3, sync ReadyOn (effectiveBalance = 3)
  Step 2: POST /mock/events/anniversary-credit { creditDays: 10 }  (HCM = 13)
  Step 3: Submit 8-day request → should SUCCEED (local says 3 but 8 > 3)
          Expect: 422 INSUFFICIENT_BALANCE (pessimistic — expected behaviour)
  Step 4: Sync ReadyOn → hcmBalance = 13, effectiveBalance = 13
  Step 5: Submit 8-day request again → should now SUCCEED
          [Validates that sync resolves the pessimism]
```

---

## Edge Case 6: Rejection After HCM Was Already Debited

**TRD Reference**: Edge Case 6  
**What we're proving**: Once a request is in `HCM_PENDING` or later, rejection attempts are blocked. The system surfaces a clear error.

### Test Sequence Outline (`ec6-reject-after-hcm-debit.spec.ts`)

```
Test: 'rejecting an HCM_PENDING request returns 409 INVALID_STATUS_TRANSITION'

  Step 1: Seed balance = 10, sync ReadyOn
  Step 2: Inject TIMEOUT on apply (so request stays in HCM_PENDING)
  Step 3: Submit 3-day request → PENDING
  Step 4: Approve → APPROVED → outbox fires → HCM times out → HCM_PENDING
  Step 5: PATCH /time-off/requests/:id/reject
          → Expect 409 { code: 'INVALID_STATUS_TRANSITION' }
  Step 6: Request status is still HCM_PENDING (unchanged)
  Step 7: Reservation still held (effectiveBalance = 7)

Test: 'rejecting a FINALIZED request returns 409'

  (Same but let HCM succeed → FINALIZED → then try reject)

Test: 'admin cancel endpoint creates compensating outbox event'

  Step 1: Let request reach FINALIZED
  Step 2: POST /admin/time-off/requests/:id/force-cancel
          → Expect 200; new outbox event with type='COMPENSATING_CREDIT'
  Step 3: Wait for outbox to fire POST /timeoff/cancel to HCM
  Step 4: HCM balance restored to 10
  Step 5: ReadyOn syncs; effectiveBalance = 10
```

---

## Edge Case 7: Batch with Null-Balance Employees

**TRD Reference**: Edge Case 7  
**What we're proving**: Null values in the batch payload are skipped, not treated as 0.

### Test Sequence Outline (`ec7-null-balance-batch.spec.ts`)

```
Test: 'null availableDays in batch is skipped, existing balance preserved'

  Step 1: Seed balance = 8 days, sync ReadyOn
  Step 2: Submit 3-day request → PENDING (effectiveBalance = 5)
  Step 3: POST /hcm/batch with:
          { balances: [{ employeeId: EMP_A, locationId: LOC_NYC, availableDays: null }] }
  Step 4: GET /balances → hcmBalance still 8 (null was skipped)
          effectiveBalance still 5 (reservation preserved)
  Step 5: Assert warning log entry in balance_ledger with event_type='HCM_SYNC_BATCH'
          and notes containing 'SKIPPED_NULL'

Test: 'explicit zero balance in batch is applied (not confused with null)'

  Step 1: Seed balance = 8 days
  Step 2: POST /hcm/batch with availableDays=0 (explicit zero)
  Step 3: GET /balances → hcmBalance = 0 (correctly applied)
  Step 4: Submit any request → expect 422 INSUFFICIENT_BALANCE
```

---

## Edge Case 8: Duplicate Batch Delivery

**TRD Reference**: Edge Case 8  
**What we're proving**: The same batch processed twice produces identical state (idempotent).

### Test Sequence Outline (`ec8-duplicate-batch.spec.ts`)

```
Test: 'second delivery of same batchId returns 409 and does not re-process'

  Step 1: Seed balance = 10, sync ReadyOn
  Step 2: Submit 3-day request → PENDING (effectiveBalance = 7)
  Step 3: POST /hcm/batch { batchId: 'batch_001', availableDays: 15 }
          → Expect 202 Accepted; hcmBalance = 15, effectiveBalance = 12

  Step 4: POST /hcm/batch { batchId: 'batch_001', availableDays: 15 } (DUPLICATE)
          → Expect 409 { code: 'DUPLICATE_BATCH' }

  Step 5: GET /balances → effectiveBalance still 12 (not re-applied as 15 - 3 = 12 again)
          hcmBalance still 15 (not double-credited to 20 or similar)
  Step 6: balance_ledger has exactly ONE entry with reference_id='batch_001'

Test: 'different batchId with same payload is processed normally'

  (Proves dedup is keyed on batchId, not content hash)
  Step 4: POST /hcm/batch { batchId: 'batch_002', availableDays: 15 }
          → Expect 202 (processed again, balance ledger gets second entry)
```

---

## Edge Case 9: Service Restart Mid-Outbox Flush

**TRD Reference**: Edge Case 9  
**What we're proving**: A crash after HCM confirmed but before `PROCESSED` is marked does not cause double-deduction on restart.

### Test Sequence Outline (`ec9-restart-mid-flush.spec.ts`)

```typescript
// This test manipulates the outbox table directly via a test helper endpoint
// or by using the TypeORM/Knex handle exposed in test mode.

Test: 'outbox row stuck in PROCESSING is retried safely after restart'

  Step 1: Seed balance = 10, sync ReadyOn
  Step 2: Submit 3-day request → PENDING
  Step 3: Approve → APPROVED → outbox creates event (status=PENDING)

  Step 4: Manually set outbox_events.status = 'PROCESSING' and
          last_attempted_at = NOW - 10 minutes (simulate crash mid-flush)
          Also set hcm_reference_id on the request to a value we seeded in
          the mock deductions store (simulate HCM already applied it)

  Step 5: Trigger outbox worker recovery (or wait for PROCESSING_TIMEOUT sweep)

  Step 6: Worker retries the call to HCM with same idempotencyKey
          → Mock HCM recognises idempotencyKey, returns cached success (200)

  Step 7: Outbox row → PROCESSED; request → FINALIZED
  Step 8: GET /balance/EMP_A/LOC_NYC (from mock HCM directly)
          → availableDays = 7 (deducted exactly ONCE)

Test: 'outbox worker does not process same event concurrently (SELECT FOR UPDATE emulation)'

  Step 1: Set outbox event status = 'PENDING'
  Step 2: Trigger two simultaneous outbox worker cycles (via test helper)
  Step 3: Assert HCM apply was called exactly once (telemetry.apply === 1)
  Step 4: Request reaches FINALIZED
```

---

## Edge Case 10: Employee Changes Location Mid-Request

**TRD Reference**: Edge Case 10  
**What we're proving**: Dimension mismatch at HCM triggers `HCM_FAILED`, not silent corruption.

### Test Sequence Outline (`ec10-location-change.spec.ts`)

```
Test: 'request for old location rejected by HCM as INVALID_DIMENSION → HCM_FAILED'

  Step 1: Seed balance for (EMP_A, LOC_NYC) = 10 days
  Step 2: Sync ReadyOn
  Step 3: Submit 3-day request for LOC_NYC → PENDING
  Step 4: Approve → APPROVED → outbox fires

  Step 5: Inject scenario INVALID_DIMENSION for EMP_A
          (simulating HR changed the employee's location in HCM to LOC_SF)

  Step 6: Wait for outbox to fire → HCM returns 422 INVALID_DIMENSION

  Step 7: After max_attempts → request = HCM_FAILED
          hcmErrorMessage contains 'INVALID_DIMENSION'

  Step 8: Reservation still held (per TRD policy: dimension error ≠ balance error)
          effectiveBalance = 7 (not restored to 10)

  Step 9: Confirm alert/log entry raised for manual HR resolution
```

---

## Additional Cross-Cutting Test Cases

### Idempotency Tests (`test/idempotency.spec.ts`)

```
Test: 'duplicate request submission with same Idempotency-Key returns original response'

  Step 1: POST /time-off/requests with key='idem-X' → 201 Created, requestId=R1
  Step 2: POST /time-off/requests with key='idem-X' (identical body) → 201, requestId=R1
          (same response, no new request created)
  Step 3: GET /time-off/requests → only 1 request in DB (not 2)
  Step 4: Assert response header Idempotency-Key-Hit: true on second call

Test: 'duplicate request with same key but different body returns ORIGINAL response'

  Step 2 sends different daysRequested. Should still return the original R1 response.
  (The key is the deduplication unit, not the body content.)

Test: 'outbound HCM calls carry unique idempotency keys per attempt'

  Let outbox retry 3 times. Assert each call carried a different key suffix (_v1, _v2, _v3).
```

### Real-Time Sync Staleness Tests (`test/sync/realtime-sync.spec.ts`)

```
Test: 'balance is refreshed from HCM when record is stale (>5 minutes)'

  Step 1: Set time_off_balances.last_synced_at = NOW - 10 minutes (via test helper)
  Step 2: POST /mock/events/anniversary-credit { creditDays: 5 }
  Step 3: GET /balances/EMP_A/LOC_NYC → should have triggered a sync
          → hcmBalance = original + 5
          → response header X-Balance-Stale must NOT be present

Test: 'balance is served stale with header when HCM is unreachable'

  Step 1: Inject SERVER_ERROR into mock HCM balance endpoint
  Step 2: Set record as stale
  Step 3: GET /balances → 200 OK (not a 503)
          Response header: X-Balance-Stale: true
          Body shows the old hcmBalance value
```

### Balance Ledger Audit Trail Tests (`test/ledger.spec.ts`)

```
Test: 'each request lifecycle step produces correct ledger entries'

  Submit → expect ledger entry: event_type=RESERVATION_CREATED, delta=-3
  Approve → no new ledger entry (approval is internal state only)
  Finalize → expect: RESERVATION_FINALIZED, delta=0 (reservation converted)
  Batch sync → expect: HCM_SYNC_BATCH, delta=+N

Test: 'ledger delta sum always equals effective_balance across the lifecycle'

  Assert invariant: hcm_balance + SUM(ledger deltas) == effective_balance
  at every transition step.
```

---

## Test Configuration

### `jest.config.js`

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: './test/global-setup.ts',
  globalTeardown: './test/global-teardown.ts',
  setupFilesAfterFramework: ['./test/jest.setup.ts'],
  testTimeout: 30000,  // Edge cases with retries need more time
  testPathPattern: 'test/edge-cases|test/idempotency|test/sync|test/ledger',
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
  // Environment variables injected for every test
  testEnvironmentOptions: {
    env: {
      HCM_BASE_URL: 'http://localhost:4001',
      HCM_TIMEOUT_MS: '10000',
      OUTBOX_POLL_INTERVAL_MS: '500',   // Faster in tests
      OUTBOX_MAX_ATTEMPTS: '5',
      OUTBOX_RETRY_BACKOFF_MS: '200',   // Shortened for tests
      OUTBOX_PROCESSING_TIMEOUT_MS: '5000',
      BALANCE_STALE_THRESHOLD_MS: '300000', // 5 minutes
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',          // In-memory DB per test run
    },
  },
};
```

### Shared Test Helpers (`test/helpers/`)

```typescript
// test/helpers/wait.ts

/** Poll GET /time-off/requests/:id until status matches or timeout */
export async function waitForStatus(
  requestId: string,
  expectedStatus: string,
  options = { pollMs: 500, timeoutMs: 20_000 },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const res = await api.get(`/time-off/requests/${requestId}`);
    if (res.body.status === expectedStatus) return;
    await sleep(options.pollMs);
  }
  throw new Error(`Timed out waiting for request ${requestId} to reach status ${expectedStatus}`);
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
```

---

## Coverage Targets

| Edge Case | Happy Path | Sad Path | Idempotency | Concurrency |
|---|---|---|---|---|
| EC1 Concurrent Requests | ✓ | ✓ | N/A | ✓ (N=10) |
| EC2 HCM Timeout | ✓ recovery | ✓ max retries | ✓ same key | ✓ |
| EC3 Batch Mid-Approval | ✓ | ✓ recon flag | ✓ dupe batch | ✓ |
| EC4 Ambiguous Rejection | N/A | ✓ per error type | N/A | N/A |
| EC5 Anniversary Credit | ✓ | ✓ pessimism | N/A | N/A |
| EC6 Reject After Debit | N/A | ✓ 409 | N/A | N/A |
| EC7 Null Balance | N/A | ✓ skip | N/A | N/A |
| EC8 Duplicate Batch | ✓ first | ✓ dupe → 409 | ✓ | N/A |
| EC9 Restart Mid-Flush | ✓ recovery | N/A | ✓ HCM key | ✓ |
| EC10 Location Change | N/A | ✓ HCM_FAILED | N/A | N/A |
| **Total** | **7** | **10** | **5** | **4** |

**Estimated test count**: ~45 individual `it()` blocks across 12 test files.

---

*Test Plan Version 1.0 — Ready for implementation once the main ReadyOn microservice is built.*
