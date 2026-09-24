import * as Schema from "effect/Schema";

import { toSendingIdentity } from "./administration.ts";
import {
  emptyParticipants,
  loadParticipantsByMessageIds,
  loadReferencesByMessageIds,
  pageLimit,
} from "./commands.ts";
import { cancelUndispatchedJobsForMessages } from "./jobs.ts";
import {
  AddressRow,
  AttachmentWithMessageRow,
  MessageBodyRow,
  MessageIdPresenceRow,
  MessageOutboundJobRow,
  MessageSummaryRow,
  StoredAttachmentRow,
  StoredMessageSourceRow,
  ThreadHeadRow,
  ThreadIdRow,
  ThreadStatsRow,
  type AccountAttachmentMeta,
  type AccountSendingIdentity,
  type ListMessageSummariesQuery,
  type ListThreadMessageSummariesQuery,
  type ListThreadSummariesQuery,
  type MailboxScope,
  type MessageBody,
  type MessageOutboundJob,
  type MessageSummary,
  type MessageSummaryPage,
  type PageCursor,
  type StoredAttachment,
  type StoredMessageSource,
  type ThreadMessageSummaryPage,
  type ThreadSummary,
  type ThreadSummaryPage,
} from "./domain.ts";
import { InboundMessageIntegrityError, ThreadNotFoundError } from "./errors.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";

const MESSAGE_SUMMARY_SELECT = `msg.id AS id,
       msg.thread_id AS thread_id,
       msg.mailbox_id AS mailbox_id,
       msg.direction AS direction,
       msg.subject AS subject,
       msg.occurred_at AS occurred_at,
       msg.parsed_date AS parsed_date,
       msg.rfc_message_id AS rfc_message_id,
       msg.in_reply_to_rfc_message_id AS in_reply_to_rfc_message_id,
       (SELECT parent.id FROM messages parent
        WHERE parent.rfc_message_id = msg.in_reply_to_rfc_message_id AND parent.id <> msg.id
        ORDER BY parent.created_at, parent.id LIMIT 1) AS parent_message_id,
       msg.has_remote_images AS has_remote_images,
       msg.is_read AS is_read,
       msg.read_at AS read_at,
       msg.created_at AS created_at,
       msg.updated_at AS updated_at,
       receipt.id AS receipt_id,
       receipt.envelope_from AS receipt_envelope_from,
       receipt.envelope_to AS receipt_envelope_to,
       receipt.forward_outcome AS receipt_forward_outcome,
       receipt.forward_destination AS receipt_forward_destination`;

const MESSAGE_SUMMARY_FROM = `FROM messages msg
LEFT JOIN inbound_receipts receipt ON receipt.id = msg.id AND msg.direction = 'inbound'`;

/** Thread open: one page of a thread's live messages, oldest first, off `messages_thread_idx`. */
export function threadMessagesSql(withCursor: boolean): string {
  const cursor = withCursor
    ? " AND (msg.occurred_at > ? OR (msg.occurred_at = ? AND msg.id > ?))"
    : "";
  return `SELECT ${MESSAGE_SUMMARY_SELECT}
${MESSAGE_SUMMARY_FROM}
WHERE msg.thread_id = ? AND msg.deleted_at IS NULL${cursor}
ORDER BY msg.occurred_at ASC, msg.id ASC
LIMIT ?`;
}

export function listMessageSummaries(
  storage: AccountSqliteStorage,
  query: ListMessageSummariesQuery,
): MessageSummaryPage {
  const scope = query.mailboxScope;
  if (scope !== "all" && scope.length === 0) {
    return emptyMessagePage();
  }
  if (query.addressId !== undefined && !mailboxInScope(query.addressId, scope)) {
    return emptyMessagePage();
  }
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const lookahead = selectMessageSummaryRows(storage, query, scope, limit + 1);
    const pageRows = lookahead.slice(0, limit);
    return {
      items: enrichMessageSummaries(storage, pageRows),
      nextCursor: nextMessageCursor(lookahead, pageRows, limit),
    };
  });
}

