import {
  nodeThreadHandle,
  parseExternalMailAddress,
  parseMailboxAddress,
  parseThreadHandle,
  type MailDomain,
} from "@umail/api-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { findSqliteRoot, requireThreadHandle } from "./commands.ts";
import { cancelUndispatchedJobsForMessages } from "./jobs.ts";
import {
  AccountAttachmentMeta,
  AccountMailContact,
  AccountSendingIdentity,
  AddressRow,
  AttachmentWithMessageRow,
  LatestThreadMessageRow,
  ListMessageSummariesQuery,
  ListThreadMessageSummariesQuery,
  ListThreadSummariesQuery,
  MessageBody,
  MessageBodyRow,
  MessageIdPresenceRow,
  MessageListCursor,
  MessageOutboundJob,
  MessageOutboundJobRow,
  MessageSummary,
  MessageSummaryPage,
  MessageSummaryRow,
  ParticipantWithMessageRow,
  QUERY_PAGE_DEFAULT,
  QUERY_PAGE_MAX,
  ReferenceWithMessageRow,
  ReceiptForwardObservation,
  StoredAttachment,
  StoredAttachmentRow,
  StoredMessageSource,
  StoredMessageSourceRow,
  StoredParticipants,
  ThreadActivityRow,
  ThreadListCursor,
  ThreadMessageSummaryPage,
  ThreadSummary,
  ThreadSummaryPage,
  MailboxScope,
} from "./domain.ts";
import { InboundMessageIntegrityError, QueryInputError, ThreadHandleError } from "./errors.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";

const MESSAGE_SUMMARY_SELECT = `msg.id AS id,
       msg.node_id AS node_id,
       msg.mailbox_id AS mailbox_id,
       msg.direction AS direction,
       msg.subject AS subject,
       msg.occurred_at AS occurred_at,
       msg.parsed_date AS parsed_date,
       msg.rfc_message_id AS rfc_message_id,
       msg.in_reply_to_rfc_message_id AS in_reply_to_rfc_message_id,
       parent_msg.id AS parent_message_id,
       msg.has_remote_images AS has_remote_images,
       msg.is_read AS is_read,
       msg.read_at AS read_at,
       msg.created_at AS created_at,
       msg.updated_at AS updated_at,
       receipt.id AS receipt_id,
       receipt.envelope_from AS receipt_envelope_from,
       receipt.envelope_to AS receipt_envelope_to,
       receipt.forward_outcome AS receipt_forward_outcome,
       receipt.forward_destination AS receipt_forward_destination,
       receipt.forward_error AS receipt_forward_error`;

const MESSAGE_SUMMARY_FROM = `FROM messages msg
LEFT JOIN thread_parent_edges edge ON edge.child_node_id = msg.node_id
LEFT JOIN messages parent_msg ON parent_msg.node_id = edge.parent_node_id
LEFT JOIN inbound_receipts receipt ON receipt.id = msg.id AND msg.direction = 'inbound'`;

const THREAD_MEMBERS_CTE = `WITH RECURSIVE members(root_id, node_id) AS (
  SELECT node_id, node_id
  FROM thread_component_links
  WHERE node_id = parent_node_id
  UNION ALL
  SELECT members.root_id, links.node_id
  FROM thread_component_links links
  JOIN members ON links.parent_node_id = members.node_id
  WHERE links.node_id <> members.node_id
)`;

export function listMessageSummaries(
  storage: AccountSqliteStorage,
  input: ListMessageSummariesQuery,
): MessageSummaryPage {
  const query = requireQuery(Schema.decodeResult(ListMessageSummariesQuery)(input));
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
    const items = enrichMessageSummaries(storage, pageRows);
    return Schema.decodeSync(MessageSummaryPage)({
      items,
      nextCursor: nextMessageCursor(lookahead, pageRows, limit),
    });
  });
}

