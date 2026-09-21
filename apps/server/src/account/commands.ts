import {
  NormalizedRfcMessageId,
  nodeThreadHandle,
  normalizeRfcMessageId,
  parseThreadHandle,
} from "@umail/api-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  AccountIdentityError,
  AccountStoreUnexpectedError,
  CommandConflictError,
  InboundMessageIntegrityError,
  SchemaIncompatibleError,
  SchemaMigrationError,
  ThreadHandleError,
} from "./errors.ts";
import {
  AcceptInboundInput,
  AcceptMessageResult,
  AcceptOutboundInput,
  AccountMetaRow,
  CatalogNameRow,
  CommandItem,
  CommandItemRow,
  ComponentLinkRow,
  ConversationMessage,
  ConversationMessageRow,
  ConversationView,
  ClaimInboundReceiptInput,
  ClaimInboundReceiptResult,
  FailInboundReceiptPolicyInput,
  InboundReceipt,
  InboundReceiptRow,
  ItemIdList,
  ListInboundReceiptWorkInput,
  ListInboundReceiptWorkPage,
  MessageIdPresenceRow,
  ObserveInboundForwardInput,
  ParentEdgeRow,
  PutRecoveryScanInput,
  QUERY_PAGE_DEFAULT,
  QUERY_PAGE_MAX,
  ReceiptForwardObservation,
  ReceiptWorkState,
  RecordInboundReceiptRedriveInput,
  RecordItemGroupInput,
  RecoveryScan,
  RecoveryScanRow,
  RegisterInboundReceiptInput,
  RegisterInboundReceiptResult,
  RfcLookupRow,
  RfcLookupView,
  SchemaMigrationRow,
  SchemaStatus,
  ThreadingDiagnostic,
  ThreadingDiagnosticRow,
  ThreadNodeRow,
} from "./domain.ts";
import {
  accountMigrations,
  accountSchemaVersion,
  sqlStatements,
  type AccountMigration,
} from "./migrations.ts";
import { firstDecoded, type AccountSqlRow, type AccountSqliteStorage } from "./sqlite.ts";
import {
  acceptThreadedMessage,
  claimOwnRfcIdentity,
  cryptoThreadingIds,
  normalizeInboundRfcHeaders,
  THREADING_ANCESTRY_WORK_BUDGET,
  type FindRootResult,
  type OwnRfcIdentityClaim,
  type OwnRfcIdentityClaimResult,
  type RfcLookupRecord,
  type ThreadingDiagnosticRecord,
  type ThreadingGraph,
  type ThreadingIds,
} from "./threading.ts";