export function listThreadSummaries(
  storage: AccountSqliteStorage,
  query: ListThreadSummariesQuery,
): ThreadSummaryPage {
  const scope = query.mailboxScope;
  if (scope !== "all" && scope.length === 0) {
    return { items: [], nextCursor: null };
  }
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const lookahead = selectThreadHeads(storage, query, scope, limit + 1);
    const heads = lookahead.slice(0, limit);
    const last = heads[heads.length - 1];
    return {
      items: enrichThreadSummaries(storage, heads),
      nextCursor:
        lookahead.length > limit && last !== undefined
          ? { at: last.last_activity_at, id: last.latest_message_id }
          : null,
    };
  });
}

export function listThreadMessageSummaries(
  storage: AccountSqliteStorage,
  handle: string,
  query: ListThreadMessageSummariesQuery,
): ThreadMessageSummaryPage {
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const threadId = resolveThread(storage, handle, query.mailboxScope);
    const cursor = query.cursor;
    const binds =
      cursor === undefined
        ? [threadId, limit + 1]
        : [threadId, cursor.at, cursor.at, cursor.id, limit + 1];
    const lookahead = Schema.decodeUnknownSync(Schema.Array(MessageSummaryRow))(
      storage.sql.exec(threadMessagesSql(cursor !== undefined), ...binds).toArray(),
    );
    const pageRows = lookahead.slice(0, limit);
    return {
      threadId,
      items: enrichMessageSummaries(storage, pageRows),
      nextCursor: nextMessageCursor(lookahead, pageRows, limit),
    };
  });
}

export function getMessageSummary(
  storage: AccountSqliteStorage,
  messageId: string,
  scope: MailboxScope,
): MessageSummary | null {
  return storage.transactionSync(() => {
    const row = firstDecoded(
      Schema.decodeUnknownSync(MessageSummaryRow),
      storage.sql
        .exec(
          `SELECT ${MESSAGE_SUMMARY_SELECT}
           ${MESSAGE_SUMMARY_FROM}
           WHERE msg.id = ? AND msg.deleted_at IS NULL`,
          messageId,
        )
        .toArray(),
    );
    if (row === undefined || !mailboxInScope(row.mailbox_id, scope)) {
      return null;
    }
    const items = enrichMessageSummaries(storage, [row]);
    return items[0] ?? null;
  });
}

export function getMessageBody(
  storage: AccountSqliteStorage,
  messageId: string,
  scope: MailboxScope,
): MessageBody | null {
  return storage.transactionSync(() => {
    const row = firstDecoded(
      Schema.decodeUnknownSync(MessageBodyRow),
      storage.sql
        .exec(
          `SELECT id, mailbox_id, text_body, html_body, has_remote_images, deleted_at
           FROM messages
           WHERE id = ?`,
          messageId,
        )
        .toArray(),
    );
    if (row === undefined || row.deleted_at !== null || !mailboxInScope(row.mailbox_id, scope)) {
      return null;
    }
    return {
      id: row.id,
      mailboxId: row.mailbox_id,
      textBody: row.text_body,
      htmlBody: row.html_body,
      hasRemoteImages: row.has_remote_images === 1,
    };
  });
}

export function getStoredAttachment(
  storage: AccountSqliteStorage,
  messageId: string,
  attachmentId: string,
  scope: MailboxScope,
): StoredAttachment | null {
  return storage.transactionSync(() => {
    const row = firstDecoded(
      Schema.decodeUnknownSync(StoredAttachmentRow),
      storage.sql
        .exec(
          `SELECT attachments.message_id AS message_id,
                  messages.mailbox_id AS mailbox_id,
                  messages.deleted_at AS deleted_at,
                  attachments.id AS id,
                  attachments.filename AS filename,
                  attachments.mime_type AS mime_type,
                  attachments.size AS size,
                  attachments.r2_key AS r2_key,
                  attachments.content_id AS content_id,
                  attachments.disposition AS disposition,
                  attachments.is_inline AS is_inline
           FROM attachments
           JOIN messages ON messages.id = attachments.message_id
           WHERE attachments.id = ? AND attachments.message_id = ?`,
          attachmentId,
          messageId,
        )
        .toArray(),
    );
    if (row === undefined || row.deleted_at !== null || !mailboxInScope(row.mailbox_id, scope)) {
      return null;
    }
    return {
      messageId: row.message_id,
      mailboxId: row.mailbox_id,
      meta: toAttachmentMeta(row),
      r2Key: row.r2_key,
    };
  });
}