export function listThreadSummaries(
  storage: AccountSqliteStorage,
  input: ListThreadSummariesQuery,
): ThreadSummaryPage {
  const query = requireQuery(Schema.decodeResult(ListThreadSummariesQuery)(input));
  const scope = query.mailboxScope;
  if (scope !== "all" && scope.length === 0) {
    return emptyThreadPage();
  }
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const lookahead = selectThreadActivityRows(storage, query, scope, limit + 1);
    const pageRows = lookahead.slice(0, limit);
    const items = enrichThreadSummaries(storage, pageRows, query.mailDomain);
    return Schema.decodeSync(ThreadSummaryPage)({
      items,
      nextCursor: nextThreadCursor(lookahead, items, limit),
    });
  });
}

export function listThreadMessageSummaries(
  storage: AccountSqliteStorage,
  handle: string,
  input: ListThreadMessageSummariesQuery,
): ThreadMessageSummaryPage {
  const query = requireQuery(Schema.decodeResult(ListThreadMessageSummariesQuery)(input));
  const scope = query.mailboxScope;
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const conversation = requireEligibleConversation(storage, handle, scope);
    const lookahead = selectThreadMessageRows(
      storage,
      conversation.componentRootId,
      query,
      limit + 1,
    );
    const pageRows = lookahead.slice(0, limit);
    const items = enrichMessageSummaries(storage, pageRows);
    return Schema.decodeSync(ThreadMessageSummaryPage)({
      threadHandle: conversation.handle,
      items,
      nextCursor: nextMessageCursor(lookahead, pageRows, limit),
    });
  });
}

export function getMessageSummary(
  storage: AccountSqliteStorage,
  messageId: string,
  mailboxScope: MailboxScope,
): MessageSummary | null {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
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
  mailboxScope: MailboxScope,
): MessageBody | null {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
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
    return Schema.decodeSync(MessageBody)({
      id: row.id,
      mailboxId: row.mailbox_id,
      textBody: row.text_body,
      htmlBody: row.html_body,
      hasRemoteImages: row.has_remote_images === 1,
    });
  });
}

export function getStoredAttachment(
  storage: AccountSqliteStorage,
  messageId: string,
  attachmentId: string,
  mailboxScope: MailboxScope,
): StoredAttachment | null {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
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
    return Schema.decodeSync(StoredAttachment)({
      messageId: row.message_id,
      mailboxId: row.mailbox_id,
      meta: toAttachmentMeta(row),
      r2Key: row.r2_key,
    });
  });
}

export function getMessageSource(
  storage: AccountSqliteStorage,
  messageId: string,
  mailboxScope: MailboxScope,
): StoredMessageSource | null {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
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
      return Schema.decodeSync(StoredMessageSource)({
        direction: "outbound",
        messageId: row.id,
        mailboxId: row.mailbox_id,
      });
    }
    if (row.raw_key === null) {
      throw new InboundMessageIntegrityError({
        messageId: row.id,
        reason: "receipt_missing",
      });
    }
    return Schema.decodeSync(StoredMessageSource)({
      direction: "inbound",
      messageId: row.id,
      mailboxId: row.mailbox_id,
      rawKey: row.raw_key,
    });
  });
}

export function markThreadRead(
  storage: AccountSqliteStorage,
  handle: string,
  isRead: boolean,
  mailboxScope: MailboxScope,
  nowIso: string,
): void {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
  storage.transactionSync(() => {
    const conversation = requireEligibleConversation(storage, handle, scope);
    if (isRead) {
      updateThreadReadState(storage, conversation.componentRootId, scope, 1, nowIso, nowIso);
      return;
    }
    updateThreadReadState(storage, conversation.componentRootId, scope, 0, null, nowIso);
  });
}

