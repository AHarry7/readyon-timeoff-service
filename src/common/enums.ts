// ─────────────────────────────────────────────────────────────────────────────
// Shared Enums
// All string literals match the CHECK constraints defined in the TRD SQL schema.
// ─────────────────────────────────────────────────────────────────────────────

export enum SyncSource {
  REALTIME = 'REALTIME',
  BATCH    = 'BATCH',
  MANUAL   = 'MANUAL',
}

export enum RequestStatus {
  PENDING   = 'PENDING',
  APPROVED  = 'APPROVED',
  HCM_PENDING  = 'HCM_PENDING',
  FINALIZED = 'FINALIZED',
  REJECTED  = 'REJECTED',
  HCM_FAILED = 'HCM_FAILED',
}

export enum LedgerEventType {
  HCM_SYNC_REALTIME      = 'HCM_SYNC_REALTIME',
  HCM_SYNC_BATCH         = 'HCM_SYNC_BATCH',
  RESERVATION_CREATED    = 'RESERVATION_CREATED',
  RESERVATION_RELEASED   = 'RESERVATION_RELEASED',
  RESERVATION_FINALIZED  = 'RESERVATION_FINALIZED',
  COMPENSATING_CREDIT    = 'COMPENSATING_CREDIT',
  MANUAL_ADJUSTMENT      = 'MANUAL_ADJUSTMENT',
}

export enum OutboxEventType {
  APPLY              = 'APPLY',
  CANCEL             = 'CANCEL',
  COMPENSATING_CREDIT = 'COMPENSATING_CREDIT',
}

export enum OutboxStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED  = 'PROCESSED',
  FAILED     = 'FAILED',
}

export enum BatchSnapshotStatus {
  RECEIVED         = 'RECEIVED',
  PROCESSED        = 'PROCESSED',
  PARTIALLY_FAILED = 'PARTIALLY_FAILED',
}