const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)`;

const SqliteErrorMessage = Schema.Struct({
  message: Schema.String,
});

export type ApplyAccountSchemaInput = {
  readonly accountId: string;
  readonly nowIso: string;
  readonly migrations?: readonly AccountMigration[];
};

export function applyAccountSchema(
  storage: AccountSqliteStorage,
  input: ApplyAccountSchemaInput,
): SchemaStatus {
  const migrations = input.migrations ?? accountMigrations;
  return storage.transactionSync(() => {
    storage.sql.exec(SCHEMA_MIGRATIONS_TABLE);
    const applied = readAppliedMigrations(storage);
    assertCompatibleSchema(applied, migrations);
    for (const migration of pendingMigrations(applied, migrations)) {
      applyMigration(storage, migration, input.nowIso);
    }
    ensureAccountMeta(storage, input.accountId, input.nowIso);
    return readSchemaStatus(storage);
  });
}

export function schemaStatus(storage: AccountSqliteStorage): SchemaStatus {
  return readSchemaStatus(storage);
}

export function recordItemGroup(storage: AccountSqliteStorage, input: RecordItemGroupInput): void {
  const group = Schema.decodeSync(RecordItemGroupInput)(input);
  storage.transactionSync(() => {
    for (const item of group.items) {
      try {
        storage.sql.exec(
          "INSERT INTO command_items (id, group_id, label) VALUES (?, ?, ?)",
          item.id,
          group.groupId,
          item.label,
        );
      } catch (cause) {
        throw conflictOrRethrow(cause, group.groupId, item.id);
      }
    }
  });
}

export type PersistThreadingOptions = {
  readonly ancestryWorkBudget: number;
  readonly ids: ThreadingIds;
};

export const defaultPersistThreadingOptions = {
  ancestryWorkBudget: THREADING_ANCESTRY_WORK_BUDGET,
  ids: cryptoThreadingIds(),
} satisfies PersistThreadingOptions;

export function acceptInbound(
  storage: AccountSqliteStorage,
  input: AcceptInboundInput,
  options: PersistThreadingOptions = defaultPersistThreadingOptions,
): AcceptMessageResult {
  const parsed = Schema.decodeSync(AcceptInboundInput)(input);
  return storage.transactionSync(() => {
    if (readInboundReceipt(storage, parsed.messageId) === null) {
      throw new InboundMessageIntegrityError({
        messageId: parsed.messageId,
        reason: "receipt_missing",
      });
    }
    return writeThreadedMail(storage, { direction: "inbound", input: parsed }, options);
  });
}

export function acceptOutbound(
  storage: AccountSqliteStorage,
  input: AcceptOutboundInput,
  options: PersistThreadingOptions = defaultPersistThreadingOptions,
): AcceptMessageResult {
  const parsed = Schema.decodeSync(AcceptOutboundInput)(input);
  return storage.transactionSync(() =>
    writeThreadedMail(storage, { direction: "outbound", input: parsed }, options),
  );
}

export function resolveConversation(
  storage: AccountSqliteStorage,
  handle: string,
): ConversationView {
  return storage.transactionSync(() => {
    const parsed = parseThreadHandle(handle);
    if (parsed.kind === "invalid") {
      throw new ThreadHandleError({ handle, reason: "invalid" });
    }
    const node = firstDecoded(
      Schema.decodeUnknownSync(ThreadNodeRow),
      storage.sql.exec("SELECT id, kind FROM thread_nodes WHERE id = ?", parsed.nodeId).toArray(),
    );
    if (node === undefined) {
      throw new ThreadHandleError({ handle, reason: "not_found" });
    }
    const graph = sqliteThreadingGraph(storage);
    const componentRootId = graph.findRoot(parsed.nodeId).root;
    const messageRows = storage.sql
      .exec(
        `WITH RECURSIVE members(node_id) AS (
           SELECT ?
           UNION
           SELECT l.node_id
           FROM thread_component_links l
           JOIN members m ON l.parent_node_id = m.node_id
           WHERE l.node_id <> m.node_id
         )
         SELECT msg.id AS id,
                msg.node_id AS node_id,
                msg.mailbox_id AS mailbox_id,
                msg.direction AS direction,
                msg.rfc_message_id AS rfc_message_id,
                edge.parent_node_id AS parent_node_id,
                msg.occurred_at AS occurred_at,
                msg.deleted_at AS deleted_at
         FROM messages msg
         JOIN members ON members.node_id = msg.node_id
         LEFT JOIN thread_parent_edges edge ON edge.child_node_id = msg.node_id
         ORDER BY msg.occurred_at ASC, msg.id ASC`,
        componentRootId,
      )
      .toArray();
    const diagnosticRows = storage.sql
      .exec(
        `WITH RECURSIVE members(node_id) AS (
           SELECT ?
           UNION
           SELECT l.node_id
           FROM thread_component_links l
           JOIN members m ON l.parent_node_id = m.node_id
           WHERE l.node_id <> m.node_id
         )
         SELECT d.id AS id,
                d.message_id AS message_id,
                d.node_id AS node_id,
                d.kind AS kind,
                d.detail AS detail,
                d.created_at AS created_at
         FROM threading_diagnostics d
         JOIN members ON members.node_id = d.node_id
         ORDER BY d.created_at ASC, d.id ASC`,
        componentRootId,
      )
      .toArray();
    return Schema.decodeSync(ConversationView)({
      handle: parsed.handle,
      nodeId: parsed.nodeId,
      componentRootId,
      messages: Schema.decodeUnknownSync(Schema.Array(ConversationMessageRow))(messageRows).map(
        toConversationMessage,
      ),
      diagnostics: Schema.decodeUnknownSync(Schema.Array(ThreadingDiagnosticRow))(
        diagnosticRows,
      ).map(toThreadingDiagnostic),
    });
  });
}

export function inspectRfcLookup(
  storage: AccountSqliteStorage,
  rfcMessageId: string,
): RfcLookupView | null {
  const normalized = normalizeRfcMessageId(rfcMessageId);
  if (normalized === null) {
    return null;
  }
  return storage.transactionSync(() => {
    const lookup = sqliteThreadingGraph(storage).getRfcLookup(normalized);
    if (lookup === null) {
      return null;
    }
    return Schema.decodeSync(RfcLookupView)({
      rfcMessageId: lookup.rfcMessageId,
      nodeId: lookup.nodeId,
      claimantNodeId: lookup.claimantNodeId,
    });
  });
}

export function registerInboundReceipt(
  storage: AccountSqliteStorage,
  input: RegisterInboundReceiptInput,
): RegisterInboundReceiptResult {
  const parsed = Schema.decodeSync(RegisterInboundReceiptInput)(input);
  return storage.transactionSync(() => {
    const existing = readInboundReceipt(storage, parsed.receiptId);
    if (existing !== null) {
      return Schema.decodeSync(RegisterInboundReceiptResult)({
        receipt: existing,
        created: false,
      });
    }
    storage.sql.exec(
      `INSERT INTO inbound_receipts (
         id, digest, envelope_from, envelope_to, raw_key, manifest_key,
         advertised_raw_size, consumed_bytes, received_at, created_at,
         forward_outcome, forward_destination, forward_error, work_state, policy_error,
         claimed_until, retry_after, attempt_count, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parsed.receiptId,
      parsed.digest,
      parsed.envelopeFrom,
      parsed.envelopeTo,
      parsed.rawKey,
      parsed.manifestKey,
      parsed.advertisedRawSize,
      parsed.consumedBytes,
      parsed.receivedAt,
      parsed.receivedAt,
      "none",
      null,
      null,
      "ready",
      null,
      null,
      null,
      0,
      null,
    );
    return Schema.decodeSync(RegisterInboundReceiptResult)({
      receipt: requireInboundReceipt(storage, parsed.receiptId),
      created: true,
    });
  });
}

