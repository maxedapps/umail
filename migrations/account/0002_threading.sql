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
  created_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
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

CREATE INDEX messages_node_id ON messages (node_id);
CREATE INDEX messages_mailbox_id ON messages (mailbox_id);
CREATE INDEX thread_component_links_parent_node_id ON thread_component_links (parent_node_id);
CREATE INDEX threading_diagnostics_message_id ON threading_diagnostics (message_id);
