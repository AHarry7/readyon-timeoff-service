# Technical Requirement Document (TRD)
## Time-Off Microservice — ReadyOn Platform

| Field | Value |
|---|---|
| **Document Version** | 1.0.0 |
| **Status** | Draft — For Review |
| **Author** | Senior Backend Architect |
| **Stack** | NestJS · SQLite · TypeScript |
| **Last Updated** | 2025 |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Data Model](#3-data-model)
4. [API Contract](#4-api-contract)
5. [Sync Strategy](#5-sync-strategy)
6. [Idempotency Guarantees](#6-idempotency-guarantees)
7. [Failure Modes & Edge Cases](#7-failure-modes--edge-cases)
8. [Alternatives Considered](#8-alternatives-considered)

---

## 1. Executive Summary

### 1.1 Purpose

This document defines the architecture, data model, API contract, sync strategy, and failure-handling policy for the **Time-Off Microservice** — the component of the ReadyOn platform responsible for managing employee time-off requests and keeping leave balances consistent with an external Human Capital Management (HCM) system (e.g., Workday, SAP SuccessFactors).

### 1.2 The Core Problem

The HCM system is the contractual source of truth for leave balances. However, providing employees with "instant feedback" on their balance and request status requires ReadyOn to maintain a local representation of that truth. This creates a **dual-write problem**: two systems can mutate the same logical value (an employee's leave balance for a given location) independently and concurrently.

The four root causes of divergence are:

1. **External HCM writes** — work-anniversary credits, year-start resets, and manual HR adjustments happen directly in HCM without ReadyOn's knowledge.
2. **In-flight ReadyOn requests** — a request approved locally but not yet confirmed by HCM represents a "phantom deduction" that neither system has fully committed.
3. **Network and HCM failures** — HCM may timeout or return ambiguous errors, leaving the system uncertain whether a deduction was applied.
4. **Unreliable HCM validation** — HCM may silently accept requests against insufficient balances, so ReadyOn cannot outsource its integrity checks entirely.

### 1.3 Solution Summary

The microservice employs a **Reservation Ledger with Transactional Outbox** pattern:

- All balance mutations are recorded as immutable ledger entries, never as in-place updates to a single integer.
- Time-off requests pass through a five-stage state machine (`PENDING → APPROVED → HCM_PENDING → FINALIZED | HCM_FAILED`).
- Every outbound HCM call is first persisted as an outbox event in the same SQLite transaction as the local state change, guaranteeing at-least-once delivery without data loss.
- Batch syncs from HCM are merged against active reservations rather than blindly overwriting the local balance.

### 1.4 Out of Scope

- Authentication and authorization of human users (handled by ReadyOn's API Gateway).
- Push notifications to employees and managers.
- Multi-currency or fractional-day handling beyond standard decimal precision.
- Multi-tenancy partitioning (tenantId is acknowledged but not modelled in this version).

---

## 2. System Architecture

### 2.1 Architectural Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Time-Off Microservice                             │
│                                                                         │
│  ┌──────────────────┐   ┌─────────────────────┐   ┌─────────────────┐  │
│  │   REST API Layer  │   │   Domain Service    │   │  Outbox Worker  │  │
│  │                  │──▶│                     │──▶│                 │  │
│  │  /time-off/*     │   │  BalanceService     │   │  Polls outbox   │  │
│  │  /balances/*     │   │  RequestService     │   │  Calls HCM      │  │
│  │  /hcm/batch      │   │  SyncService        │   │  Marks done     │  │
│  └──────────────────┘   └─────────────────────┘   └────────┬────────┘  │
│                                    │                        │           │
│                         ┌──────────▼────────────────────────▼────────┐  │
│                         │              SQLite Database               │  │
│                         │                                            │  │
│                         │  time_off_balances   balance_ledger        │  │
│                         │  time_off_requests   outbox_events         │  │
│                         │  hcm_batch_snapshots idempotency_keys      │  │
│                         └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┬──────────────────────┘
                                                   │ HTTPS
                               ┌───────────────────▼────────────────────┐
                               │              HCM System                │
                               │  GET  /balance/:employeeId/:locationId │
                               │  POST /timeoff/apply                   │
                               │  POST /timeoff/cancel                  │
                               │  POST /readyon/batch  (inbound)        │
                               └────────────────────────────────────────┘
```

### 2.2 The Reservation Ledger Pattern

Rather than storing a single mutable balance integer, the system maintains:

1. **`time_off_balances`** — a per-employee-per-location record holding the last HCM-confirmed base balance and its sync timestamp.
2. **`balance_ledger`** — an append-only log of every mutation (HCM sync, reservation creation, reservation release, final deduction).
3. **Computed effective balance** — derived on read, never stored:

```
effective_balance
  = hcm_synced_balance
  - SUM(days_requested) WHERE status IN ('PENDING', 'APPROVED', 'HCM_PENDING')
```

This approach has three critical properties:

- **No double-spend**: a request can only be submitted if `effective_balance >= requested_days` at the time of check, enforced inside a SQLite `BEGIN IMMEDIATE` transaction.
- **HCM independence**: local consistency holds even if HCM is unreachable, because the reservation is the guard.
- **Full auditability**: every balance change has a timestamped, sourced ledger entry.

### 2.3 The Transactional Outbox Pattern

Outbound calls to HCM must not be made inside the database transaction that records the local state change. Doing so creates an irreversible coupling: if HCM succeeds but the DB commit fails (or vice versa), the systems diverge with no recovery path.

Instead:

1. **Within the same SQLite transaction** that changes a request's status, a row is inserted into `outbox_events` describing the intended HCM call.
2. The transaction is committed. At this point, the local state and the intent to call HCM are durably stored together.
3. A background **Outbox Worker** (a NestJS scheduled task) polls `outbox_events` for unprocessed rows and executes the HCM call.
4. On HCM success: the outbox row is marked `PROCESSED`; the request transitions to `FINALIZED`.
5. On HCM failure: the outbox row is marked `FAILED` (after exhausting retries); the request transitions to `HCM_FAILED` and an alert is raised for manual review.

```
DB Transaction:
  UPDATE time_off_requests SET status = 'APPROVED' WHERE id = ?
  INSERT INTO outbox_events (request_id, payload, status) VALUES (?, ?, 'PENDING')
COMMIT;

-- Later, asynchronously:
Outbox Worker:
  SELECT * FROM outbox_events WHERE status = 'PENDING' LIMIT 10
  → POST /timeoff/apply to HCM
  → UPDATE outbox_events SET status = 'PROCESSED' WHERE id = ?
  → UPDATE time_off_requests SET status = 'FINALIZED' WHERE id = ?
```

### 2.4 Request State Machine

```
                      ┌──────────┐
  Employee submits ──▶│  PENDING  │◀── balance reserved at this point
                      └─────┬────┘
                    approve │   │ reject
                            │   └─────────────────────────────────┐
                      ┌─────▼────┐                                │
                      │ APPROVED │  (local only, not yet in HCM)  │
                      └─────┬────┘                                ▼
              outbox event  │                           ┌──────────────────┐
              created       │                           │    REJECTED      │
                      ┌─────▼──────┐                   │ (reservation     │
                      │ HCM_PENDING│                   │  released)       │
                      └─────┬──┬───┘                   └──────────────────┘
             HCM success    │  │  HCM error / exhausted retries
                      ┌─────▼┐ └────────────────────────────────────┐
                      │FINAL-│                                       ▼
                      │IZED  │                           ┌──────────────────┐
                      └──────┘                           │   HCM_FAILED     │
                                                         │ (alert + manual) │
                                                         └──────────────────┘
```

**Terminal states**: `FINALIZED`, `REJECTED`, `HCM_FAILED`
**Active reservation states**: `PENDING`, `APPROVED`, `HCM_PENDING`

---

## 3. Data Model

All tables use SQLite. Foreign keys are enforced with `PRAGMA foreign_keys = ON`.

### 3.1 `time_off_balances`

Stores the last HCM-confirmed base balance per employee per location. This is the anchor for all effective-balance calculations.

```sql
CREATE TABLE time_off_balances (
  id              TEXT        PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  employee_id     TEXT        NOT NULL,
  location_id     TEXT        NOT NULL,
  hcm_balance     REAL        NOT NULL DEFAULT 0,        -- last confirmed days from HCM
  last_synced_at  DATETIME    NOT NULL,                  -- when HCM last confirmed this value
  sync_source     TEXT        NOT NULL                   -- 'REALTIME' | 'BATCH' | 'MANUAL'
                  CHECK (sync_source IN ('REALTIME', 'BATCH', 'MANUAL')),
  version         INTEGER     NOT NULL DEFAULT 1,        -- optimistic lock counter
  created_at      DATETIME    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      DATETIME    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (employee_id, location_id)
);

CREATE INDEX idx_tob_employee ON time_off_balances (employee_id);
```

### 3.2 `time_off_requests`

The central table. Each row represents a single time-off request and carries its full lifecycle state.

```sql
CREATE TABLE time_off_requests (
  id                  TEXT     PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  employee_id         TEXT     NOT NULL,
  location_id         TEXT     NOT NULL,
  days_requested      REAL     NOT NULL CHECK (days_requested > 0),
  start_date          DATE     NOT NULL,
  end_date            DATE     NOT NULL,
  leave_type          TEXT     NOT NULL,                 -- e.g. 'ANNUAL', 'SICK', 'UNPAID'
  status              TEXT     NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN (
                        'PENDING', 'APPROVED', 'HCM_PENDING',
                        'FINALIZED', 'REJECTED', 'HCM_FAILED'
                      )),
  submitted_by        TEXT     NOT NULL,                 -- employeeId submitting
  reviewed_by         TEXT,                              -- managerId who approved/rejected
  rejection_reason    TEXT,
  idempotency_key     TEXT     NOT NULL UNIQUE,          -- client-generated UUID
  hcm_reference_id    TEXT,                              -- HCM's own ID once confirmed
  hcm_error_message   TEXT,                              -- stored if HCM_FAILED
  balance_snapshot    REAL     NOT NULL,                 -- effective_balance at time of submission
  created_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (employee_id, location_id)
    REFERENCES time_off_balances (employee_id, location_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_tor_employee_status ON time_off_requests (employee_id, status);
CREATE INDEX idx_tor_idempotency     ON time_off_requests (idempotency_key);
```

> **Note on `balance_snapshot`**: Recording the effective balance at submission time provides an audit trail and lets reconciliation jobs identify requests where the balance has since changed materially.

### 3.3 `balance_ledger`

Append-only. Every balance-affecting event is recorded here, regardless of source.

```sql
CREATE TABLE balance_ledger (
  id              TEXT     PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  employee_id     TEXT     NOT NULL,
  location_id     TEXT     NOT NULL,
  delta           REAL     NOT NULL,                     -- positive = credit, negative = debit
  event_type      TEXT     NOT NULL
                  CHECK (event_type IN (
                    'HCM_SYNC_REALTIME',
                    'HCM_SYNC_BATCH',
                    'RESERVATION_CREATED',
                    'RESERVATION_RELEASED',
                    'RESERVATION_FINALIZED',
                    'COMPENSATING_CREDIT',
                    'MANUAL_ADJUSTMENT'
                  )),
  reference_id    TEXT,                                  -- request_id or batch_snapshot_id
  notes           TEXT,
  created_at      DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bl_employee ON balance_ledger (employee_id, location_id, created_at);
```

### 3.4 `outbox_events`

Persists the intent to call HCM. The Outbox Worker reads and processes these rows asynchronously.

```sql
CREATE TABLE outbox_events (
  id                TEXT     PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  request_id        TEXT     NOT NULL REFERENCES time_off_requests(id),
  event_type        TEXT     NOT NULL
                    CHECK (event_type IN ('APPLY', 'CANCEL', 'COMPENSATING_CREDIT')),
  payload           TEXT     NOT NULL,                   -- JSON blob: HCM request body
  idempotency_key   TEXT     NOT NULL UNIQUE,            -- forwarded to HCM
  status            TEXT     NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  attempt_count     INTEGER  NOT NULL DEFAULT 0,
  max_attempts      INTEGER  NOT NULL DEFAULT 5,
  last_attempted_at DATETIME,
  next_attempt_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  hcm_response      TEXT,                                -- raw HCM response (for debugging)
  created_at        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oe_status_next ON outbox_events (status, next_attempt_at)
  WHERE status IN ('PENDING', 'PROCESSING');
```

**Retry back-off**: `next_attempt_at = now + 2^attempt_count minutes` (capped at 30 minutes).

### 3.5 `hcm_batch_snapshots`

Stores raw batch payloads from HCM for idempotency checking and debugging.

```sql
CREATE TABLE hcm_batch_snapshots (
  id           TEXT     PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  batch_id     TEXT     NOT NULL UNIQUE,               -- HCM-provided batch identifier
  received_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload      TEXT     NOT NULL,                      -- full JSON payload
  status       TEXT     NOT NULL DEFAULT 'RECEIVED'
               CHECK (status IN ('RECEIVED', 'PROCESSED', 'PARTIALLY_FAILED')),
  processed_at DATETIME,
  error_notes  TEXT
);
```

### 3.6 `idempotency_keys`

Deduplicates inbound requests to our own API (distinct from outbound HCM idempotency).

```sql
CREATE TABLE idempotency_keys (
  key          TEXT     PRIMARY KEY,
  endpoint     TEXT     NOT NULL,
  response     TEXT     NOT NULL,                      -- cached JSON response
  status_code  INTEGER  NOT NULL,
  expires_at   DATETIME NOT NULL
);

CREATE INDEX idx_ik_expires ON idempotency_keys (expires_at);
```

---

## 4. API Contract

### 4.1 ReadyOn Microservice Endpoints

**Base URL**: `/api/v1`

All responses include a `requestId` header (UUID) for correlation.

---

#### `GET /balances/:employeeId/:locationId`

Returns the effective balance for an employee at a location.

**Response `200 OK`**:
```json
{
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "hcmBalance": 15.0,
  "reservedDays": 3.0,
  "effectiveBalance": 12.0,
  "lastSyncedAt": "2025-06-15T08:00:00.000Z",
  "syncSource": "BATCH"
}
```

**Error Responses**:

| Status | Code | Condition |
|---|---|---|
| `404` | `BALANCE_NOT_FOUND` | No record for this employee/location combination |
| `503` | `HCM_UNAVAILABLE` | Real-time sync attempted but HCM did not respond |

---

#### `POST /time-off/requests`

Submit a new time-off request. Idempotent via `Idempotency-Key` header.

**Request Headers**:
```
Idempotency-Key: <client-generated UUID>
```

**Request Body**:
```json
{
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "leaveType": "ANNUAL",
  "startDate": "2025-07-01",
  "endDate": "2025-07-03",
  "daysRequested": 3.0,
  "notes": "Family vacation"
}
```

**Response `201 Created`**:
```json
{
  "requestId": "req_xyz789",
  "status": "PENDING",
  "effectiveBalanceAtSubmission": 12.0,
  "remainingAfterRequest": 9.0,
  "createdAt": "2025-06-20T10:00:00.000Z"
}
```

**Error Responses**:

| Status | Code | Condition |
|---|---|---|
| `409` | `DUPLICATE_REQUEST` | Same `Idempotency-Key` already processed |
| `422` | `INSUFFICIENT_BALANCE` | `effectiveBalance < daysRequested` |
| `422` | `INVALID_DATE_RANGE` | `endDate < startDate` or dates in the past |
| `422` | `INVALID_LEAVE_TYPE` | `leaveType` not recognised |
| `404` | `EMPLOYEE_BALANCE_NOT_FOUND` | No balance record exists for this employee/location |

> **Design note**: The request transitions to `PENDING` instantly. The employee sees their balance reduced immediately. The HCM call happens asynchronously after manager approval.

---

#### `PATCH /time-off/requests/:requestId/approve`

Manager approves a pending request. This creates the outbox event that will notify HCM.

**Request Headers**:
```
Idempotency-Key: <client-generated UUID>
```

**Request Body**:
```json
{
  "reviewedBy": "mgr_def456",
  "notes": "Approved"
}
```

**Response `200 OK`**:
```json
{
  "requestId": "req_xyz789",
  "status": "APPROVED",
  "updatedAt": "2025-06-21T09:00:00.000Z"
}
```

**Error Responses**:

| Status | Code | Condition |
|---|---|---|
| `404` | `REQUEST_NOT_FOUND` | No request with this ID |
| `409` | `INVALID_STATUS_TRANSITION` | Request is not in `PENDING` state |

---

#### `PATCH /time-off/requests/:requestId/reject`

Manager rejects a pending request. The reservation is immediately released.

**Request Body**:
```json
{
  "reviewedBy": "mgr_def456",
  "reason": "Team coverage conflict"
}
```

**Response `200 OK`**:
```json
{
  "requestId": "req_xyz789",
  "status": "REJECTED",
  "updatedAt": "2025-06-21T09:00:00.000Z"
}
```

---

#### `GET /time-off/requests/:requestId`

Retrieve a single request and its current lifecycle state.

**Response `200 OK`**:
```json
{
  "requestId": "req_xyz789",
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "status": "HCM_PENDING",
  "daysRequested": 3.0,
  "startDate": "2025-07-01",
  "endDate": "2025-07-03",
  "leaveType": "ANNUAL",
  "submittedAt": "2025-06-20T10:00:00.000Z",
  "hcmReferenceId": null,
  "hcmErrorMessage": null
}
```

---

#### `GET /time-off/requests`

List requests with optional filters.

**Query Parameters**:

| Parameter | Type | Description |
|---|---|---|
| `employeeId` | string | Filter by employee |
| `locationId` | string | Filter by location |
| `status` | string | Filter by status (comma-separated) |
| `from` | ISO date | Start date range |
| `to` | ISO date | End date range |
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Results per page (default: 20, max: 100) |

**Response `200 OK`**:
```json
{
  "data": [ /* array of request objects */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

---

#### `POST /hcm/batch` *(Inbound from HCM)*

HCM pushes a full corpus of balances. This endpoint is idempotent by `batchId`.

**Request Body**:
```json
{
  "batchId": "batch_20250101_annual_reset",
  "generatedAt": "2025-01-01T00:00:00.000Z",
  "balances": [
    {
      "employeeId": "emp_abc123",
      "locationId": "loc_nyc",
      "availableDays": 15.0,
      "leaveType": "ANNUAL"
    }
  ]
}
```

**Response `202 Accepted`**:
```json
{
  "batchId": "batch_20250101_annual_reset",
  "accepted": true,
  "message": "Batch queued for processing"
}
```

**Error Responses**:

| Status | Code | Condition |
|---|---|---|
| `409` | `DUPLICATE_BATCH` | `batchId` already processed |
| `400` | `INVALID_BATCH_PAYLOAD` | Schema validation failure |

---

#### `POST /hcm/sync/:employeeId/:locationId` *(Manual real-time sync trigger)*

Forces an immediate real-time sync from HCM for a specific employee/location. Intended for support tooling.

**Response `200 OK`**:
```json
{
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "previousBalance": 12.0,
  "newHcmBalance": 17.0,
  "syncedAt": "2025-06-21T10:00:00.000Z"
}
```

---

### 4.2 Mock HCM Endpoints

The mock HCM server is deployed as part of the test suite (NestJS application on a separate port). It simulates realistic HCM behaviour including occasional errors, delays, and work-anniversary credits.

**Base URL**: `http://mock-hcm:4001`

---

#### `GET /balance/:employeeId/:locationId`

Returns the HCM-side balance.

**Response `200 OK`**:
```json
{
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "availableDays": 15.0,
  "leaveType": "ANNUAL",
  "asOf": "2025-06-20T00:00:00.000Z"
}
```

**Simulated Error Scenarios** (controlled via mock config API):

| Scenario | Response |
|---|---|
| `BALANCE_NOT_FOUND` | `404 {"code": "BALANCE_NOT_FOUND"}` |
| `DIMENSION_INVALID` | `422 {"code": "INVALID_DIMENSION", "message": "Unknown locationId"}` |
| `SERVER_ERROR` | `500 {"code": "INTERNAL_ERROR"}` |
| `TIMEOUT` | No response for 30s |

---

#### `POST /timeoff/apply`

HCM processes a deduction request.

**Request Body**:
```json
{
  "idempotencyKey": "idem_req_xyz789_v1",
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "daysRequested": 3.0,
  "leaveType": "ANNUAL",
  "startDate": "2025-07-01",
  "endDate": "2025-07-03"
}
```

**Response `200 OK`**:
```json
{
  "hcmReferenceId": "hcm_ref_001",
  "status": "APPLIED",
  "remainingBalance": 12.0
}
```

**Simulated Error Scenarios**:

| Scenario | Response |
|---|---|
| `INSUFFICIENT_BALANCE` | `422 {"code": "INSUFFICIENT_BALANCE"}` |
| `SILENT_ACCEPT` | `200` (balance not actually deducted — simulates broken HCM) |
| `TIMEOUT` | No response |

---

#### `POST /timeoff/cancel`

HCM reverses a previously applied deduction (compensating transaction).

**Request Body**:
```json
{
  "idempotencyKey": "idem_cancel_req_xyz789_v1",
  "hcmReferenceId": "hcm_ref_001"
}
```

**Response `200 OK`**:
```json
{
  "status": "CANCELLED",
  "restoredBalance": 15.0
}
```

---

#### Mock Config API

The mock exposes a control plane for test scenarios:

```
POST /mock/config
{
  "scenario": "TIMEOUT" | "SERVER_ERROR" | "INSUFFICIENT_BALANCE" | "SILENT_ACCEPT" | "NORMAL",
  "targetEmployeeId": "emp_abc123",   // optional; if omitted, applies globally
  "triggerAfterCount": 2              // optional; trigger only on Nth call
}

POST /mock/events/anniversary-credit
{
  "employeeId": "emp_abc123",
  "locationId": "loc_nyc",
  "creditDays": 5.0
}
```

---

## 5. Sync Strategy

### 5.1 Two Sync Paths

The microservice ingests HCM balance data through two distinct channels, each with different characteristics:

| Dimension | Real-Time Sync | Batch Sync |
|---|---|---|
| **Trigger** | Employee views balance; manual support call | HCM-initiated push (year-start, anniversary) |
| **Scope** | Single employee/location | Entire workforce |
| **Frequency** | On demand | Daily / event-driven |
| **Latency** | High (blocking HCM call) | Low (async processing) |
| **Risk** | HCM SLA dependency | Overwrite-of-reservations risk |

### 5.2 Real-Time Sync

When an employee requests their balance and the local record is stale (configurable threshold, default: 5 minutes), the service issues a fresh `GET /balance/:employeeId/:locationId` call to HCM.

**Algorithm**:

```
1. Fetch record from time_off_balances WHERE employee_id = ? AND location_id = ?
2. IF not found OR last_synced_at < NOW - STALE_THRESHOLD:
   a. Call HCM GET /balance
   b. IF HCM responds successfully:
      - UPDATE time_off_balances SET hcm_balance = ?, last_synced_at = NOW, sync_source = 'REALTIME'
      - INSERT INTO balance_ledger (event_type = 'HCM_SYNC_REALTIME', delta = new_balance - old_balance)
   c. IF HCM times out or returns 5xx:
      - Serve stale local balance with a response header: X-Balance-Stale: true
      - Log warning; do NOT fail the request
3. Compute effective_balance = hcm_balance - SUM(active reservations)
4. Return effective_balance to caller
```

**Key design choice**: A stale balance is preferred over a failed request. The user sees a potentially slightly outdated number, but the system remains available.

### 5.3 Batch Sync

HCM posts a JSON payload containing balances for all employees. This is the primary mechanism for large-scale resets (e.g., January 1st annual leave refresh).

#### 5.3.1 Ingestion

```
POST /hcm/batch → receives payload
  IF batchId already in hcm_batch_snapshots → return 409 DUPLICATE_BATCH (idempotent)
  INSERT INTO hcm_batch_snapshots (batch_id, payload, status = 'RECEIVED')
  Return 202 Accepted immediately
```

#### 5.3.2 The Merge Algorithm

Batch processing runs asynchronously. For each `(employeeId, locationId)` pair in the batch:

```
BEGIN IMMEDIATE TRANSACTION;

1. Retrieve hcm_batch_value from the batch payload.
   IF hcm_batch_value IS NULL → skip this record, log warning (handles null-vs-zero edge case)

2. Load current time_off_balances record.
   old_hcm_balance = record.hcm_balance

3. Compute active_reservation_total:
   SELECT SUM(days_requested) FROM time_off_requests
   WHERE employee_id = ? AND location_id = ?
     AND status IN ('PENDING', 'APPROVED', 'HCM_PENDING')

4. Compute new_effective_balance:
   new_effective_balance = hcm_batch_value - active_reservation_total

5. Check for reconciliation flag:
   IF hcm_batch_value < active_reservation_total:
     -- The batch predates some of our approved requests.
     -- Do NOT reject. Flag for reconciliation review.
     INSERT INTO balance_ledger (event_type = 'HCM_SYNC_BATCH', notes = 'RECONCILIATION_REQUIRED', ...)

6. UPDATE time_off_balances:
   SET hcm_balance = hcm_batch_value,
       last_synced_at = batch.generatedAt,
       sync_source = 'BATCH',
       version = version + 1

7. INSERT INTO balance_ledger:
   (event_type = 'HCM_SYNC_BATCH',
    delta = hcm_batch_value - old_hcm_balance,
    reference_id = batch_snapshot_id)

COMMIT;
```

**Critical invariant**: The merge algorithm updates `hcm_balance` to the HCM-confirmed figure but does **not** touch or release reservations. The effective balance is always computed dynamically. This means:

- If HCM sends 10 days but we have a 3-day pending request, effective balance = 7. ✅
- If HCM sends 10 days, already accounting for a deduction we also have locally reserved, the employee will temporarily see 7 instead of 10. This is corrected when the reservation is finalized (outbox processes) and the ledger records the deduction. ✅ (slight pessimism, acceptable)
- If HCM sends 5 days but we have an 8-day pending request (impossible locally but possible if HCM was manually adjusted down), we flag it for reconciliation. ✅

#### 5.3.3 Duplicate Batch Protection

Duplicate detection uses `batch_id` as the primary key in `hcm_batch_snapshots`. If a duplicate is received:

- The endpoint returns `409 DUPLICATE_BATCH`.
- No processing occurs. The original batch result is preserved.

### 5.4 Stale Balance Policy

| Scenario | Behaviour |
|---|---|
| Balance record missing entirely | Trigger real-time HCM fetch; create record |
| Balance record older than STALE_THRESHOLD (5m) | Trigger real-time HCM fetch in background; serve current record with stale flag |
| HCM unreachable during fetch | Serve existing record; set `X-Balance-Stale: true` header |
| Batch received while real-time fetch in-flight | Last-write-wins on `time_off_balances`; ledger preserves both events |

---

## 6. Idempotency Guarantees

### 6.1 Inbound Request Idempotency (Client → ReadyOn)

All mutating endpoints (`POST /time-off/requests`, `PATCH .../approve`, `PATCH .../reject`) require an `Idempotency-Key` header.

**Processing logic**:

```
1. Hash(Idempotency-Key + endpoint + actorId) → lookup in idempotency_keys table
2. IF found AND not expired:
   a. Return cached response with status code (do NOT re-execute)
   b. Add header: Idempotency-Key-Hit: true
3. IF not found:
   a. Execute the operation
   b. Store response in idempotency_keys with TTL of 24 hours
   c. Return response
```

**Key generation guidance for clients**: Use `UUIDv4`. The key must be unique per logical operation, not per HTTP attempt.

**Expiry**: Records are purged after 24 hours by a scheduled cleanup job.

### 6.2 Outbound HCM Idempotency (ReadyOn → HCM)

Every call to HCM's mutation endpoints carries an `idempotencyKey` in the request body, constructed as:

```
{event_type}_{request_id}_{attempt_count}
e.g.: "APPLY_req_xyz789_v1"
```

**Why include `attempt_count`?** If the HCM rejects a request with a non-idempotency error on attempt 1, and the root cause is fixed (e.g., a dimension issue), attempt 2 must use a new key — otherwise HCM may return the cached failure response rather than re-evaluating.

**Outbox worker deduplication**: Before calling HCM, the worker sets `status = 'PROCESSING'` in the same transaction as reading the row. This prevents two concurrent worker instances from processing the same event (SQLite's single-writer guarantee makes this safe without additional locking).

**Crash recovery**: If the worker crashes after HCM confirms but before marking the outbox row `PROCESSED`, the next worker poll will find the row still in `PROCESSING`. The retry will re-send the same `idempotencyKey` to HCM. If HCM is properly idempotent, it returns the cached success. If HCM is not idempotent (a risk acknowledged in the spec), the worker detects a `200 OK` with a matching `hcmReferenceId` and deduplicates locally by checking `time_off_requests.hcm_reference_id`.

### 6.3 Batch Idempotency

The `batch_id` field in HCM batch payloads serves as the idempotency key. The `hcm_batch_snapshots` table has a `UNIQUE` constraint on `batch_id`. Any re-delivery of the same batch returns `409 DUPLICATE_BATCH` without triggering re-processing.

---

## 7. Failure Modes & Edge Cases

### 7.1 Failure Matrix: HCM Call Outcomes

| HCM Response | Local Balance OK? | System Action |
|---|---|---|
| `200 OK` | Yes | Transition to `FINALIZED`. Mark outbox `PROCESSED`. |
| `200 OK` | No (stale local) | Transition to `FINALIZED`. Flag employee for reconciliation review. |
| `422 INSUFFICIENT_BALANCE` | Yes | Transition to `HCM_FAILED`. Release reservation. Alert. Trigger real-time sync. |
| `422 INSUFFICIENT_BALANCE` | No | Transition to `HCM_FAILED`. Release reservation. No surprise — expected divergence. |
| `422 INVALID_DIMENSION` | Either | Transition to `HCM_FAILED`. Do **not** release reservation automatically. Alert for manual review (dimension issue ≠ balance issue). |
| `5xx Server Error` | Either | Increment `attempt_count`. Retry with exponential back-off. After `max_attempts`, transition to `HCM_FAILED`. Alert. |
| Timeout (no response) | Either | Treat as `5xx`. Retry. Idempotency key ensures no double-deduction. |
| `200 OK` (silent accept, no actual deduction) | Either | `FINALIZED` locally. A subsequent batch sync or real-time sync will reveal the discrepancy. Detected by balance ledger reconciliation job. |

### 7.2 Edge Case Catalogue

**Edge Case 1: Concurrent Requests Exhausting Balance (TOCTOU Race)**

Two requests arrive simultaneously. Both read `effectiveBalance = 5`. Both request 4 days. Both would pass the local check independently.

*Mitigation*: The submission endpoint opens a `BEGIN IMMEDIATE` transaction. SQLite serialises these. The first transaction commits, reducing the effective balance. The second transaction reads the updated effective balance (now 1 day) and rejects with `INSUFFICIENT_BALANCE`. The `version` field on `time_off_balances` provides a secondary optimistic-lock assertion.

---

**Edge Case 2: HCM Timeout on Deduction**

The outbox worker calls `POST /timeoff/apply`. HCM does not respond within 10 seconds.

*Mitigation*: The outbox row is left in `PROCESSING`. The worker's next poll cycle (after `next_attempt_at`) retries with the same `idempotencyKey`. The request stays in `HCM_PENDING` (reservation still held). After `max_attempts = 5` retries, the row transitions to `FAILED`, the request to `HCM_FAILED`, an alert fires, and the reservation is **not** released automatically (to avoid an employee re-submitting if the deduction actually landed in HCM).

---

**Edge Case 3: Batch Arrives Mid-Approval Workflow**

A 3-day request is in `APPROVED` state (reservation held, HCM call pending). A batch arrives saying the employee has 10 days.

*Mitigation*: The merge algorithm reads `active_reservation_total = 3`. It sets `hcm_balance = 10`. The effective balance is `10 - 3 = 7`, not 10. The reservation is preserved. When the outbox worker finalises the request, the effective balance becomes `10 - 3 = 7` (the deduction was already factored into the reservation). No double-count, no phantom balance.

---

**Edge Case 4: HCM Rejects with No Reason Code**

HCM returns a `422` with no meaningful body (or a generic error).

*Mitigation*: The worker cannot distinguish a balance error from a dimension error. Policy: transition the request to `HCM_FAILED` with `hcmErrorMessage = "AMBIGUOUS_HCM_ERROR"`. Preserve the reservation. Alert HR operations for manual resolution. Do **not** silently release the reservation, as that would allow the employee to re-submit against balance that may genuinely not exist.

---

**Edge Case 5: Work-Anniversary Credit Between Submit and Approve**

Employee submits with `effectiveBalance = 2`. An anniversary credit fires in HCM adding 5 days. Manager now sees `effectiveBalance = 7` (after next sync), but the request was submitted at 2.

*Mitigation*: No action needed. The `balance_snapshot` on the request records the 2-day balance at submission. The request is valid. The effective balance is higher than when submitted — approval is unambiguously correct. The system must not block valid approvals due to a pessimistic stale-balance view.

---

**Edge Case 6: Manager Rejects After HCM Was Already Debited**

Request is in `HCM_PENDING`. The outbox worker successfully calls HCM. Before the response is processed, the manager rejects the request via the UI (a race between the background worker and the manager action).

*Mitigation*: The `PATCH .../reject` endpoint checks request status. If status is `HCM_PENDING` or later, rejection is blocked — the status transition is no longer valid. The API returns `409 INVALID_STATUS_TRANSITION`. The manager is shown a message: "This request has been sent to the HR system and can no longer be rejected here. Contact HR to initiate a cancellation." A compensating `CANCEL` outbox event can be created manually by an admin endpoint.

---

**Edge Case 7: Batch with Null-Balance Employees**

The HCM batch payload contains `"availableDays": null` for some employees (e.g., new hires with no leave accrued yet).

*Mitigation*: The merge algorithm explicitly skips records where `hcm_batch_value IS NULL` and logs a warning. It does **not** treat `null` as `0`. A zero balance must be sent explicitly as `"availableDays": 0` by HCM.

---

**Edge Case 8: Duplicate Batch Delivery**

HCM re-sends the same batch (e.g., due to a delivery retry on their side).

*Mitigation*: The `batch_id` unique constraint on `hcm_batch_snapshots` prevents re-processing. The endpoint returns `409 DUPLICATE_BATCH`. No balance rows are touched.

---

**Edge Case 9: Service Restart Mid-Outbox Flush**

The outbox worker reads an event, sets it to `PROCESSING`, calls HCM (which succeeds), then crashes before it can write `PROCESSED`.

*Mitigation*: On restart, the worker finds rows stuck in `PROCESSING` for longer than `PROCESSING_TIMEOUT` (e.g., 5 minutes). It resets them to `PENDING` for retry. The retry sends the same `idempotencyKey`. If HCM already applied the deduction, it returns the cached success response. The worker processes the success response normally and advances the request to `FINALIZED`. No double-deduction occurs.

---

**Edge Case 10: Employee Changes Location Mid-Request**

An employee has a `PENDING` request for `(emp_abc123, loc_nyc)`. HR changes their location in HCM to `loc_sf`.

*Mitigation*: The dimension `(employeeId, locationId)` is fixed at submission time and stored on the request. When the outbox worker calls HCM with `locationId = loc_nyc`, HCM may return `422 INVALID_DIMENSION`. The system handles this as Edge Case 4 (ambiguous rejection → `HCM_FAILED` → alert). HR must resolve the request manually, as the business logic (was the request for the old location still valid?) is outside the scope of this service.

---

## 8. Alternatives Considered

### 8.1 Alternative: Synchronous Blocking HCM Call on Every Request

**Description**: On every balance read and every request submission, make a live, blocking call to HCM. No local balance store. HCM is the single source of truth at all times.

**Analysis**:

| Dimension | Synchronous Approach | Outbox + Ledger Approach |
|---|---|---|
| **Consistency** | Perfect — always reading from HCM | Eventually consistent — local may lag HCM by seconds/minutes |
| **Latency** | High — every user action is gated on HCM SLA (typically 200–800ms; can be seconds under load) | Low — reads and submissions are local; HCM is async |
| **Availability** | Coupled — if HCM is down, ReadyOn is down | Decoupled — ReadyOn continues operating during HCM outages |
| **Race conditions** | Still present — two simultaneous requests both hit HCM, both see sufficient balance, both are applied | Mitigated locally by `BEGIN IMMEDIATE` transaction before HCM call |
| **Implementation complexity** | Low — no outbox, no ledger | Higher — outbox worker, ledger, state machine |
| **Correctness under HCM timeout** | Silent failure: did the call land or not? Identical problem without a better resolution path | Identical problem, but the outbox provides a durable retry mechanism with idempotency |

**Why it was rejected**: The synchronous approach provides no meaningful correctness advantage over the outbox pattern (race conditions and timeouts are present in both), while creating a hard availability coupling between ReadyOn and the HCM. Any HCM maintenance window, latency spike, or partial outage directly degrades the employee experience. The spec's requirement for "instant feedback" is fundamentally incompatible with a synchronously-blocking HCM call.

---

### 8.2 Alternative: Polling-Only Sync (No Inbound Batch Endpoint)

**Description**: Instead of accepting batch pushes from HCM, ReadyOn polls HCM periodically for all employee balances.

**Analysis**: This approach places the polling burden entirely on ReadyOn and requires HCM to support a paginated list endpoint. It eliminates the complexity of the inbound batch merge but introduces higher latency for large resets (a January 1st reset would not be reflected until the next poll cycle). It also requires ReadyOn to manage its own polling schedule and handle HCM rate limits. The push model (as specified) is superior because HCM initiates the sync exactly when data changes, eliminating the polling window.

**Why it was rejected**: The spec explicitly provides a batch endpoint from HCM. The push model provides lower latency and zero unnecessary polling calls.

---

### 8.3 Alternative: Event Sourcing with Full CQRS

**Description**: Replace the balance table entirely with an event log. The current balance is derived by replaying all events from the beginning of time.

**Analysis**: Full event sourcing would provide the strongest audit trail and the ability to reconstruct any point-in-time balance. However, it introduces significant complexity: snapshot strategies are required for performance as the event log grows, the CQRS read model requires a projection rebuild mechanism, and the development overhead is substantial relative to the assessment scope.

**Why it was rejected**: The Reservation Ledger pattern provides the core benefits of event sourcing (immutable audit trail, derived balance) with a fraction of the complexity. The `balance_ledger` table serves as the audit log. The `time_off_balances` table serves as the pre-computed snapshot. This is a pragmatic subset of event sourcing appropriate for the problem at hand.

---

### 8.4 Alternative: Distributed Lock on Balance Record

**Description**: Use a distributed lock (e.g., Redis RedLock) to serialize all balance-affecting operations per employee/location, rather than relying on SQLite transactions.

**Analysis**: A distributed lock would solve the concurrency problem but introduces a dependency on Redis and the complexity of lock acquisition, expiry, and failure handling. In a single-node SQLite deployment (as specified), `BEGIN IMMEDIATE` transactions provide the same serialisation guarantee without any external dependency. If the service were to scale horizontally across multiple nodes, a distributed lock or an external database with row-level locking would become necessary. For the scope of this assessment, the SQLite transaction is the correct and sufficient tool.

**Why it was rejected**: Over-engineering for a single-node SQLite deployment. The SQLite write-lock provides the necessary serialisation.

---

*End of Technical Requirement Document*

---

> **Appendix A — Glossary**

| Term | Definition |
|---|---|
| **HCM** | Human Capital Management system — the authoritative source of employment and leave data (e.g., Workday, SAP SuccessFactors) |
| **Effective Balance** | The balance visible to the employee: `hcm_balance - active_reservations` |
| **Reservation** | A hold placed on a balance when a request enters `PENDING` or later states |
| **Outbox Event** | A durable, database-persisted record of a pending HCM call, processed asynchronously by the Outbox Worker |
| **Idempotency Key** | A client-generated UUID that prevents duplicate processing of the same logical operation |
| **TOCTOU** | Time-of-Check to Time-of-Use race condition — the gap between reading a value and acting on it |
| **Compensating Transaction** | A credit posted to HCM to reverse a previously applied deduction (used when a finalized request must be cancelled) |
| **Stale Balance** | A local `hcm_balance` record that has not been refreshed within the configured `STALE_THRESHOLD` |