export function observeInboundForward(
  storage: AccountSqliteStorage,
  input: ObserveInboundForwardInput,
): InboundReceipt {
  const parsed = Schema.decodeSync(ObserveInboundForwardInput)(input);
  return storage.transactionSync(() => {
    const current = requireInboundReceipt(storage, parsed.receiptId);
    const next = nextForwardObservation(current.forward, parsed.observation);
    if (next === current.forward) {
      return current;
    }
    const columns = forwardObservationColumns(next);
    storage.sql.exec(
      `UPDATE inbound_receipts
       SET forward_outcome = ?, forward_destination = ?, forward_error = ?
       WHERE id = ?`,
      columns.outcome,
      columns.destination,
      columns.error,
      parsed.receiptId,
    );
    return requireInboundReceipt(storage, parsed.receiptId);
  });
}

export function getInboundReceipt(
  storage: AccountSqliteStorage,
  receiptId: string,
): InboundReceipt | null {
  return storage.transactionSync(() => readInboundReceipt(storage, receiptId));
}

export function failInboundReceiptPolicy(
  storage: AccountSqliteStorage,
  input: FailInboundReceiptPolicyInput,
): InboundReceipt {
  const parsed = Schema.decodeSync(FailInboundReceiptPolicyInput)(input);
  return storage.transactionSync(() => {
    const current = requireInboundReceipt(storage, parsed.receiptId);
    if (isFinishedReceiptWork(current.workState)) {
      return current;
    }
    storage.sql.exec(
      `UPDATE inbound_receipts
       SET work_state = ?, policy_error = ?, claimed_until = ?, retry_after = ?, last_error = ?
       WHERE id = ?`,
      "policy_failed",
      parsed.reason,
      null,
      null,
      parsed.reason,
      parsed.receiptId,
    );
    return requireInboundReceipt(storage, parsed.receiptId);
  });
}

export function claimInboundReceipt(
  storage: AccountSqliteStorage,
  input: ClaimInboundReceiptInput,
): ClaimInboundReceiptResult {
  const parsed = Schema.decodeSync(ClaimInboundReceiptInput)(input);
  return storage.transactionSync(() => {
    const current = requireInboundReceipt(storage, parsed.receiptId);
    if (isFinishedReceiptWork(current.workState)) {
      return Schema.decodeSync(ClaimInboundReceiptResult)({
        receipt: current,
        claimed: false,
      });
    }
    if (isLiveUnexpiredClaim(current, parsed.nowIso)) {
      return Schema.decodeSync(ClaimInboundReceiptResult)({
        receipt: current,
        claimed: false,
      });
    }
    storage.sql.exec(
      `UPDATE inbound_receipts
       SET work_state = ?, claimed_until = ?, retry_after = ?
       WHERE id = ?`,
      "claimed",
      parsed.claimUntilIso,
      null,
      parsed.receiptId,
    );
    return Schema.decodeSync(ClaimInboundReceiptResult)({
      receipt: requireInboundReceipt(storage, parsed.receiptId),
      claimed: true,
    });
  });
}

export function completeInboundReceipt(
  storage: AccountSqliteStorage,
  receiptId: string,
): InboundReceipt {
  return storage.transactionSync(() => {
    const current = requireInboundReceipt(storage, receiptId);
    if (isFinishedReceiptWork(current.workState)) {
      return current;
    }
    storage.sql.exec(
      `UPDATE inbound_receipts
       SET work_state = ?, claimed_until = ?, retry_after = ?, last_error = ?
       WHERE id = ?`,
      "indexed",
      null,
      null,
      null,
      receiptId,
    );
    return requireInboundReceipt(storage, receiptId);
  });
}