export function getMessageSource(
  storage: AccountSqliteStorage,
  messageId: string,
  scope: MailboxScope,
): StoredMessageSource | null {
  return storage.transactionSync(() => {
    const row = firstDecoded(
      Schema.decodeUnknownSync(StoredMessageSourceRow),
      storage.sql
        .exec(
          `SELECT msg.id AS id,
                  msg.mailbox_id AS mailbox_id,
                  msg.direction AS direction,
                  msg.deleted_at AS deleted_at,
                  receipt.raw_key AS raw_key
           FROM messages msg
           LEFT JOIN inbound_receipts receipt ON receipt.id = msg.id AND msg.direction = 'inbound'
           WHERE msg.id = ?`,
          messageId,
        )
        .toArray(),
    );
    if (row === undefined || row.deleted_at !== null || !mailboxInScope(row.mailbox_id, scope)) {
      return null;
    }
    if (row.direction === "outbound") {
      return { direction: "outbound", messageId: row.id, mailboxId: row.mailbox_id };
    }
    if (row.raw_key === null) {
      throw new InboundMessageIntegrityError({
        messageId: row.id,
        reason: "receipt_missing",
      });
    }
    return {
      direction: "inbound",
      messageId: row.id,
      mailboxId: row.mailbox_id,
      rawKey: row.raw_key,
    };
  });
}

export function markThreadRead(
  storage: AccountSqliteStorage,
  handle: string,
  isRead: boolean,
  mailboxScope: MailboxScope,
  nowIso: string,
): void {
  storage.transactionSync(() => {
    const threadId = resolveThread(storage, handle, mailboxScope);
    storage.sql.exec(
      `UPDATE messages SET is_read = ?, read_at = ?, updated_at = ?
       WHERE thread_id = ? AND deleted_at IS NULL AND direction = 'inbound'${inScope(mailboxScope)}`,
      isRead ? 1 : 0,
      isRead ? nowIso : null,
      nowIso,
      threadId,
      ...scopeBinds(mailboxScope),
    );
  });
}

export function softDeleteThread(
  storage: AccountSqliteStorage,
  handle: string,
  mailboxScope: MailboxScope,
  deletedAt: string,
): void {
  storage.transactionSync(() => {
    const threadId = resolveThread(storage, handle, mailboxScope);
    const live = `WHERE thread_id = ? AND deleted_at IS NULL${inScope(mailboxScope)}`;
    const messageIds = Schema.decodeUnknownSync(Schema.Array(MessageIdPresenceRow))(
      storage.sql
        .exec(`SELECT id FROM messages ${live}`, threadId, ...scopeBinds(mailboxScope))
        .toArray(),
    ).map((row) => row.id);
    cancelUndispatchedJobsForMessages(storage, messageIds, deletedAt);
    storage.sql.exec(
      `UPDATE messages SET deleted_at = ? ${live}`,
      deletedAt,
      threadId,
      ...scopeBinds(mailboxScope),
    );
  });
}

function selectMessageSummaryRows(
  storage: AccountSqliteStorage,
  query: ListMessageSummariesQuery,
  scope: MailboxScope,
  limit: number,
): ReadonlyArray<MessageSummaryRow> {
  const clauses: Array<string> = ["msg.deleted_at IS NULL"];
  const binds: Array<string | number> = [];
  if (scope !== "all") {
    clauses.push("msg.mailbox_id IN (SELECT value FROM json_each(?))");
    binds.push(bindJsonStringArray(scope));
  }
  if (query.direction !== undefined) {
    clauses.push("msg.direction = ?");
    binds.push(query.direction);
  }
  if (query.addressId !== undefined) {
    clauses.push("msg.mailbox_id = ?");
    binds.push(query.addressId);
  }
  if (query.since !== undefined) {
    clauses.push("msg.occurred_at >= ?");
    binds.push(query.since);
  }
  if (query.unread === true) {
    clauses.push("msg.direction = 'inbound' AND msg.is_read = 0");
  }
  if (query.cursor !== undefined) {
    clauses.push("(msg.occurred_at < ? OR (msg.occurred_at = ? AND msg.id < ?))");
    binds.push(query.cursor.at, query.cursor.at, query.cursor.id);
  }
  const sql = `SELECT ${MESSAGE_SUMMARY_SELECT}
       ${MESSAGE_SUMMARY_FROM}
       WHERE ${clauses.join(" AND ")}
       ORDER BY msg.occurred_at DESC, msg.id DESC
       LIMIT ?`;
  binds.push(limit);
  return Schema.decodeUnknownSync(Schema.Array(MessageSummaryRow))(
    storage.sql.exec(sql, ...binds).toArray(),
  );
}

