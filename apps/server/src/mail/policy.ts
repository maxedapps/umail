import * as DateTime from "effect/DateTime";


export const RECEIPT_CLAIM_TTL_MS = 5 * 60 * 1000;
export const RECEIPT_MANIFEST_PREFIX = "receipts/" as const;
export const SEND_CONSUMER_CONCURRENCY = 4 as const;
export const SEND_CLAIM_TTL_MS = 15 * 60 * 1000;

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1000;

export function receiptClaimUntilIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + RECEIPT_CLAIM_TTL_MS));
}

export function sendClaimUntilIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + SEND_CLAIM_TTL_MS));
}

export function receiptRetryAfterIso(nowMs: number, attemptCount: number): string {
  const shift = attemptCount < 0 ? 0 : attemptCount;
  const cappedShift = shift > 6 ? 6 : shift;
  let delay = RETRY_BASE_MS;
  for (let step = 0; step < cappedShift; step += 1) {
    delay *= 2;
  }
  if (delay > RETRY_MAX_MS) {
    delay = RETRY_MAX_MS;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + delay));
}

export const DEFAULT_MAX_RAW_BYTES = 20 * 1024 * 1024;
export const PLATFORM_MAX_RAW_BYTES = 25 * 1024 * 1024;

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

export type InboundPolicy = {
  readonly maxRawBytes: number;
};

export const defaultInboundPolicy = {
  maxRawBytes: DEFAULT_MAX_RAW_BYTES,
} as const satisfies InboundPolicy;

export function clampMaxRawBytes(maxRawBytes: number): number {
  if (maxRawBytes < 0) return 0;
  if (maxRawBytes > PLATFORM_MAX_RAW_BYTES) return PLATFORM_MAX_RAW_BYTES;
  return maxRawBytes;
}

export function isOversize(rawSize: number, maxRawBytes: number): boolean {
  return rawSize > clampMaxRawBytes(maxRawBytes);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function rawObjectKey(digest: string): string {
  return `raw/${digest}.eml`;
}

export type AttachmentObjectKey = `attachments/${string}/${number}`;

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
