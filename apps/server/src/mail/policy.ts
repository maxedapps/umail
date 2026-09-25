import * as DateTime from "effect/DateTime";

const SEND_CLAIM_TTL_MS = 15 * 60 * 1000;

export function sendClaimUntilIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + SEND_CLAIM_TTL_MS));
}

export const DEFAULT_MAX_RAW_BYTES = 20 * 1024 * 1024;

export const INBOUND_MIME_LIMITS = {
  maxNestingDepth: 32,
  maxHeadersSize: 256 * 1024,
  maxRfc822NestingDepth: 5,
  maxRawBytes: DEFAULT_MAX_RAW_BYTES,
  maxLineCount: 400_000,
  maxLineLength: 16 * 1024,
  maxParts: 128,
  maxDecodedBytes: DEFAULT_MAX_RAW_BYTES,
  maxTextExpansionBytes: 8 * 1024 * 1024,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxReferencesBytes: 16 * 1024,
} as const;

export const MAX_ATTACHMENTS = 50;

export const MAX_PERSISTED_MESSAGE_BYTES = 1_750_000;

export function rawObjectKey(digest: string): string {
  return `raw/${digest}.eml`;
}

type AttachmentObjectKey = `attachments/${string}/${number}`;

export function attachmentObjectKey(messageId: string, position: number): AttachmentObjectKey {
  return `attachments/${messageId}/${position}`;
}

export function sanitizeFilename(filename: string | null): string {
  if (filename === null) return "attachment";
  let stripped = "";
  for (const char of filename) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (char === "/" || char === "\\") {
      stripped += "_";
      continue;
    }
    if (code < 32 || code === 127) continue;
    stripped += char;
  }
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return "attachment";
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 200);
}

export function normalizeContentId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