// Newest-first walk over live messages that keeps each thread's newest live message (its head).
// A scoped reader sees a thread when any live message of it is in scope.
function selectThreadHeads(
  storage: AccountSqliteStorage,
  query: ListThreadSummariesQuery,
  scope: MailboxScope,
  limit: number,
): ReadonlyArray<ThreadHeadRow> {
  const clauses = [
    "m.deleted_at IS NULL",
    `NOT EXISTS (
       SELECT 1 FROM messages n
       WHERE n.thread_id = m.thread_id AND n.deleted_at IS NULL
         AND (n.occurred_at > m.occurred_at OR (n.occurred_at = m.occurred_at AND n.id > m.id))
     )`,
  ];
  const binds: Array<string | number> = [];
  if (query.cursor !== undefined) {
    clauses.push("(m.occurred_at < ? OR (m.occurred_at = ? AND m.id < ?))");
    binds.push(query.cursor.at, query.cursor.at, query.cursor.id);
  }
  if (scope !== "all") {
    clauses.push(`EXISTS (
       SELECT 1 FROM messages s
       WHERE s.thread_id = m.thread_id AND s.deleted_at IS NULL${inScope(scope, "s.mailbox_id")}
     )`);
    binds.push(...scopeBinds(scope));
  }
  return Schema.decodeUnknownSync(Schema.Array(ThreadHeadRow))(
    storage.sql
      .exec(
        `SELECT m.thread_id AS thread_id,
                m.id AS latest_message_id,
                m.occurred_at AS last_activity_at,
                m.subject AS subject
         FROM messages m
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.occurred_at DESC, m.id DESC
         LIMIT ?`,
        ...binds,
        limit,
      )
      .toArray(),
  );
}

function enrichThreadSummaries(
  storage: AccountSqliteStorage,
  heads: ReadonlyArray<ThreadHeadRow>,
): ReadonlyArray<ThreadSummary> {
  if (heads.length === 0) {
    return [];
  }
  const statsById = loadThreadStats(
    storage,
    heads.map((head) => head.thread_id),
  );
  const participantsById = loadParticipantsByMessageIds(
    storage,
    heads.map((head) => head.latest_message_id),
  );
  const involvedIds = [...statsById.values()].flatMap((stats) =>
    splitGroupConcat(stats.involved_mailbox_ids),
  );
  const identitiesById = loadSendingIdentitiesByIds(storage, involvedIds);
  return heads.map((head) => {
    const stats = statsById.get(head.thread_id);
    const participants = participantsById.get(head.latest_message_id) ?? emptyParticipants();
    return {
      threadId: head.thread_id,
      subject: head.subject,
      latestSender: participants.from[0] ?? null,
      latestRecipients: participants.to,
      unreadCount: stats?.unread_count ?? 0,
      messageCount: stats?.message_count ?? 0,
      involvedMailboxIdentities: splitGroupConcat(stats?.involved_mailbox_ids ?? null).flatMap(
        (mailboxId) => identitiesById.get(mailboxId) ?? [],
      ),
      lastActivityAt: head.last_activity_at,
    };
  });
}

// Page stats: computed for the page's threads only.
function loadThreadStats(
  storage: AccountSqliteStorage,
  threadIds: ReadonlyArray<string>,
): ReadonlyMap<string, ThreadStatsRow> {
  const rows = Schema.decodeUnknownSync(Schema.Array(ThreadStatsRow))(
    storage.sql
      .exec(
        `SELECT thread_id,
                COUNT(*) AS message_count,
                SUM(CASE WHEN direction = 'inbound' AND is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
                GROUP_CONCAT(DISTINCT mailbox_id) AS involved_mailbox_ids
         FROM messages
         WHERE thread_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
         GROUP BY thread_id`,
        bindJsonStringArray(threadIds),
      )
      .toArray(),
  );
  return new Map(rows.map((row) => [row.thread_id, row]));
}

