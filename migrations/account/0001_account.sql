CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE account_meta (
  account_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE command_items (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  label TEXT NOT NULL
);
