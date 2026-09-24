import type { NormalizedRfcMessageId } from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  MessageIntegrityError,
  MessageConflictError,
  SchemaIncompatibleError,
  SchemaMigrationError,
} from "./errors.ts";
import {
  DueInboundReceiptRow,
  InboundReceiptRow,
  ParticipantWithMessageRow,
  QUERY_PAGE_DEFAULT,
  QUERY_PAGE_MAX,
  ReferenceWithMessageRow,
  SchemaMigrationRow,
  type AcceptInboundInput,
  type AccountMailContact,
  type AcceptMessageResult,
  type AcceptOutboundInput,
  type FailInboundReceiptPolicyInput,
  type InboundReceipt,
  type ObserveInboundForwardInput,
  type RegisterInboundReceiptInput,
  type StoredParticipants,
} from "./domain.ts";
import { accountMigrations, sqlStatements, type AccountMigration } from "./migrations.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";
import { linkThread, normalizeThreadingHeaders } from "./threading.ts";

const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)`;

export function applyAccountSchema(
  storage: AccountSqliteStorage,
  nowIso: string,
  migrations: readonly AccountMigration[] = accountMigrations,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(SCHEMA_MIGRATIONS_TABLE);
    const applied = readAppliedMigrations(storage);
    assertCompatibleSchema(applied, migrations);
    for (const migration of pendingMigrations(applied, migrations)) {
      applyMigration(storage, migration, nowIso);
    }
  });
}

// Inserts the message and marks its receipt indexed in one transaction; a receipt that is no
// longer `ready` has already been settled, so the call is a no-op.
export function acceptInbound(
  storage: AccountSqliteStorage,
  input: AcceptInboundInput,
): AcceptMessageResult | null {
  return storage.transactionSync(() => {
    const receipt = readInboundReceipt(storage, input.messageId);
    if (receipt === null) {
      throw new MessageIntegrityError({
        messageId: input.messageId,
        reason: "receipt_missing",
      });
    }
    if (receipt.workState !== "ready") {
      return null;
    }
    const result = writeThreadedMail(storage, { direction: "inbound", input });
    storage.sql.exec(
      "UPDATE inbound_receipts SET work_state = 'indexed' WHERE id = ?",
      input.messageId,
    );
    return result;
  });
}

const REDRIVE_GRACE_MS = 5 * 60_000;
const REDRIVE_MIN_MS = 60_000;
const REDRIVE_MAX_MS = 30 * 60_000;

export function registerInboundReceipt(
  storage: AccountSqliteStorage,
  input: RegisterInboundReceiptInput,
): void {
  storage.sql.exec(
    `INSERT INTO inbound_receipts (
       id, envelope_from, envelope_to, raw_key, received_at, retry_after
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    input.receiptId,
    input.envelopeFrom,
    input.envelopeTo,
    input.rawKey,
    input.receivedAt,
    isoAfter(input.receivedAt, REDRIVE_GRACE_MS),
  );
}

// Forward observations only move forward: none -> unknown -> success | failure. The returned
// flag says whether this call applied, so `none -> unknown` doubles as the forward-once claim.
export function observeInboundForward(
  storage: AccountSqliteStorage,
  input: ObserveInboundForwardInput,
): boolean {
  const observation = input.observation;
  return (
    storage.sql
      .exec(
        `UPDATE inbound_receipts
         SET forward_outcome = ?, forward_destination = ?
         WHERE id = ? AND forward_outcome IN ('none', 'unknown') AND forward_outcome <> ?
         RETURNING id`,
        observation.kind,
        observation.destination,
        input.receiptId,
        observation.kind,
      )
      .toArray().length > 0
  );
}

export function getInboundReceipt(
  storage: AccountSqliteStorage,
  receiptId: string,
): InboundReceipt | null {
  return readInboundReceipt(storage, receiptId);
}

export function failInboundReceiptPolicy(
  storage: AccountSqliteStorage,
  input: FailInboundReceiptPolicyInput,
): void {
  storage.sql.exec(
    `UPDATE inbound_receipts SET work_state = 'policy_failed', policy_error = ?
     WHERE id = ? AND work_state = 'ready'`,
    input.reason,
    input.receiptId,
  );
}

