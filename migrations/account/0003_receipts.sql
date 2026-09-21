CREATE TABLE inbound_receipts (
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
  work_state TEXT NOT NULL CHECK (work_state IN ('ready')),
  UNIQUE (digest, envelope_from, envelope_to)
);

CREATE INDEX inbound_receipts_work_state ON inbound_receipts (work_state, received_at, id);