function loadSendingIdentitiesByIds(
  storage: AccountSqliteStorage,
  ids: ReadonlyArray<string>,
): ReadonlyMap<string, AccountSendingIdentity> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(AddressRow))(
    storage.sql
      .exec(
        `SELECT addresses.id AS id,
                addresses.local_part AS local_part,
                addresses.address AS address,
                addresses.display_name AS display_name,
                addresses.active AS active,
                addresses.forwarding_destination_id AS forwarding_destination_id,
                addresses.created_at AS created_at,
                addresses.updated_at AS updated_at
         FROM addresses
         JOIN json_each(?) AS requested ON requested.value = addresses.id
         WHERE addresses.active = 1`,
        bindJsonStringArray(ids),
      )
      .toArray(),
  );
  return new Map(rows.map((row) => [row.id, toSendingIdentity(row)]));
}

const UNKNOWN_OUTBOUND_JOB: MessageOutboundJob = {
  state: "unknown",
  failureClass: null,
  failureDetail: null,
  providerMessageId: null,
};

function enrichMessageSummaries(
  storage: AccountSqliteStorage,
  rows: ReadonlyArray<MessageSummaryRow>,
): ReadonlyArray<MessageSummary> {
  const ids = rows.map((row) => row.id);
  const participantsById = loadParticipantsByMessageIds(storage, ids);
  const referencesById = loadReferencesByMessageIds(storage, ids);
  const attachmentsById = loadAttachmentsByMessageIds(storage, ids);
  const jobsById = loadOutboundJobsByMessageIds(storage, ids);
  const items: Array<MessageSummary> = [];
  for (const row of rows) {
    const participants = participantsById.get(row.id) ?? emptyParticipants();
    const summaryFields = {
      id: row.id,
      threadId: row.thread_id,
      parentMessageId: row.parent_message_id,
      mailboxId: row.mailbox_id,
      subject: row.subject,
      occurredAt: row.occurred_at,
      from: participants.from,
      replyTo: participants.replyTo,
      to: participants.to,
      cc: participants.cc,
      hasRemoteImages: row.has_remote_images === 1,
      rfcMessageId: row.rfc_message_id,
      inReplyToRfcMessageId: row.in_reply_to_rfc_message_id,
      references: referencesById.get(row.id) ?? [],
      attachments: attachmentsById.get(row.id) ?? [],
      isRead: row.is_read === 1,
      readAt: row.read_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.direction === "inbound") {
      const receipt = requireInboundSummaryReceipt(row);
      items.push({
        direction: "inbound",
        ...summaryFields,
        envelopeFrom: receipt.envelopeFrom,
        envelopeTo: receipt.envelopeTo,
        parsedDate: row.parsed_date,
        forwardOutcome: receipt.forwardOutcome,
        forwardDestination: row.receipt_forward_destination,
      });
      continue;
    }
    items.push({
      direction: "outbound",
      ...summaryFields,
      outboundJob: jobsById.get(row.id) ?? UNKNOWN_OUTBOUND_JOB,
    });
  }
  return items;
}

function requireInboundSummaryReceipt(row: MessageSummaryRow) {
  if (
    row.receipt_id === null ||
    row.receipt_envelope_from === null ||
    row.receipt_envelope_to === null ||
    row.receipt_forward_outcome === null
  ) {
    throw new InboundMessageIntegrityError({
      messageId: row.id,
      reason: "receipt_missing",
    });
  }
  return {
    envelopeFrom: row.receipt_envelope_from,
    envelopeTo: row.receipt_envelope_to,
    forwardOutcome: row.receipt_forward_outcome,
  };
}