export function softDeleteThread(
  storage: AccountSqliteStorage,
  handle: string,
  mailboxScope: MailboxScope,
  deletedAt: string,
): void {
  const scope = Schema.decodeSync(MailboxScope)(mailboxScope);
  storage.transactionSync(() => {
    const conversation = requireEligibleConversation(storage, handle, scope);
    const messageIds = liveConversationMessageIds(storage, conversation.componentRootId, scope);
    cancelUndispatchedJobsForMessages(storage, messageIds, deletedAt);
    if (scope === "all") {
      storage.sql.exec(
        `UPDATE messages
         SET deleted_at = ?
         WHERE deleted_at IS NULL
           AND node_id IN (
             SELECT node_id FROM (
               WITH RECURSIVE members(node_id) AS (
                 SELECT ?
                 UNION ALL
                 SELECT links.node_id
                 FROM thread_component_links links
                 JOIN members ON links.parent_node_id = members.node_id
                 WHERE links.node_id <> members.node_id
               )
               SELECT node_id FROM members
             )
           )`,
        deletedAt,
        conversation.componentRootId,
      );
      return;
    }
    storage.sql.exec(
      `UPDATE messages
       SET deleted_at = ?
       WHERE deleted_at IS NULL
         AND node_id IN (
           SELECT node_id FROM (
             WITH RECURSIVE members(node_id) AS (
               SELECT ?
               UNION ALL
               SELECT links.node_id
               FROM thread_component_links links
               JOIN members ON links.parent_node_id = members.node_id
               WHERE links.node_id <> members.node_id
             )
             SELECT node_id FROM members
           )
         )
         AND mailbox_id IN (SELECT value FROM json_each(?))`,
      deletedAt,
      conversation.componentRootId,
      bindJsonStringArray(scope),
    );
  });
}

