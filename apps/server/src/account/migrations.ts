export type AccountMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const accountMigration0010Sql = `CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
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

CREATE TABLE inbound_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  forward_outcome TEXT NOT NULL DEFAULT 'none' CHECK (
    forward_outcome IN ('none', 'unknown', 'success', 'failure')
  ),
  forward_destination TEXT,
  work_state TEXT NOT NULL DEFAULT 'ready' CHECK (
    work_state IN ('ready', 'indexed', 'policy_failed')
  ),
  policy_error TEXT,
  retry_after TEXT NOT NULL
);

CREATE TABLE message_participants (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc')),
  position INTEGER NOT NULL CHECK (position >= 0),
  address TEXT NOT NULL,
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

CREATE TABLE addresses (
  id TEXT PRIMARY KEY NOT NULL,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  forward_to TEXT,
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
  notification_job_id TEXT NOT NULL UNIQUE,
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

CREATE INDEX messages_thread_idx ON messages (thread_id, occurred_at, id);
CREATE INDEX messages_rfc_idx ON messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX messages_in_reply_to_idx ON messages (in_reply_to_rfc_message_id) WHERE in_reply_to_rfc_message_id IS NOT NULL;
CREATE INDEX message_references_rfc_idx ON message_references (rfc_message_id);
CREATE INDEX messages_mailbox_id ON messages (mailbox_id);
CREATE INDEX messages_list_occurred_idx ON messages (occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_list_mailbox_occurred_idx ON messages (mailbox_id, occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_unread_inbound_idx ON messages (occurred_at DESC, id) WHERE direction = 'inbound' AND is_read = 0 AND deleted_at IS NULL;
CREATE INDEX message_participants_message_idx ON message_participants (message_id);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);
CREATE INDEX inbound_receipts_due ON inbound_receipts (retry_after, id) WHERE work_state = 'ready';
CREATE INDEX outbound_jobs_state_created_idx ON outbound_jobs (state, created_at, id);
CREATE INDEX outbound_jobs_message_id_idx ON outbound_jobs (message_id);
CREATE INDEX approval_requests_state_expires_idx ON approval_requests (state, expires_at, id);
`;

export const accountMigrations = [
  {
    version: 10,
    name: "0010_account",
    sql: accountMigration0010Sql,
  },
] as const satisfies readonly AccountMigration[];

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
