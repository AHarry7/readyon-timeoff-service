# ReadyOn Time-Off Microservice

A highly resilient, enterprise-grade Time-Off orchestration microservice. This service bridges the gap between a fast, highly available user experience and a slow, potentially unreliable downstream Human Capital Management (HCM) system.

## 🏗️ Architecture & Design Decisions

This microservice implements the **Ledger + Transactional Outbox Pattern** to guarantee eventual consistency without sacrificing immediate user feedback or risking double-deductions.

1. **The Transactional Outbox:** When a manager approves a request, the `status` update and the `OutboxEvent` creation happen in the exact same SQLite transaction. If the app crashes milliseconds later, the approval intent is durably saved. A background `@Cron()` worker polls this outbox to communicate with the HCM, applying exponential backoff for transient network errors.
2. **Append-Only Ledger:** Every mutation to an employee's balance (real-time syncs, batch syncs, reservations, cancellations) is recorded as an immutable row in the `balance_ledger` for perfect auditability.
3. **SQLite WAL Mode:** We utilize Write-Ahead Logging (`WAL`) to ensure the background outbox worker doesn't lock the database and block incoming API requests.
4. **Authoritative HCM Self-Correction:** When the HCM finally processes an outbox deduction, we update our local cache using the `remainingBalance` returned by the HCM, ensuring our system heals any state drift automatically.

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- npm

### 1. Boot the Mock HCM Server

This project includes a fully functional, stateful Mock HCM server to test against. Open your terminal and run:

```bash
cd mock-hcm
npm install
npm run start:dev

The mock server will run on http://localhost:4001
```

### 2. Boot the Main Microservice

Open a split terminal (leave the mock server running) and start the main app from the project root.

```bash
npm install
npm run start:dev

The main service will run on http://localhost:3000
```

### 3. The "Golden Path" Walkthrough

You can test the entire lifecycle using these curl commands in a third terminal window.

#### 1. Seed the Mock HCM

Give Alice 15 days of vacation in New York.

```bash
curl -X POST http://localhost:4001/mock/seed \
-H "Content-Type: application/json" \
-d "{\"employeeId\": \"emp_alice\", \"locationId\": \"loc_nyc\", \"availableDays\": 15}"
```

#### 2. Check Effective Balance (Main App)

Notice how this triggers a real-time sync with the Mock HCM and caches the value locally.

```bash
curl http://localhost:3000/balances/emp_alice/loc_nyc
```

#### 3. Submit a Request

Alice requests 5 days off. Notice the balance instantly reserves the days.

```bash
curl -X POST http://localhost:3000/requests \
-H "Content-Type: application/json" \
-H "Idempotency-Key: alice-req-001" \
-d "{\"employeeId\": \"emp_alice\", \"locationId\": \"loc_nyc\", \"daysRequested\": 5, \"leaveType\": \"ANNUAL\", \"startDate\": \"2026-05-01\", \"endDate\": \"2026-05-05\", \"submittedBy\": \"emp_alice\"}"

(Copy the id from the response for the next step!)
```

#### 4. Approve the Request

The manager approves the request. This transactionally writes to the Outbox.

```bash
curl -X PATCH http://localhost:3000/requests/<PASTE_REQUEST_ID_HERE>/approve \
-H "Content-Type: application/json" \
-H "Idempotency-Key: mgr-approve-001" \
-d "{\"reviewedBy\": \"mgr_bob\"}"
```

#### 5. Verify the Outbox Worker Succeeded

Wait about 10 seconds for the Cron worker to fire, then check the Mock HCM telemetry. You will see apply: 1, proving the worker successfully synced the approval in the background!

```bash
curl http://localhost:4001/mock/telemetry
```

### 4. Test Coverage

This project includes a comprehensive Jest unit test suite that heavily mocks the TypeORM DataSource to verify the exact atomicity of our transactions.

To run the test suite and view the coverage report:

```bash
npx jest --coverage

Coverage reports are generated under coverage/ and printed to terminal.
```

#### Coverage Report

----------------------|---------|----------|---------|---------|-----------------------------
File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
----------------------|---------|----------|---------|---------|-----------------------------
All files | 96.6 | 85.55 | 100 | 96.53 |  
 balances | 100 | 91.66 | 100 | 100 |  
 balances.service.ts | 100 | 91.66 | 100 | 100 | 189,380-423  
 time-off | 94.48 | 81.48 | 100 | 94.4 |  
 time-off.service.ts | 94.48 | 81.48 | 100 | 94.4 | 136,283,402,504,507,673,677
----------------------|---------|----------|---------|---------|-----------------------------
Test Suites: 2 passed, 2 total
Tests: 71 passed, 71 total
Snapshots: 0 total
Time: 3.626 s, estimated 5 s
Ran all test suites.
