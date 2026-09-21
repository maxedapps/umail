CREATE TABLE outbound_jobs_new (
  id TEXT PRIMARY KEY NOT NULL,
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('operator', 'oauth')),
  requester_client_id TEXT NOT NULL,
  requester_label TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  message_id TEXT NOT NULL,
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

INSERT INTO outbound_jobs_new (
  id, requester_kind, requester_client_id, requester_label, idempotency_key,
  intent_fingerprint, message_id, mailbox_id, purpose, state, attempt_id,
  attempt_claimed_at, claim_expires_at, provider_message_id, rfc_message_id,
  failure_class, failure_detail, created_at, updated_at
)
SELECT
  id, requester_kind, requester_client_id, requester_label, idempotency_key,
  intent_fingerprint, message_id, mailbox_id, purpose, state, attempt_id,
  attempt_claimed_at, claim_expires_at, provider_message_id, rfc_message_id,
  failure_class, failure_detail, created_at, updated_at
FROM outbound_jobs;

DROP TABLE outbound_jobs;
ALTER TABLE outbound_jobs_new RENAME TO outbound_jobs;
CREATE INDEX outbound_jobs_state_created_idx
  ON outbound_jobs (state, created_at, id);
CREATE INDEX outbound_jobs_message_id_idx
  ON outbound_jobs (message_id);
