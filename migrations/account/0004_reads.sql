ALTER TABLE messages ADD COLUMN subject TEXT;
ALTER TABLE messages ADD COLUMN text_body TEXT;
ALTER TABLE messages ADD COLUMN html_body TEXT;
ALTER TABLE messages ADD COLUMN has_remote_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
ALTER TABLE messages ADD COLUMN updated_at TEXT;

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

CREATE INDEX messages_list_occurred_idx ON messages (occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_list_mailbox_occurred_idx ON messages (mailbox_id, occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX messages_unread_inbound_idx ON messages (occurred_at DESC, id) WHERE direction = 'inbound' AND is_read = 0 AND deleted_at IS NULL;
CREATE INDEX message_participants_message_idx ON message_participants (message_id);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);
