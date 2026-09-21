CREATE TABLE outbound_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('operator', 'oauth')),
  requester_client_id TEXT NOT NULL,
  requester_label TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  mailbox_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('message', 'approval_notification')),
  state TEXT NOT NULL CHECK (
    state IN ('waiting_approval', 'ready', 'in_flight', 'accepted', 'rejected', 'unknown')
  ),
  attempt_id TEXT,
  attempt_claimed_at TEXT,
  claim_expires_at TEXT,
  provider_message_id TEXT,
  rfc_message_id TEXT,
  failure_class TEXT CHECK (
    failure_class IN (
      'denied',
      'expired',
      'cancelled',
      'notification_failed',
      'policy',
      'provider'
    )
  ),
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requester_client_id, idempotency_key)
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
  ),
  requester_client_id TEXT NOT NULL,
  requester_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE approval_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT
);

CREATE INDEX outbound_jobs_state_created_idx
  ON outbound_jobs (state, created_at, id);
CREATE INDEX outbound_jobs_message_id_idx
  ON outbound_jobs (message_id);
CREATE INDEX approval_requests_state_expires_idx
  ON approval_requests (state, expires_at, id);
