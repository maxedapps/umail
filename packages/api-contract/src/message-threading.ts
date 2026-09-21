import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_THREAD_ID =
  /^internal:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const NODE_THREAD_HANDLE = /^node:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RFC_THREAD_ID = /^rfc:([A-Za-z0-9_-]+)$/;
const NORMALIZED_RFC_MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;

export const REFERENCES_BYTE_LIMIT = 2048;

export const NormalizedRfcMessageId = Schema.String.check(
  Schema.isPattern(NORMALIZED_RFC_MESSAGE_ID),
).pipe(Schema.brand("NormalizedRfcMessageId"));
export type NormalizedRfcMessageId = typeof NormalizedRfcMessageId.Type;

export const ThreadId = Schema.String.check(
  Schema.makeFilter((raw: string) =>
    parseThreadId(raw).kind === "invalid" ? "Invalid thread id" : undefined,
  ),
).pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;

export type ThreadIdParseResult =
  | {
      readonly kind: "rfc";
      readonly threadId: ThreadId;
      readonly messageId: NormalizedRfcMessageId;
    }
  | { readonly kind: "internal"; readonly threadId: ThreadId; readonly uuid: string }
  | { readonly kind: "invalid" };

export const ThreadHandle = Schema.String.check(
  Schema.makeFilter((raw: string) =>
    parseThreadHandle(raw).kind === "invalid" ? "Invalid thread handle" : undefined,
  ),
).pipe(Schema.brand("ThreadHandle"));
export type ThreadHandle = typeof ThreadHandle.Type;

export type ThreadHandleParseResult =
  | { readonly kind: "node"; readonly handle: ThreadHandle; readonly nodeId: string }
  | { readonly kind: "invalid" };

export type RfcIdIndex = {
  readonly unique: ReadonlySet<NormalizedRfcMessageId>;
  readonly ambiguous: ReadonlySet<NormalizedRfcMessageId>;
};

export function unfoldHeader(raw: string): string {
  return raw.replace(/\r\n[ \t]+/g, " ").replace(/\n[ \t]+/g, " ");
}

export function normalizeRfcMessageId(raw: string): NormalizedRfcMessageId | null {
  const tokens = normalizeRfcMessageIdList(raw);
  if (tokens.length !== 1) {
    return null;
  }
  return tokens[0] ?? null;
}

