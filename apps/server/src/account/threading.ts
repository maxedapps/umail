import {
  normalizeRfcMessageId,
  normalizeRfcMessageIdList,
  type NormalizedRfcMessageId,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

import { ThreadIdRow } from "./domain.ts";
import { bindJsonStringArray, type AccountSqliteStorage } from "./sqlite.ts";

export const THREADING_REFERENCE_LIMIT = 128;

export type ThreadingHeaders = {
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyTo: NormalizedRfcMessageId | null;
  readonly references: ReadonlyArray<NormalizedRfcMessageId>;
};

/** Keeps the newest {@link THREADING_REFERENCE_LIMIT} References, oldest first. */
export function normalizeThreadingHeaders(
  rfcMessageId: string | null,
  inReplyTo: string | null,
  references: string | null,
): ThreadingHeaders {
  return {
    rfcMessageId: rfcMessageId === null ? null : normalizeRfcMessageId(rfcMessageId),
    inReplyTo: inReplyTo === null ? null : normalizeRfcMessageId(inReplyTo),
    references:
      references === null
        ? []
        : normalizeRfcMessageIdList(references).slice(-THREADING_REFERENCE_LIMIT),
  };
}

// A thread is every message linked through a shared Message-ID (own id, In-Reply-To, References).
// Invariant: every message that owns or references a given Message-ID is in one thread, so one hit
// per id is enough. A thread id is always the id of a message in that thread, so any message id
// (including a merged-away thread id) resolves to its current thread with a primary-key lookup.
const LINKED_THREADS = `WITH self AS (
  SELECT id, thread_id, rfc_message_id, in_reply_to_rfc_message_id FROM messages WHERE id = ?
),
ids(value) AS (
  SELECT rfc_message_id FROM self WHERE rfc_message_id IS NOT NULL
  UNION SELECT in_reply_to_rfc_message_id FROM self WHERE in_reply_to_rfc_message_id IS NOT NULL
  UNION SELECT r.rfc_message_id FROM message_references r JOIN self ON r.message_id = self.id
),
linked(thread_id) AS (
  SELECT thread_id FROM self
  UNION
  SELECT COALESCE(
    (SELECT m.thread_id FROM messages m JOIN self ON m.id <> self.id
     WHERE m.rfc_message_id = ids.value LIMIT 1),
    (SELECT m.thread_id FROM messages m JOIN self ON m.id <> self.id
     WHERE m.in_reply_to_rfc_message_id = ids.value LIMIT 1),
    (SELECT m.thread_id FROM message_references r
     JOIN messages m ON m.id = r.message_id JOIN self ON m.id <> self.id
     WHERE r.rfc_message_id = ids.value LIMIT 1))
  FROM ids
)
SELECT founder.id AS thread_id FROM messages founder
WHERE founder.id IN (SELECT thread_id FROM linked)
ORDER BY founder.created_at, founder.id`;

/** Merges every thread that shares a Message-ID with the message into the oldest one. */
export function linkThread(storage: AccountSqliteStorage, messageId: string): string {
  const [survivor, ...merged] = Schema.decodeUnknownSync(Schema.Array(ThreadIdRow))(
    storage.sql.exec(LINKED_THREADS, messageId).toArray(),
  ).map((row) => row.thread_id);
  if (survivor === undefined) {
    throw new Error(`Message ${messageId} is missing`);
  }
  if (merged.length > 0) {
    storage.sql.exec(
      "UPDATE messages SET thread_id = ? WHERE thread_id IN (SELECT value FROM json_each(?))",
      survivor,
      bindJsonStringArray(merged),
    );
  }
  return survivor;
}