export function recordInboundReceiptRedrive(
  storage: AccountSqliteStorage,
  input: RecordInboundReceiptRedriveInput,
): InboundReceipt {
  const parsed = Schema.decodeSync(RecordInboundReceiptRedriveInput)(input);
  return storage.transactionSync(() => {
    const current = requireInboundReceipt(storage, parsed.receiptId);
    if (isFinishedReceiptWork(current.workState)) {
      return current;
    }
    if (isLiveUnexpiredClaim(current, parsed.nowIso)) {
      return current;
    }
    const attemptCount = current.attemptCount + 1;
    if (attemptCount >= parsed.attemptBudget) {
      storage.sql.exec(
        `UPDATE inbound_receipts
         SET work_state = ?, claimed_until = ?, retry_after = ?, attempt_count = ?, last_error = ?
         WHERE id = ?`,
        "operator_reprocess",
        null,
        null,
        attemptCount,
        "attempt_budget",
        parsed.receiptId,
      );
      return requireInboundReceipt(storage, parsed.receiptId);
    }
    storage.sql.exec(
      `UPDATE inbound_receipts
       SET work_state = ?, claimed_until = ?, retry_after = ?, attempt_count = ?
       WHERE id = ?`,
      "ready",
      null,
      parsed.retryAfterIso,
      attemptCount,
      parsed.receiptId,
    );
    return requireInboundReceipt(storage, parsed.receiptId);
  });
}

export function listInboundReceiptWork(
  storage: AccountSqliteStorage,
  input: ListInboundReceiptWorkInput,
): ListInboundReceiptWorkPage {
  const parsed = Schema.decodeSync(ListInboundReceiptWorkInput)(input);
  const limit = receiptWorkPageLimit(parsed.limit);
  return storage.transactionSync(() => {
    const rows =
      parsed.kind === "ready"
        ? storage.sql
            .exec(
              `SELECT ${INBOUND_RECEIPT_COLUMNS}
               FROM inbound_receipts
               WHERE work_state = ?
                 AND (retry_after IS NULL OR retry_after <= ?)
               ORDER BY received_at ASC, id ASC
               LIMIT ?`,
              "ready",
              parsed.nowIso,
              limit + 1,
            )
            .toArray()
        : storage.sql
            .exec(
              `SELECT ${INBOUND_RECEIPT_COLUMNS}
               FROM inbound_receipts
               WHERE work_state = ?
                 AND claimed_until IS NOT NULL
                 AND claimed_until <= ?
               ORDER BY claimed_until ASC, id ASC
               LIMIT ?`,
              "claimed",
              parsed.nowIso,
              limit + 1,
            )
            .toArray();
    const decoded = Schema.decodeUnknownSync(Schema.Array(InboundReceiptRow))(rows);
    const pageRows = decoded.slice(0, limit);
    const items = pageRows.map(toInboundReceipt);
    const overflow = decoded[limit];
    if (overflow === undefined) {
      return Schema.decodeSync(ListInboundReceiptWorkPage)({
        items,
        nextCursor: null,
      });
    }
    const last = pageRows[pageRows.length - 1];
    if (last === undefined) {
      return Schema.decodeSync(ListInboundReceiptWorkPage)({
        items,
        nextCursor: null,
      });
    }
    return Schema.decodeSync(ListInboundReceiptWorkPage)({
      items,
      nextCursor: {
        receivedAt: last.received_at,
        id: last.id,
      },
    });
  });
}

export function getRecoveryScan(
  storage: AccountSqliteStorage,
  scanId: string,
): RecoveryScan | null {
  return storage.transactionSync(() => readRecoveryScan(storage, scanId));
}

export function putRecoveryScan(
  storage: AccountSqliteStorage,
  input: PutRecoveryScanInput,
): RecoveryScan {
  const parsed = Schema.decodeSync(PutRecoveryScanInput)(input);
  return storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO recovery_scans (id, cursor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      parsed.scanId,
      parsed.cursor,
      parsed.updatedAt,
    );
    const scan = readRecoveryScan(storage, parsed.scanId);
    if (scan === null) {
      throw new AccountStoreUnexpectedError({
        cause: `Missing recovery scan ${parsed.scanId}`,
      });
    }
    return scan;
  });
}

export function listItemsByIds(
  storage: AccountSqliteStorage,
  ids: ReadonlyArray<string>,
): ReadonlyArray<CommandItem> {
  const itemIds = Schema.decodeSync(ItemIdList)(ids);
  const rows = storage.sql
    .exec(
      `SELECT command_items.id AS id,
              command_items.group_id AS group_id,
              command_items.label AS label
       FROM command_items
       JOIN json_each(?) AS requested
         ON requested.value = command_items.id
       ORDER BY command_items.id`,
      JSON.stringify(itemIds),
    )
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(CommandItemRow))(rows).map(toCommandItem);
}

export function listSchemaTables(storage: AccountSqliteStorage): readonly string[] {
  const rows = storage.sql
    .exec(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(CatalogNameRow))(rows).map((row) => row.name);
}