// Returns the due `ready` receipts and pushes each one's next redrive out by its age, clamped to
// 1-30 minutes. Receipts never leave `ready` here, so stuck mail is retried until it indexes.
export function redriveDueInboundReceipts(
  storage: AccountSqliteStorage,
  input: { readonly nowIso: string; readonly limit: number },
): ReadonlyArray<string> {
  return storage.transactionSync(() => {
    const nowMs = Date.parse(input.nowIso);
    const due = Schema.decodeUnknownSync(Schema.Array(DueInboundReceiptRow))(
      storage.sql
        .exec(
          `SELECT id, received_at FROM inbound_receipts
           WHERE work_state = 'ready' AND retry_after <= ?
           ORDER BY retry_after, id
           LIMIT ?`,
          input.nowIso,
          input.limit,
        )
        .toArray(),
    );
    for (const row of due) {
      const age = nowMs - Date.parse(row.received_at);
      const delay = Math.min(Math.max(age, REDRIVE_MIN_MS), REDRIVE_MAX_MS);
      storage.sql.exec(
        "UPDATE inbound_receipts SET retry_after = ? WHERE id = ?",
        isoAfter(input.nowIso, delay),
        row.id,
      );
    }
    return due.map((row) => row.id);
  });
}

function isoAfter(iso: string, delayMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Date.parse(iso) + delayMs));
}

function readAppliedMigrations(storage: AccountSqliteStorage): ReadonlyArray<SchemaMigrationRow> {
  const rows = storage.sql
    .exec("SELECT version, name FROM schema_migrations ORDER BY version")
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(SchemaMigrationRow))(rows);
}

function assertCompatibleSchema(
  applied: ReadonlyArray<SchemaMigrationRow>,
  migrations: readonly AccountMigration[],
): void {
  const knownByVersion = new Map<number, AccountMigration>();
  for (const migration of migrations) {
    knownByVersion.set(migration.version, migration);
  }
  const supportedVersion = Math.max(...migrations.map((migration) => migration.version));
  for (const row of applied) {
    const known = knownByVersion.get(row.version);
    if (known === undefined || known.name !== row.name || row.version > supportedVersion) {
      throw new SchemaIncompatibleError({
        schemaVersion: row.version,
        supportedVersion,
      });
    }
  }
}

function pendingMigrations(
  applied: ReadonlyArray<SchemaMigrationRow>,
  migrations: readonly AccountMigration[],
): readonly AccountMigration[] {
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending: AccountMigration[] = [];
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      pending.push(migration);
    }
  }
  return pending;
}

function applyMigration(
  storage: AccountSqliteStorage,
  migration: AccountMigration,
  nowIso: string,
): void {
  try {
    for (const statement of sqlStatements(migration.sql)) {
      storage.sql.exec(statement);
    }
    storage.sql.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      migration.version,
      migration.name,
      nowIso,
    );
  } catch (cause) {
    throw new SchemaMigrationError({
      version: migration.version,
      name: migration.name,
      cause,
    });
  }
}

export type ThreadedMailWrite =
  | { readonly direction: "inbound"; readonly input: AcceptInboundInput }
  | { readonly direction: "outbound"; readonly input: AcceptOutboundInput };

