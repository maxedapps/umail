import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const NORMALIZED_RFC_MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;

export const REFERENCES_BYTE_LIMIT = 2048;

export const NormalizedRfcMessageId = Schema.String.check(
  Schema.isPattern(NORMALIZED_RFC_MESSAGE_ID),
).pipe(Schema.brand("NormalizedRfcMessageId"));
export type NormalizedRfcMessageId = typeof NormalizedRfcMessageId.Type;

function unfoldHeader(raw: string): string {
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