export function listAppliedMigrations(
  storage: AccountSqliteStorage,
): ReadonlyArray<SchemaMigrationRow> {
  return readAppliedMigrations(storage);
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
  const supportedVersion = latestVersion(migrations);
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

function ensureAccountMeta(storage: AccountSqliteStorage, accountId: string, nowIso: string): void {
  const existing = firstAccountMeta(
    storage.sql.exec("SELECT account_id FROM account_meta").toArray(),
  );
  if (existing === undefined) {
    storage.sql.exec(
      "INSERT INTO account_meta (account_id, created_at) VALUES (?, ?)",
      accountId,
      nowIso,
    );
    return;
  }
  if (existing.account_id !== accountId) {
    throw new AccountIdentityError({
      message: `Durable Object name ${accountId} does not match stored account ${existing.account_id}`,
    });
  }
}

function readSchemaStatus(storage: AccountSqliteStorage): SchemaStatus {
  const applied = readAppliedMigrations(storage);
  const account = firstAccountMeta(
    storage.sql.exec("SELECT account_id FROM account_meta").toArray(),
  );
  if (account === undefined) {
    throw new AccountIdentityError({
      message: "AccountStore is missing account_meta",
    });
  }
  return Schema.decodeSync(SchemaStatus)({
    schemaVersion: latestAppliedVersion(applied),
    accountId: account.account_id,
  });
}

function latestVersion(migrations: readonly AccountMigration[]): number {
  let version = 0;
  for (const migration of migrations) {
    if (migration.version > version) {
      version = migration.version;
    }
  }
  return version === 0 ? accountSchemaVersion : version;
}

function latestAppliedVersion(applied: ReadonlyArray<SchemaMigrationRow>): number {
  const last = applied[applied.length - 1];
  return last === undefined ? 0 : last.version;
}

function toCommandItem(row: CommandItemRow): CommandItem {
  return Schema.decodeSync(CommandItem)({
    id: row.id,
    groupId: row.group_id,
    label: row.label,
  });
}

function firstAccountMeta(rows: ReadonlyArray<AccountSqlRow>): AccountMetaRow | undefined {
  const row = rows[0];
  if (row === undefined) return undefined;
  return Schema.decodeUnknownSync(AccountMetaRow)(row);
}

export type ThreadedMailWrite =
  | { readonly direction: "inbound"; readonly input: AcceptInboundInput }
  | { readonly direction: "outbound"; readonly input: AcceptOutboundInput };

export function writeThreadedMail(
  storage: AccountSqliteStorage,
  write: ThreadedMailWrite,
  options: PersistThreadingOptions,
): AcceptMessageResult {
  const parsed = write.input;
  const headers = normalizeInboundRfcHeaders(
    parsed.rfcMessageId,
    parsed.inReplyToHeader,
    parsed.referencesHeader,
  );
  const result = acceptThreadedMessage(
    sqliteThreadingGraph(storage),
    {
      messageId: parsed.messageId,
      mailboxId: parsed.mailboxId,
      direction: write.direction,
      rfcMessageId: headers.rfcMessageId,
      inReplyTo: headers.inReplyTo,
      referencesOldestFirst: headers.referencesOldestFirst,
      referencesTruncated: headers.referencesTruncated,
      occurredAt: parsed.occurredAt,
      nowIso: parsed.nowIso,
    },
    options.ids,
    options.ancestryWorkBudget,
  );
  persistMessageContent(storage, write);
  return Schema.decodeSync(AcceptMessageResult)({
    messageId: result.messageId,
    nodeId: result.nodeId,
    threadHandle: requireThreadHandle(result.nodeId),
    componentRootId: result.componentRootId,
    claimedRfcMessageId: result.claimedRfcMessageId,
    parentNodeId: result.parentNodeId,
    diagnostics: result.diagnostics.map(toPublicDiagnostic),
  });
}

export function writeOwnRfcIdentityClaim(
  storage: AccountSqliteStorage,
  claim: OwnRfcIdentityClaim,
): OwnRfcIdentityClaimResult {
  return claimOwnRfcIdentity(sqliteThreadingGraph(storage), claim);
}

function sqliteThreadingGraph(storage: AccountSqliteStorage): ThreadingGraph {
  return {
    hasMessage(messageId) {
      return (
        firstDecoded(
          Schema.decodeUnknownSync(MessageIdPresenceRow),
          storage.sql.exec("SELECT id FROM messages WHERE id = ?", messageId).toArray(),
        ) !== undefined
      );
    },
    getRfcLookup(rfcId) {
      const row = firstDecoded(
        Schema.decodeUnknownSync(RfcLookupRow),
        storage.sql
          .exec(
            "SELECT rfc_message_id, node_id, claimant_node_id FROM rfc_lookups WHERE rfc_message_id = ?",
            rfcId,
          )
          .toArray(),
      );
      if (row === undefined) {
        return null;
      }
      return toRfcLookupRecord(row);
    },
    getParent(nodeId) {
      const row = firstDecoded(
        Schema.decodeUnknownSync(ParentEdgeRow),
        storage.sql
          .exec("SELECT parent_node_id FROM thread_parent_edges WHERE child_node_id = ?", nodeId)
          .toArray(),
      );
      return row === undefined ? null : row.parent_node_id;
    },
    findRoot(nodeId) {
      return findSqliteRoot(storage, nodeId);
    },
    createNode(nodeId, kind, nowIso) {
      storage.sql.exec(
        "INSERT INTO thread_nodes (id, kind, created_at) VALUES (?, ?, ?)",
        nodeId,
        kind,
        nowIso,
      );
      storage.sql.exec(
        "INSERT INTO thread_component_links (node_id, parent_node_id, rank, size) VALUES (?, ?, ?, ?)",
        nodeId,
        nodeId,
        0,
        1,
      );
    },
    fillPlaceholder(nodeId) {
      storage.sql.exec("UPDATE thread_nodes SET kind = ? WHERE id = ?", "message", nodeId);
    },
    putRfcLookup(rfcId, nodeId, claimantNodeId) {
      const existing = firstDecoded(
        Schema.decodeUnknownSync(RfcLookupRow),
        storage.sql
          .exec(
            "SELECT rfc_message_id, node_id, claimant_node_id FROM rfc_lookups WHERE rfc_message_id = ?",
            rfcId,
          )
          .toArray(),
      );
      if (existing === undefined) {
        storage.sql.exec(
          "INSERT INTO rfc_lookups (rfc_message_id, node_id, claimant_node_id) VALUES (?, ?, ?)",
          rfcId,
          nodeId,
          claimantNodeId,
        );
        return;
      }
      storage.sql.exec(
        "UPDATE rfc_lookups SET node_id = ?, claimant_node_id = ? WHERE rfc_message_id = ?",
        nodeId,
        claimantNodeId,
        rfcId,
      );
    },
    setParent(childNodeId, parentNodeId) {
      storage.sql.exec(
        "INSERT INTO thread_parent_edges (child_node_id, parent_node_id) VALUES (?, ?)",
        childNodeId,
        parentNodeId,
      );
    },
    repointChildren(fromNodeId, toNodeId) {
      storage.sql.exec(
        `UPDATE thread_parent_edges
         SET parent_node_id = ?
         WHERE parent_node_id = ? AND child_node_id <> ?`,
        toNodeId,
        fromNodeId,
        toNodeId,
      );
    },
    union(nodeA, nodeB) {
      return unionSqlite(storage, nodeA, nodeB);
    },
    addMessage(message) {
      storage.sql.exec(
        `INSERT INTO messages (
           id, node_id, mailbox_id, direction, rfc_message_id, in_reply_to_rfc_message_id,
           occurred_at, created_at, is_read, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.nodeId,
        message.mailboxId,
        message.direction,
        message.rfcMessageId,
        message.inReplyToRfcMessageId,
        message.occurredAt,
        message.createdAt,
        0,
        message.deletedAt,
      );
    },
    addReferences(messageId, referencesOldestFirst) {
      for (let position = 0; position < referencesOldestFirst.length; position += 1) {
        const rfcMessageId = referencesOldestFirst[position];
        if (rfcMessageId === undefined) {
          continue;
        }
        storage.sql.exec(
          "INSERT INTO message_references (message_id, position, rfc_message_id) VALUES (?, ?, ?)",
          messageId,
          position,
          rfcMessageId,
        );
      }
    },
    addDiagnostic(diagnostic) {
      storage.sql.exec(
        `INSERT INTO threading_diagnostics (id, message_id, node_id, kind, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        diagnostic.id,
        diagnostic.messageId,
        diagnostic.nodeId,
        diagnostic.kind,
        diagnostic.detail,
        diagnostic.createdAt,
      );
    },
  };
}

export function findSqliteRoot(storage: AccountSqliteStorage, nodeId: string): FindRootResult {
  const path: Array<string> = [];
  const seen = new Set<string>();
  let current = nodeId;
  let hops = 0;
  for (;;) {
    if (seen.has(current)) {
      throw new AccountStoreUnexpectedError({
        cause: `Thread component parent cycle at ${current}`,
      });
    }
    seen.add(current);
    const link = requireComponentLink(storage, current);
    hops += 1;
    if (link.parent_node_id === current) {
      for (const id of path) {
        storage.sql.exec(
          "UPDATE thread_component_links SET parent_node_id = ? WHERE node_id = ?",
          current,
          id,
        );
      }
      return { root: current, hops };
    }
    path.push(current);
    current = link.parent_node_id;
  }
}

function unionSqlite(storage: AccountSqliteStorage, nodeA: string, nodeB: string): number {
  const foundA = findSqliteRoot(storage, nodeA);
  const foundB = findSqliteRoot(storage, nodeB);
  if (foundA.root === foundB.root) {
    return foundA.hops + foundB.hops;
  }
  const linkA = requireComponentLink(storage, foundA.root);
  const linkB = requireComponentLink(storage, foundB.root);
  if (linkA.size > linkB.size || (linkA.size === linkB.size && foundA.root < foundB.root)) {
    storage.sql.exec(
      "UPDATE thread_component_links SET parent_node_id = ? WHERE node_id = ?",
      foundA.root,
      foundB.root,
    );
    storage.sql.exec(
      "UPDATE thread_component_links SET size = ?, rank = ? WHERE node_id = ?",
      linkA.size + linkB.size,
      linkA.size === linkB.size ? linkA.rank + 1 : linkA.rank,
      foundA.root,
    );
  } else {
    storage.sql.exec(
      "UPDATE thread_component_links SET parent_node_id = ? WHERE node_id = ?",
      foundB.root,
      foundA.root,
    );
    storage.sql.exec(
      "UPDATE thread_component_links SET size = ?, rank = ? WHERE node_id = ?",
      linkB.size + linkA.size,
      linkA.size === linkB.size ? linkB.rank + 1 : linkB.rank,
      foundB.root,
    );
  }
  return foundA.hops + foundB.hops;
}

function requireComponentLink(storage: AccountSqliteStorage, nodeId: string) {
  const link = firstDecoded(
    Schema.decodeUnknownSync(ComponentLinkRow),
    storage.sql
      .exec(
        "SELECT node_id, parent_node_id, rank, size FROM thread_component_links WHERE node_id = ?",
        nodeId,
      )
      .toArray(),
  );
  if (link === undefined) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing thread component link for node ${nodeId}`,
    });
  }
  return link;
}

function toRfcLookupRecord(row: RfcLookupRow): RfcLookupRecord {
  return {
    rfcMessageId: Schema.decodeSync(NormalizedRfcMessageId)(row.rfc_message_id),
    nodeId: row.node_id,
    claimantNodeId: row.claimant_node_id,
  };
}

export function requireThreadHandle(nodeId: string): string {
  const handle = nodeThreadHandle(nodeId);
  if (handle === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Thread node id ${nodeId} is not a UUID`,
    });
  }
  return handle;
}

