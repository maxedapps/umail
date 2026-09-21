export type AccountMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

export const accountMigration0009Sql = `CREATE TABLE account_meta (
  account_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE command_items (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  label TEXT NOT NULL
);

CREATE TABLE thread_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('placeholder', 'message')),
  created_at TEXT NOT NULL
);

CREATE TABLE rfc_lookups (
  rfc_message_id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL UNIQUE,
  claimant_node_id TEXT
);

CREATE TABLE thread_component_links (
  node_id TEXT PRIMARY KEY NOT NULL,
  parent_node_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE thread_parent_edges (
  child_node_id TEXT PRIMARY KEY NOT NULL,
  parent_node_id TEXT NOT NULL,
  CHECK (child_node_id <> parent_node_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  rfc_message_id TEXT,
  in_reply_to_rfc_message_id TEXT,
  occurred_at TEXT NOT NULL,
  parsed_date TEXT,
  created_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  has_remote_images INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  updated_at TEXT
);

CREATE TABLE message_references (
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  rfc_message_id TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);

CREATE TABLE threading_diagnostics (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('parent_cycle', 'parent_replacement', 'threading_limited')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE message_participants (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc')),
  position INTEGER NOT NULL CHECK (position >= 0),
  address TEXT NOT NULL,
  comparison_key TEXT NOT NULL,
  display_name TEXT,
  UNIQUE (message_id, role, position)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_id TEXT,
  disposition TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, position)
);

CREATE TABLE forwarding_destinations (
  id TEXT PRIMARY KEY NOT NULL,
  cloudflare_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY NOT NULL,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  forwarding_destination_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_oauth_policies (
  client_id TEXT PRIMARY KEY NOT NULL CHECK (length(client_id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'revoked')),
  mailbox_ids_json TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
  can_delete INTEGER NOT NULL CHECK (can_delete IN (0, 1)),
  send_mode TEXT NOT NULL CHECK (send_mode IN ('deny', 'allow', 'requireApproval')),
  recipient_allowlist_json TEXT NOT NULL,
  preapproved_recipients_json TEXT NOT NULL,
  can_admin INTEGER NOT NULL DEFAULT 0 CHECK (can_admin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbound_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('operator', 'mcp')),
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
  UNIQUE (requester_kind, requester_client_id, idempotency_key)
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

CREATE TABLE recovery_scans (
  id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX messages_node_id ON messages (node_id);
CREATE INDEX messages_mailbox_id ON messages (mailbox_id);
CREATE INDEX thread_component_links_parent_node_id ON thread_component_links (parent_node_id);
CREATE INDEX threading_diagnostics_message_id ON threading_diagnostics (message_id);
CREATE INDEX messages_list_occurred_idx ON messages (occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_list_mailbox_occurred_idx ON messages (mailbox_id, occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_unread_inbound_idx ON messages (occurred_at DESC, id) WHERE direction = 'inbound' AND is_read = 0 AND deleted_at IS NULL;
CREATE INDEX message_participants_message_idx ON message_participants (message_id);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);
CREATE INDEX inbound_receipts_work_state ON inbound_receipts (work_state, received_at, id);
CREATE INDEX inbound_receipts_claimed_until ON inbound_receipts (claimed_until, id) WHERE work_state = 'claimed';
CREATE INDEX outbound_jobs_state_created_idx ON outbound_jobs (state, created_at, id);
CREATE INDEX outbound_jobs_message_id_idx ON outbound_jobs (message_id);
CREATE INDEX approval_requests_state_expires_idx ON approval_requests (state, expires_at, id);
`;

export const accountMigrations = [
  {
    version: 9,
    name: "0009_account",
    sql: accountMigration0009Sql,
  },
] as const satisfies readonly AccountMigration[];

export const accountSchemaVersion = 9 as const;

export function sqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  for (const part of sql.split(";")) {
    const statement = part.trim();
    if (statement.length > 0) {
      statements.push(statement);
    }
  }
  return statements;
}