function loadOutboundJobsByMessageIds(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
): ReadonlyMap<string, MessageOutboundJob> {
  const byId = new Map<string, MessageOutboundJob>();
  if (messageIds.length === 0) {
    return byId;
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(MessageOutboundJobRow))(
    storage.sql
      .exec(
        `SELECT outbound_jobs.message_id AS message_id,
                outbound_jobs.state AS state,
                outbound_jobs.failure_class AS failure_class,
                outbound_jobs.failure_detail AS failure_detail,
                outbound_jobs.provider_message_id AS provider_message_id
         FROM outbound_jobs
         JOIN json_each(?) AS requested ON requested.value = outbound_jobs.message_id
         WHERE outbound_jobs.purpose = 'message'`,
        bindJsonStringArray(messageIds),
      )
      .toArray(),
  );
  for (const row of rows) {
    byId.set(row.message_id, {
      state: row.state,
      failureClass: row.failure_class,
      failureDetail: row.failure_detail,
      providerMessageId: row.provider_message_id,
    });
  }
  return byId;
}

function loadAttachmentsByMessageIds(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<AccountAttachmentMeta>> {
  const byId = new Map<string, Array<AccountAttachmentMeta>>();
  for (const id of messageIds) {
    byId.set(id, []);
  }
  if (messageIds.length === 0) {
    return byId;
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(AttachmentWithMessageRow))(
    storage.sql
      .exec(
        `SELECT attachments.message_id AS message_id,
                attachments.id AS id,
                attachments.filename AS filename,
                attachments.mime_type AS mime_type,
                attachments.size AS size,
                attachments.r2_key AS r2_key,
                attachments.content_id AS content_id,
                attachments.disposition AS disposition,
                attachments.is_inline AS is_inline
         FROM attachments
         JOIN json_each(?) AS requested ON requested.value = attachments.message_id
         ORDER BY attachments.message_id, attachments.position`,
        bindJsonStringArray(messageIds),
      )
      .toArray(),
  );
  for (const row of rows) {
    const list = byId.get(row.message_id) ?? [];
    list.push(toAttachmentMeta(row));
    byId.set(row.message_id, list);
  }
  return byId;
}

// Resolves any message id (live or deleted) to its current thread, if that thread still has a live
// message in scope.
function resolveThread(
  storage: AccountSqliteStorage,
  handle: string,
  mailboxScope: MailboxScope,
): string {
  const row = firstDecoded(
    Schema.decodeUnknownSync(ThreadIdRow),
    storage.sql
      .exec(
        `SELECT handle.thread_id AS thread_id
         FROM messages handle
         WHERE handle.id = ?
           AND EXISTS (
             SELECT 1 FROM messages live
             WHERE live.thread_id = handle.thread_id
               AND live.deleted_at IS NULL${inScope(mailboxScope, "live.mailbox_id")}
           )`,
        handle,
        ...scopeBinds(mailboxScope),
      )
      .toArray(),
  );
  if (row === undefined) {
    throw new ThreadNotFoundError({ threadId: handle });
  }
  return row.thread_id;
}

function inScope(scope: MailboxScope, column = "mailbox_id"): string {
  return scope === "all" ? "" : ` AND ${column} IN (SELECT value FROM json_each(?))`;
}

function scopeBinds(scope: MailboxScope): ReadonlyArray<string> {
  return scope === "all" ? [] : [bindJsonStringArray(scope)];
}

function mailboxInScope(mailboxId: string, scope: MailboxScope): boolean {
  if (scope === "all") {
    return true;
  }
  return scope.includes(mailboxId);
}

function emptyMessagePage(): MessageSummaryPage {
  return { items: [], nextCursor: null };
}

function nextMessageCursor(
  lookahead: ReadonlyArray<MessageSummaryRow>,
  pageRows: ReadonlyArray<MessageSummaryRow>,
  limit: number,
): PageCursor | null {
  const last = pageRows[pageRows.length - 1];
  if (lookahead.length <= limit || last === undefined) {
    return null;
  }
  return { at: last.occurred_at, id: last.id };
}

function splitGroupConcat(value: string | null): ReadonlyArray<string> {
  if (value === null || value.length === 0) {
    return [];
  }
  return value.split(",");
}

function toAttachmentMeta(row: {
  readonly id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size: number;
  readonly content_id: string | null;
  readonly disposition: string | null;
  readonly is_inline: number;
}): AccountAttachmentMeta {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    contentId: row.content_id,
    disposition: row.disposition,
    isInline: row.is_inline === 1,
  };
}