export function writeThreadedMail(
  storage: AccountSqliteStorage,
  write: ThreadedMailWrite,
): AcceptMessageResult {
  const input = write.input;
  if (
    storage.sql.exec("SELECT id FROM messages WHERE id = ?", input.messageId).toArray().length > 0
  ) {
    throw new MessageConflictError({ messageId: input.messageId });
  }
  const headers = normalizeThreadingHeaders(
    input.rfcMessageId,
    input.inReplyToHeader,
    input.referencesHeader,
  );
  storage.sql.exec(
    `INSERT INTO messages (
       id, thread_id, mailbox_id, direction, rfc_message_id, in_reply_to_rfc_message_id,
       occurred_at, parsed_date, created_at, updated_at, subject, text_body, html_body,
       has_remote_images
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.messageId,
    input.messageId,
    input.mailboxId,
    write.direction,
    headers.rfcMessageId,
    headers.inReplyTo,
    input.occurredAt,
    write.direction === "inbound" ? write.input.parsedDate : null,
    input.nowIso,
    input.nowIso,
    input.subject ?? null,
    input.textBody ?? null,
    input.htmlBody ?? null,
    input.hasRemoteImages === true ? 1 : 0,
  );
  for (const [position, rfcMessageId] of headers.references.entries()) {
    storage.sql.exec(
      "INSERT INTO message_references (message_id, position, rfc_message_id) VALUES (?, ?, ?)",
      input.messageId,
      position,
      rfcMessageId,
    );
  }
  insertParticipants(storage, input.messageId, "from", input.from);
  insertParticipants(storage, input.messageId, "reply_to", input.replyTo);
  insertParticipants(storage, input.messageId, "to", input.to);
  insertParticipants(storage, input.messageId, "cc", input.cc);
  insertAttachments(storage, input.messageId, input.nowIso, input.attachments);
  return { messageId: input.messageId, threadId: linkThread(storage, input.messageId) };
}

export function loadParticipantsByMessageIds(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
): ReadonlyMap<string, StoredParticipants> {
  const byId = new Map<string, MutableParticipants>();
  for (const id of messageIds) {
    byId.set(id, emptyMutableParticipants());
  }
  if (messageIds.length === 0) {
    return byId;
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(ParticipantWithMessageRow))(
    storage.sql
      .exec(
        `SELECT message_participants.message_id AS message_id,
                message_participants.role AS role,
                message_participants.position AS position,
                message_participants.address AS address,
                message_participants.display_name AS display_name
         FROM message_participants
         JOIN json_each(?) AS requested ON requested.value = message_participants.message_id
         ORDER BY message_participants.message_id, message_participants.role, message_participants.position`,
        bindJsonStringArray(messageIds),
      )
      .toArray(),
  );
  for (const row of rows) {
    const bucket = byId.get(row.message_id) ?? emptyMutableParticipants();
    if (!byId.has(row.message_id)) {
      byId.set(row.message_id, bucket);
    }
    appendParticipant(bucket, row);
  }
  return byId;
}

export function loadReferencesByMessageIds(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<NormalizedRfcMessageId>> {
  const byId = new Map<string, Array<NormalizedRfcMessageId>>();
  for (const id of messageIds) {
    byId.set(id, []);
  }
  if (messageIds.length === 0) {
    return byId;
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(ReferenceWithMessageRow))(
    storage.sql
      .exec(
        `SELECT message_references.message_id AS message_id,
                message_references.position AS position,
                message_references.rfc_message_id AS rfc_message_id
         FROM message_references
         JOIN json_each(?) AS requested ON requested.value = message_references.message_id
         ORDER BY message_references.message_id, message_references.position`,
        bindJsonStringArray(messageIds),
      )
      .toArray(),
  );
  for (const row of rows) {
    const list = byId.get(row.message_id) ?? [];
    list.push(row.rfc_message_id);
    byId.set(row.message_id, list);
  }
  return byId;
}

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return QUERY_PAGE_DEFAULT;
  }
  if (limit < 1) {
    return 1;
  }
  if (limit > QUERY_PAGE_MAX) {
    return QUERY_PAGE_MAX;
  }
  return limit;
}

function readInboundReceipt(
  storage: AccountSqliteStorage,
  receiptId: string,
): InboundReceipt | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(InboundReceiptRow),
    storage.sql
      .exec(
        `SELECT id, envelope_from, envelope_to, raw_key, received_at, forward_outcome,
                forward_destination, work_state, policy_error, retry_after
         FROM inbound_receipts
         WHERE id = ?`,
        receiptId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return {
    receiptId: row.id,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    rawKey: row.raw_key,
    receivedAt: row.received_at,
    forwardOutcome: row.forward_outcome,
    forwardDestination: row.forward_destination,
    workState: row.work_state,
    policyError: row.policy_error,
    retryAfter: row.retry_after,
  };
}

function insertParticipants(
  storage: AccountSqliteStorage,
  messageId: string,
  role: "from" | "reply_to" | "to" | "cc",
  contacts: AcceptInboundInput["from"],
): void {
  if (contacts === undefined) {
    return;
  }
  for (let position = 0; position < contacts.length; position += 1) {
    const contact = contacts[position];
    if (contact === undefined) {
      continue;
    }
    storage.sql.exec(
      `INSERT INTO message_participants (
         id, message_id, role, position, address, display_name
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      `pt_${messageId}_${role}_${position}`,
      messageId,
      role,
      position,
      contact.address,
      contact.displayName,
    );
  }
}

function insertAttachments(
  storage: AccountSqliteStorage,
  messageId: string,
  createdAt: string,
  attachments: AcceptInboundInput["attachments"],
): void {
  if (attachments === undefined) {
    return;
  }
  for (const attachment of attachments) {
    storage.sql.exec(
      `INSERT INTO attachments (
         id, message_id, position, filename, mime_type, size, r2_key, content_id, disposition,
         is_inline, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attachment.id,
      messageId,
      attachment.position,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      attachment.r2Key,
      attachment.contentId,
      attachment.disposition,
      attachment.isInline ? 1 : 0,
      createdAt,
    );
  }
}

type MutableParticipants = {
  from: Array<AccountMailContact>;
  replyTo: Array<AccountMailContact>;
  to: Array<AccountMailContact>;
  cc: Array<AccountMailContact>;
};

export function emptyParticipants(): StoredParticipants {
  return { from: [], replyTo: [], to: [], cc: [] };
}

function emptyMutableParticipants(): MutableParticipants {
  return { from: [], replyTo: [], to: [], cc: [] };
}

function appendParticipant(
  participants: MutableParticipants,
  row: typeof ParticipantWithMessageRow.Type,
): void {
  const contact = { address: row.address, displayName: row.display_name };
  if (row.role === "from") participants.from.push(contact);
  if (row.role === "reply_to") participants.replyTo.push(contact);
  if (row.role === "to") participants.to.push(contact);
  if (row.role === "cc") participants.cc.push(contact);
}