export function normalizeRfcMessageIdList(raw: string): ReadonlyArray<NormalizedRfcMessageId> {
  const unfolded = unfoldHeader(raw);
  const tokens = unfolded.split(/[ \t]+/);
  const seen = new Set<NormalizedRfcMessageId>();
  const normalized: Array<NormalizedRfcMessageId> = [];
  for (const token of tokens) {
    const id = normalizeRfcMessageIdToken(token);
    if (id === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function rfcThreadId(messageId: NormalizedRfcMessageId): ThreadId {
  const threadId = `rfc:${Encoding.encodeBase64Url(messageId)}`;
  return threadId as ThreadId;
}

export function internalThreadId(uuid: string): ThreadId | null {
  if (!UUID.test(uuid)) {
    return null;
  }
  const threadId = `internal:${uuid}`;
  return threadId as ThreadId;
}

export function nodeThreadHandle(nodeId: string): ThreadHandle | null {
  if (!UUID.test(nodeId)) {
    return null;
  }
  const handle = `node:${nodeId.toLowerCase()}`;
  return handle as ThreadHandle;
}

export function parseThreadHandle(raw: string): ThreadHandleParseResult {
  const match = NODE_THREAD_HANDLE.exec(raw);
  if (match === null) {
    return { kind: "invalid" };
  }
  const nodeId = match[1];
  if (nodeId === undefined) {
    return { kind: "invalid" };
  }
  return { kind: "node", handle: raw as ThreadHandle, nodeId: nodeId.toLowerCase() };
}

export function parseThreadId(raw: string): ThreadIdParseResult {
  const rfcMatch = RFC_THREAD_ID.exec(raw);
  if (rfcMatch !== null) {
    const payload = rfcMatch[1];
    if (payload === undefined) {
      return { kind: "invalid" };
    }
    const decoded = Encoding.decodeBase64UrlString(payload);
    if (Result.isFailure(decoded)) {
      return { kind: "invalid" };
    }
    const messageId = decodeNormalizedRfcMessageId(decoded.success);
    if (messageId === null) {
      return { kind: "invalid" };
    }
    return { kind: "rfc", threadId: raw as ThreadId, messageId };
  }

  const internalMatch = INTERNAL_THREAD_ID.exec(raw);
  if (internalMatch !== null) {
    const uuid = internalMatch[1];
    if (uuid === undefined) {
      return { kind: "invalid" };
    }
    return { kind: "internal", threadId: raw as ThreadId, uuid };
  }

  return { kind: "invalid" };
}

export function resolveDirectParentRfcId(
  inReplyTo: NormalizedRfcMessageId | null,
  referencesNewestFirst: ReadonlyArray<NormalizedRfcMessageId>,
  index: RfcIdIndex,
): NormalizedRfcMessageId | null {
  if (inReplyTo !== null && index.unique.has(inReplyTo)) {
    return inReplyTo;
  }
  for (const reference of referencesNewestFirst) {
    if (index.unique.has(reference)) {
      return reference;
    }
  }
  return null;
}

export function deriveThreadRoot(
  referencesOldestFirst: ReadonlyArray<NormalizedRfcMessageId>,
  directParentRfcId: NormalizedRfcMessageId | null,
  ownRfcId: NormalizedRfcMessageId | null,
  internalUuid: string,
): ThreadId | null {
  const oldestReference = referencesOldestFirst[0];
  if (oldestReference !== undefined) {
    return rfcThreadId(oldestReference);
  }
  if (directParentRfcId !== null) {
    return rfcThreadId(directParentRfcId);
  }
  if (ownRfcId !== null) {
    return rfcThreadId(ownRfcId);
  }
  return internalThreadId(internalUuid);
}

export function buildOutboundReferences(
  parentRfcId: NormalizedRfcMessageId,
  parentReferences: ReadonlyArray<NormalizedRfcMessageId>,
): ReadonlyArray<NormalizedRfcMessageId> {
  const seen = new Set<NormalizedRfcMessageId>();
  const chain: Array<NormalizedRfcMessageId> = [];
  for (const id of parentReferences) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    chain.push(id);
  }
  if (!seen.has(parentRfcId)) {
    chain.push(parentRfcId);
  }
  return pruneReferences(chain, REFERENCES_BYTE_LIMIT);
}

export function pruneReferences(
  ids: ReadonlyArray<NormalizedRfcMessageId>,
  maxBytes: number,
): ReadonlyArray<NormalizedRfcMessageId> {
  if (ids.length === 0) {
    return ids;
  }
  let kept = ids;
  while (kept.length > 1 && utf8ByteLength(joinRfcMessageIds(kept)) > maxBytes) {
    kept = kept.slice(1);
  }
  return kept;
}

export function joinRfcMessageIds(ids: ReadonlyArray<NormalizedRfcMessageId>): string {
  return ids.join(" ");
}

function normalizeRfcMessageIdToken(raw: string): NormalizedRfcMessageId | null {
  if (raw.length === 0 || hasControlChar(raw)) {
    return null;
  }
  let token = raw;
  if (token.startsWith("<") && token.endsWith(">") && token.length >= 3) {
    token = token.slice(1, -1);
  }
  if (
    token.length === 0 ||
    token.includes("<") ||
    token.includes(">") ||
    token.includes(" ") ||
    hasControlChar(token)
  ) {
    return null;
  }
  const separator = token.lastIndexOf("@");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  return decodeNormalizedRfcMessageId(`<${token}>`);
}

function decodeNormalizedRfcMessageId(raw: string): NormalizedRfcMessageId | null {
  const decoded = Schema.decodeResult(NormalizedRfcMessageId)(raw);
  if (Result.isFailure(decoded)) {
    return null;
  }
  return decoded.success;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