function liveConversationMessageIds(
  storage: AccountSqliteStorage,
  componentRootId: string,
  scope: MailboxScope,
): ReadonlyArray<string> {
  if (scope !== "all" && scope.length === 0) {
    return [];
  }
  const clauses: Array<string> = [
    "msg.deleted_at IS NULL",
    `msg.node_id IN (
       SELECT node_id FROM (
         WITH RECURSIVE members(node_id) AS (
           SELECT ?
           UNION ALL
           SELECT links.node_id
           FROM thread_component_links links
           JOIN members ON links.parent_node_id = members.node_id
           WHERE links.node_id <> members.node_id
         )
         SELECT node_id FROM members
       )
     )`,
  ];
  const binds: Array<string> = [componentRootId];
  if (scope !== "all") {
    clauses.push("msg.mailbox_id IN (SELECT value FROM json_each(?))");
    binds.push(bindJsonStringArray(scope));
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(MessageIdPresenceRow))(
    storage.sql
      .exec(
        `SELECT msg.id AS id
         FROM messages msg
         WHERE ${clauses.join(" AND ")}
         ORDER BY msg.id`,
        ...binds,
      )
      .toArray(),
  );
  return rows.map((row) => row.id);
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
    binds.push(query.cursor.occurredAt, query.cursor.occurredAt, query.cursor.id);
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

function selectThreadActivityRows(
  storage: AccountSqliteStorage,
  query: ListThreadSummariesQuery,
  scope: MailboxScope,
  limit: number,
): ReadonlyArray<ThreadActivityRow> {
  const binds: Array<string | number> = [];
  let eligible = `eligible AS (SELECT DISTINCT root_id FROM live)`;
  if (scope !== "all") {
    eligible = `eligible AS (
      SELECT DISTINCT live.root_id AS root_id
      FROM live
      JOIN json_each(?) AS scope ON scope.value = live.mailbox_id
    )`;
    binds.push(bindJsonStringArray(scope));
  }
  let having = "1=1";
  if (query.cursor !== undefined) {
    const parsed = parseThreadHandle(query.cursor.threadHandle);
    if (parsed.kind === "invalid") {
      throw new QueryInputError({ reason: "invalid_query" });
    }
    having = `(MAX(live.occurred_at) < ? OR (MAX(live.occurred_at) = ? AND live.root_id < ?))`;
    binds.push(query.cursor.lastActivityAt, query.cursor.lastActivityAt, parsed.nodeId);
  }
  binds.push(limit);
  const sql = `${THREAD_MEMBERS_CTE},
live AS (
  SELECT members.root_id AS root_id,
         msg.id AS id,
         msg.mailbox_id AS mailbox_id,
         msg.direction AS direction,
         msg.occurred_at AS occurred_at,
         msg.is_read AS is_read
  FROM messages msg
  JOIN members ON members.node_id = msg.node_id
  WHERE msg.deleted_at IS NULL
),
${eligible}
SELECT live.root_id AS root_id,
       MAX(live.occurred_at) AS last_activity_at,
       COUNT(*) AS message_count,
       SUM(CASE WHEN live.direction = 'inbound' AND live.is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
       GROUP_CONCAT(DISTINCT live.mailbox_id) AS involved_mailbox_ids
FROM live
JOIN eligible ON eligible.root_id = live.root_id
GROUP BY live.root_id
HAVING ${having}
ORDER BY last_activity_at DESC, root_id DESC
LIMIT ?`;
  return Schema.decodeUnknownSync(Schema.Array(ThreadActivityRow))(
    storage.sql.exec(sql, ...binds).toArray(),
  );
}

function selectThreadMessageRows(
  storage: AccountSqliteStorage,
  componentRootId: string,
  query: ListThreadMessageSummariesQuery,
  limit: number,
): ReadonlyArray<MessageSummaryRow> {
  const clauses: Array<string> = ["msg.deleted_at IS NULL", "members.root_id = ?"];
  const binds: Array<string | number> = [componentRootId];
  if (query.cursor !== undefined) {
    clauses.push("(msg.occurred_at > ? OR (msg.occurred_at = ? AND msg.id > ?))");
    binds.push(query.cursor.occurredAt, query.cursor.occurredAt, query.cursor.id);
  }
  binds.push(limit);
  const sql = `${THREAD_MEMBERS_CTE}
SELECT ${MESSAGE_SUMMARY_SELECT}
${MESSAGE_SUMMARY_FROM}
JOIN members ON members.node_id = msg.node_id
WHERE ${clauses.join(" AND ")}
ORDER BY msg.occurred_at ASC, msg.id ASC
LIMIT ?`;
  return Schema.decodeUnknownSync(Schema.Array(MessageSummaryRow))(
    storage.sql.exec(sql, ...binds).toArray(),
  );
}

function enrichThreadSummaries(
  storage: AccountSqliteStorage,
  rows: ReadonlyArray<ThreadActivityRow>,
  mailDomain: MailDomain,
): ReadonlyArray<ThreadSummary> {
  if (rows.length === 0) {
    return [];
  }
  const rootIds = rows.map((row) => row.root_id);
  const latestByRoot = loadLatestThreadMessages(storage, rootIds);
  const latestIds: Array<string> = [];
  for (const row of rows) {
    const latest = latestByRoot.get(row.root_id);
    if (latest !== undefined) {
      latestIds.push(latest.id);
    }
  }
  const participantsById = loadParticipantsByMessageIds(storage, latestIds);
  const involvedIds: Array<string> = [];
  for (const row of rows) {
    for (const mailboxId of splitGroupConcat(row.involved_mailbox_ids)) {
      involvedIds.push(mailboxId);
    }
  }
  const identitiesById = loadSendingIdentitiesByIds(storage, involvedIds, mailDomain);
  const items: Array<ThreadSummary> = [];
  for (const row of rows) {
    const latest = latestByRoot.get(row.root_id);
    if (latest === undefined) {
      continue;
    }
    const participants = participantsById.get(latest.id) ?? emptyParticipants();
    const involved: Array<AccountSendingIdentity> = [];
    for (const mailboxId of splitGroupConcat(row.involved_mailbox_ids)) {
      const identity = identitiesById.get(mailboxId);
      if (identity !== undefined) {
        involved.push(identity);
      }
    }
    items.push(
      Schema.decodeSync(ThreadSummary)({
        threadHandle: requireThreadHandle(row.root_id),
        subject: latest.subject,
        latestSender: participants.from[0] ?? null,
        latestRecipients: participants.to,
        unreadCount: row.unread_count,
        messageCount: row.message_count,
        involvedMailboxIdentities: involved,
        lastActivityAt: row.last_activity_at,
      }),
    );
  }
  return items;
}

function loadLatestThreadMessages(
  storage: AccountSqliteStorage,
  rootIds: ReadonlyArray<string>,
): ReadonlyMap<string, LatestThreadMessageRow> {
  const rows = Schema.decodeUnknownSync(Schema.Array(LatestThreadMessageRow))(
    storage.sql
      .exec(
        `WITH RECURSIVE members(root_id, node_id) AS (
           SELECT value, value FROM json_each(?)
           UNION ALL
           SELECT members.root_id, links.node_id
           FROM thread_component_links links
           JOIN members ON links.parent_node_id = members.node_id
           WHERE links.node_id <> members.node_id
         ),
         ranked AS (
           SELECT members.root_id AS root_id,
                  msg.id AS id,
                  msg.subject AS subject,
                  ROW_NUMBER() OVER (
                    PARTITION BY members.root_id
                    ORDER BY msg.occurred_at DESC, msg.id DESC
                  ) AS rn
           FROM messages msg
           JOIN members ON members.node_id = msg.node_id
           WHERE msg.deleted_at IS NULL
         )
         SELECT root_id, id, subject FROM ranked WHERE rn = 1`,
        bindJsonStringArray(rootIds),
      )
      .toArray(),
  );
  const byRoot = new Map<string, LatestThreadMessageRow>();
  for (const row of rows) {
    byRoot.set(row.root_id, row);
  }
  return byRoot;
}

function loadSendingIdentitiesByIds(
  storage: AccountSqliteStorage,
  ids: ReadonlyArray<string>,
  mailDomain: MailDomain,
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
  const byId = new Map<string, AccountSendingIdentity>();
  for (const row of rows) {
    const parsed = parseMailboxAddress(row.address);
    if (
      parsed.kind === "invalid" ||
      parsed.domain !== mailDomain ||
      parsed.localPart !== row.local_part ||
      parsed.address !== row.address
    ) {
      continue;
    }
    byId.set(
      row.id,
      Schema.decodeSync(AccountSendingIdentity)({
        id: row.id,
        address: parsed.address,
        displayName: row.display_name,
      }),
    );
  }
  return byId;
}

const UNKNOWN_OUTBOUND_JOB = Schema.decodeSync(MessageOutboundJob)({
  state: "unknown",
  failureClass: null,
  failureDetail: null,
  providerMessageId: null,
});

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
    const handle = nodeThreadHandle(row.node_id);
    if (handle === null) {
      continue;
    }
    const participants = participantsById.get(row.id) ?? emptyParticipants();
    const summaryFields = {
      id: row.id,
      threadHandle: handle,
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
      items.push(
        Schema.decodeSync(MessageSummary)({
          direction: "inbound",
          ...summaryFields,
          envelopeFrom: receipt.envelopeFrom,
          envelopeTo: receipt.envelopeTo,
          parsedDate: row.parsed_date,
          forward: receipt.forward,
        }),
      );
      continue;
    }
    items.push(
      Schema.decodeSync(MessageSummary)({
        direction: "outbound",
        ...summaryFields,
        outboundJob: jobsById.get(row.id) ?? UNKNOWN_OUTBOUND_JOB,
      }),
    );
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
    forward: receiptForwardObservation(row),
  };
}