function toConversationMessage(row: ConversationMessageRow): ConversationMessage {
  return Schema.decodeSync(ConversationMessage)({
    id: row.id,
    nodeId: row.node_id,
    mailboxId: row.mailbox_id,
    direction: row.direction,
    rfcMessageId: row.rfc_message_id,
    parentNodeId: row.parent_node_id,
    occurredAt: row.occurred_at,
    deletedAt: row.deleted_at,
  });
}

function toThreadingDiagnostic(row: ThreadingDiagnosticRow): ThreadingDiagnostic {
  return Schema.decodeSync(ThreadingDiagnostic)({
    id: row.id,
    messageId: row.message_id,
    nodeId: row.node_id,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.created_at,
  });
}

function toPublicDiagnostic(diagnostic: ThreadingDiagnosticRecord): ThreadingDiagnostic {
  return Schema.decodeSync(ThreadingDiagnostic)({
    id: diagnostic.id,
    messageId: diagnostic.messageId,
    nodeId: diagnostic.nodeId,
    kind: diagnostic.kind,
    detail: diagnostic.detail,
    createdAt: diagnostic.createdAt,
  });
}

const INBOUND_RECEIPT_COLUMNS = `id, digest, envelope_from, envelope_to, raw_key, manifest_key,
                advertised_raw_size, consumed_bytes, received_at, created_at,
                forward_outcome, forward_destination, forward_error, work_state,
                policy_error, claimed_until, retry_after, attempt_count, last_error`;

