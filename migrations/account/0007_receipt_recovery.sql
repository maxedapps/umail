CREATE TABLE inbound_receipts_new (
  id TEXT PRIMARY KEY NOT NULL,
  digest TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  advertised_raw_size INTEGER NOT NULL,
  consumed_bytes INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  forward_outcome TEXT NOT NULL CHECK (
    forward_outcome IN ('none', 'success', 'failure', 'unknown')
  ),
  forward_destination TEXT,
  forward_error TEXT,
  work_state TEXT NOT NULL CHECK (work_state IN (
    'ready', 'claimed', 'indexed', 'policy_failed', 'terminal', 'operator_reprocess'
  )),
  policy_error TEXT,
  claimed_until TEXT,
  retry_after TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (digest, envelope_from, envelope_to)
);

INSERT INTO inbound_receipts_new (
  id, digest, envelope_from, envelope_to, raw_key, manifest_key,
  advertised_raw_size, consumed_bytes, received_at, created_at,
  forward_outcome, forward_destination, forward_error, work_state, policy_error,
  claimed_until, retry_after, attempt_count, last_error
)
SELECT
  id, digest, envelope_from, envelope_to, raw_key, manifest_key,
  advertised_raw_size, consumed_bytes, received_at, created_at,
  forward_outcome, forward_destination, forward_error, work_state, policy_error,
  NULL, NULL, 0, NULL
FROM inbound_receipts;

DROP TABLE inbound_receipts;
ALTER TABLE inbound_receipts_new RENAME TO inbound_receipts;
CREATE INDEX inbound_receipts_work_state ON inbound_receipts (work_state, received_at, id);
CREATE INDEX inbound_receipts_claimed_until ON inbound_receipts (claimed_until, id) WHERE work_state = 'claimed';

CREATE TABLE recovery_scans (
  id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  updated_at TEXT NOT NULL
);