function receiptForwardObservation(row: MessageSummaryRow): ReceiptForwardObservation {
  if (row.receipt_forward_outcome === "none") {
    if (row.receipt_forward_destination === null && row.receipt_forward_error === null) {
      return { kind: "none" };
    }
    throw invalidForwardObservation(row.id);
  }
  const destination = row.receipt_forward_destination;
  if (destination === null) {
    throw invalidForwardObservation(row.id);
  }
  if (row.receipt_forward_outcome === "success" && row.receipt_forward_error === null) {
    return { kind: "success", destination };
  }
  if (row.receipt_forward_outcome === "unknown" && row.receipt_forward_error === null) {
    return { kind: "unknown", destination };
  }
  if (row.receipt_forward_outcome === "failure" && row.receipt_forward_error !== null) {
    return { kind: "failure", destination, error: row.receipt_forward_error };
  }
  throw invalidForwardObservation(row.id);
}

function invalidForwardObservation(messageId: string): InboundMessageIntegrityError {
  return new InboundMessageIntegrityError({
    messageId,
    reason: "forward_observation_invalid",
  });
}

function loadParticipantsByMessageIds(
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

function loadReferencesByMessageIds(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const byId = new Map<string, Array<string>>();
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
    byId.set(
      row.message_id,
      Schema.decodeSync(MessageOutboundJob)({
        state: row.state,
        failureClass: row.failure_class,
        failureDetail: row.failure_detail,
        providerMessageId: row.provider_message_id,
      }),
    );
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

function updateThreadReadState(
  storage: AccountSqliteStorage,
  componentRootId: string,
  scope: MailboxScope,
  isRead: 0 | 1,
  readAt: string | null,
  nowIso: string,
): void {
  if (scope === "all") {
    storage.sql.exec(
      `UPDATE messages
       SET is_read = ?, read_at = ?, updated_at = ?
       WHERE direction = 'inbound'
         AND deleted_at IS NULL
         AND node_id IN (
           SELECT node_id FROM (
             WITH RECURSIVE members(node_id) AS (
               SELECT ?
               UNION ALL
               SELECT links.node_id
               FROM thread_component_links links
               JOIN members ON links.parent_node_id = members.node_id
               WHERE links.node_id <> members.node_id
             )
             SELECT node_id FROM members
           )
         )`,
      isRead,
      readAt,
      nowIso,
      componentRootId,
    );
    return;
  }
  storage.sql.exec(
    `UPDATE messages
     SET is_read = ?, read_at = ?, updated_at = ?
     WHERE direction = 'inbound'
       AND deleted_at IS NULL
       AND node_id IN (
         SELECT node_id FROM (
           WITH RECURSIVE members(node_id) AS (
             SELECT ?
             UNION ALL
             SELECT links.node_id
             FROM thread_component_links links
             JOIN members ON links.parent_node_id = members.node_id
             WHERE links.node_id <> members.node_id
           )
           SELECT node_id FROM members
         )
       )
       AND mailbox_id IN (SELECT value FROM json_each(?))`,
    isRead,
    readAt,
    nowIso,
    componentRootId,
    bindJsonStringArray(scope),
  );
}

type EligibleConversation = {
  readonly handle: string;
  readonly nodeId: string;
  readonly componentRootId: string;
};

function requireEligibleConversation(
  storage: AccountSqliteStorage,
  handle: string,
  mailboxScope: MailboxScope,
): EligibleConversation {
  const parsed = parseThreadHandle(handle);
  if (parsed.kind === "invalid") {
    throw new ThreadHandleError({ handle, reason: "invalid" });
  }
  const node = firstDecoded(
    Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String })),
    storage.sql.exec("SELECT id FROM thread_nodes WHERE id = ?", parsed.nodeId).toArray(),
  );
  if (node === undefined) {
    throw new ThreadHandleError({ handle, reason: "not_found" });
  }
  if (mailboxScope !== "all" && mailboxScope.length === 0) {
    throw new ThreadHandleError({ handle, reason: "not_found" });
  }
  const componentRootId = findSqliteRoot(storage, parsed.nodeId).root;
  if (!conversationHasLiveScopedMessage(storage, componentRootId, mailboxScope)) {
    throw new ThreadHandleError({ handle, reason: "not_found" });
  }
  return { handle: parsed.handle, nodeId: parsed.nodeId, componentRootId };
}