function isFinishedReceiptWork(state: ReceiptWorkState): boolean {
  return (
    state === "indexed" ||
    state === "policy_failed" ||
    state === "terminal" ||
    state === "operator_reprocess"
  );
}

function isLiveUnexpiredClaim(receipt: InboundReceipt, nowIso: string): boolean {
  return (
    receipt.workState === "claimed" &&
    receipt.claimedUntil !== null &&
    receipt.claimedUntil > nowIso
  );
}

function receiptWorkPageLimit(limit: number | undefined): number {
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
        `SELECT ${INBOUND_RECEIPT_COLUMNS}
         FROM inbound_receipts
         WHERE id = ?`,
        receiptId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toInboundReceipt(row);
}

function readRecoveryScan(storage: AccountSqliteStorage, scanId: string): RecoveryScan | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(RecoveryScanRow),
    storage.sql
      .exec("SELECT id, cursor, updated_at FROM recovery_scans WHERE id = ?", scanId)
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return Schema.decodeSync(RecoveryScan)({
    scanId: row.id,
    cursor: row.cursor,
    updatedAt: row.updated_at,
  });
}

function requireInboundReceipt(storage: AccountSqliteStorage, receiptId: string): InboundReceipt {
  const receipt = readInboundReceipt(storage, receiptId);
  if (receipt === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing inbound receipt ${receiptId}`,
    });
  }
  return receipt;
}

function toInboundReceipt(row: InboundReceiptRow): InboundReceipt {
  return Schema.decodeSync(InboundReceipt)({
    receiptId: row.id,
    digest: row.digest,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    rawKey: row.raw_key,
    manifestKey: row.manifest_key,
    advertisedRawSize: row.advertised_raw_size,
    consumedBytes: row.consumed_bytes,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    forward: toForwardObservation(row),
    workState: row.work_state,
    policyError: row.policy_error,
    claimedUntil: row.claimed_until,
    retryAfter: row.retry_after,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  });
}

function toForwardObservation(row: InboundReceiptRow): ReceiptForwardObservation {
  if (row.forward_outcome === "none") {
    return { kind: "none" };
  }
  if (row.forward_destination === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Inbound receipt ${row.id} is missing a forward destination`,
    });
  }
  if (row.forward_outcome === "success") {
    return { kind: "success", destination: row.forward_destination };
  }
  if (row.forward_outcome === "unknown") {
    return { kind: "unknown", destination: row.forward_destination };
  }
  if (row.forward_error === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Inbound receipt ${row.id} is missing a forward error`,
    });
  }
  return {
    kind: "failure",
    destination: row.forward_destination,
    error: row.forward_error,
  };
}

function nextForwardObservation(
  current: ReceiptForwardObservation,
  incoming: ReceiptForwardObservation,
): ReceiptForwardObservation {
  if (current.kind === "success" || current.kind === "failure") {
    return current;
  }
  if (current.kind === "unknown") {
    if (incoming.kind === "success" || incoming.kind === "failure") {
      return incoming;
    }
    return current;
  }
  if (incoming.kind === "none") {
    return current;
  }
  return incoming;
}

type ForwardObservationColumns = {
  readonly outcome: "none" | "success" | "failure" | "unknown";
  readonly destination: string | null;
  readonly error: string | null;
};

function forwardObservationColumns(
  observation: ReceiptForwardObservation,
): ForwardObservationColumns {
  if (observation.kind === "none") {
    return { outcome: "none", destination: null, error: null };
  }
  if (observation.kind === "success") {
    return { outcome: "success", destination: observation.destination, error: null };
  }
  if (observation.kind === "unknown") {
    return { outcome: "unknown", destination: observation.destination, error: null };
  }
  return {
    outcome: "failure",
    destination: observation.destination,
    error: observation.error,
  };
}

function persistMessageContent(storage: AccountSqliteStorage, write: ThreadedMailWrite): void {
  const parsed = write.input;
  const subject = parsed.subject === undefined ? null : parsed.subject;
  const textBody = parsed.textBody === undefined ? null : parsed.textBody;
  const htmlBody = parsed.htmlBody === undefined ? null : parsed.htmlBody;
  const hasRemoteImages = parsed.hasRemoteImages === true;
  storage.sql.exec(
    `UPDATE messages
     SET subject = ?, text_body = ?, html_body = ?, has_remote_images = ?, parsed_date = ?,
         updated_at = ?
     WHERE id = ?`,
    subject,
    textBody,
    htmlBody,
    hasRemoteImages ? 1 : 0,
    write.direction === "inbound" ? write.input.parsedDate : null,
    parsed.nowIso,
    parsed.messageId,
  );
  insertParticipants(storage, parsed.messageId, "from", parsed.from);
  insertParticipants(storage, parsed.messageId, "reply_to", parsed.replyTo);
  insertParticipants(storage, parsed.messageId, "to", parsed.to);
  insertParticipants(storage, parsed.messageId, "cc", parsed.cc);
  insertAttachments(storage, parsed.messageId, parsed.nowIso, parsed.attachments);
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
         id, message_id, role, position, address, comparison_key, display_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `pt_${messageId}_${role}_${position}`,
      messageId,
      role,
      position,
      contact.address,
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

function conflictOrRethrow(cause: unknown, groupId: string, id: string): CommandConflictError {
  if (cause instanceof CommandConflictError) return cause;
  const decoded = Schema.decodeUnknownResult(SqliteErrorMessage)(cause);
  if (Result.isSuccess(decoded) && decoded.success.message.includes("UNIQUE")) {
    return new CommandConflictError({ groupId, id });
  }
  throw toRethrow(cause);
}

function toRethrow(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new AccountStoreUnexpectedError({ cause });
}