function conversationHasLiveScopedMessage(
  storage: AccountSqliteStorage,
  componentRootId: string,
  mailboxScope: MailboxScope,
): boolean {
  if (mailboxScope === "all") {
    const row = firstDecoded(
      Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String })),
      storage.sql
        .exec(
          `WITH RECURSIVE members(node_id) AS (
             SELECT ?
             UNION ALL
             SELECT links.node_id
             FROM thread_component_links links
             JOIN members ON links.parent_node_id = members.node_id
             WHERE links.node_id <> members.node_id
           )
           SELECT messages.id AS id
           FROM messages
           JOIN members ON members.node_id = messages.node_id
           WHERE messages.deleted_at IS NULL
           LIMIT 1`,
          componentRootId,
        )
        .toArray(),
    );
    return row !== undefined;
  }
  const row = firstDecoded(
    Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String })),
    storage.sql
      .exec(
        `WITH RECURSIVE members(node_id) AS (
           SELECT ?
           UNION ALL
           SELECT links.node_id
           FROM thread_component_links links
           JOIN members ON links.parent_node_id = members.node_id
           WHERE links.node_id <> members.node_id
         )
         SELECT messages.id AS id
         FROM messages
         JOIN members ON members.node_id = messages.node_id
         JOIN json_each(?) AS scope ON scope.value = messages.mailbox_id
         WHERE messages.deleted_at IS NULL
         LIMIT 1`,
        componentRootId,
        bindJsonStringArray(mailboxScope),
      )
      .toArray(),
  );
  return row !== undefined;
}

function requireQuery<A, E>(decoded: Result.Result<A, E>): A {
  if (Result.isFailure(decoded)) {
    throw new QueryInputError({ reason: "invalid_query" });
  }
  return decoded.success;
}

function pageLimit(limit: number | undefined): number {
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

function mailboxInScope(mailboxId: string, scope: MailboxScope): boolean {
  if (scope === "all") {
    return true;
  }
  return scope.includes(mailboxId);
}

function emptyMessagePage(): MessageSummaryPage {
  return Schema.decodeSync(MessageSummaryPage)({ items: [], nextCursor: null });
}

function emptyThreadPage(): ThreadSummaryPage {
  return Schema.decodeSync(ThreadSummaryPage)({ items: [], nextCursor: null });
}

function nextMessageCursor(
  lookahead: ReadonlyArray<MessageSummaryRow>,
  pageRows: ReadonlyArray<MessageSummaryRow>,
  limit: number,
): MessageListCursor | null {
  const last = pageRows[pageRows.length - 1];
  if (lookahead.length <= limit || last === undefined) {
    return null;
  }
  return Schema.decodeSync(MessageListCursor)({
    occurredAt: last.occurred_at,
    id: last.id,
  });
}

function nextThreadCursor(
  lookahead: ReadonlyArray<ThreadActivityRow>,
  items: ReadonlyArray<ThreadSummary>,
  limit: number,
): ThreadListCursor | null {
  const last = items[items.length - 1];
  if (lookahead.length <= limit || last === undefined) {
    return null;
  }
  return Schema.decodeSync(ThreadListCursor)({
    lastActivityAt: last.lastActivityAt,
    threadHandle: last.threadHandle,
  });
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
  return Schema.decodeSync(AccountAttachmentMeta)({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    contentId: row.content_id,
    disposition: row.disposition,
    isInline: row.is_inline === 1,
  });
}

type MutableParticipants = {
  from: Array<AccountMailContact>;
  replyTo: Array<AccountMailContact>;
  to: Array<AccountMailContact>;
  cc: Array<AccountMailContact>;
};

function emptyParticipants(): StoredParticipants {
  return { from: [], replyTo: [], to: [], cc: [] };
}

function emptyMutableParticipants(): MutableParticipants {
  return { from: [], replyTo: [], to: [], cc: [] };
}

function appendParticipant(
  participants: MutableParticipants,
  row: { role: "from" | "reply_to" | "to" | "cc"; address: string; display_name: string | null },
): void {
  const parsed = parseExternalMailAddress(row.address);
  if (parsed.kind !== "ok") {
    return;
  }
  const contact = Schema.decodeSync(AccountMailContact)({
    address: parsed.address,
    displayName: row.display_name,
  });
  if (row.role === "from") participants.from.push(contact);
  if (row.role === "reply_to") participants.replyTo.push(contact);
  if (row.role === "to") participants.to.push(contact);
  if (row.role === "cc") participants.cc.push(contact);
}
