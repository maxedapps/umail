import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Envelope } from "./index-payload.ts";
import { rawObjectKey, sha256Hex } from "./policy.ts";

export const MailArchive = Cloudflare.R2.Bucket("MailArchive").pipe(Alchemy.RemovalPolicy.retain());

export type InboundMessageId = `in_${string}`;
export type InboundAttachmentId = `att_${string}`;

export function inboundMessageId(digest: string, envelope: Envelope): Promise<InboundMessageId> {
  const identity = JSON.stringify([digest, envelope.from, envelope.to] as const);
  return sha256Hex(new TextEncoder().encode(identity)).then(formatInboundMessageId);
}

export function inboundAttachmentId(
  messageId: InboundMessageId,
  position: number,
): InboundAttachmentId {
  return `att_${messageId}_${String(position)}`;
}

function formatInboundMessageId(hash: string): InboundMessageId {
  return `in_${hash}`;
}

export const RECEIPT_MANIFEST_VERSION = 1 as const;

export const ReceiptManifest = Schema.Struct({
  version: Schema.Literal(RECEIPT_MANIFEST_VERSION),
  receiptId: Schema.String,
  digest: Schema.String,
  rawKey: Schema.String,
  envelope: Envelope,
  receivedAt: Schema.String,
  advertisedRawSize: Schema.Finite,
  consumedBytes: Schema.Finite,
  policyFailure: Schema.optionalKey(Schema.String),
});
export type ReceiptManifest = typeof ReceiptManifest.Type;

export type ReceiptManifestKey = `receipts/${string}.json`;

export function receiptManifestKey(receiptId: string): ReceiptManifestKey {
  return `receipts/${receiptId}.json`;
}

export interface ReceiptArchive {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export type ArchiveInboundReceiptInput = {
  readonly envelope: Envelope;
  readonly advertisedRawSize: number;
  readonly bytes: Uint8Array;
  readonly receivedAt: string;
};

export type ArchivedInboundReceipt = {
  readonly receiptId: InboundMessageId;
  readonly digest: string;
  readonly rawKey: string;
  readonly manifestKey: ReceiptManifestKey;
  readonly advertisedRawSize: number;
  readonly consumedBytes: number;
  readonly envelope: Envelope;
  readonly receivedAt: string;
};

export async function archiveInboundReceipt(
  archive: ReceiptArchive,
  input: ArchiveInboundReceiptInput,
): Promise<ArchivedInboundReceipt> {
  const digest = await sha256Hex(input.bytes);
  const receiptId = await inboundMessageId(digest, input.envelope);
  const rawKey = rawObjectKey(digest);
  const manifestKey = receiptManifestKey(receiptId);
  await archive.put(rawKey, input.bytes);
  const existing = await readExistingManifest(archive, manifestKey);
  if (existing !== null) {
    return await archivedFromManifest(existing);
  }
  const manifest = {
    version: RECEIPT_MANIFEST_VERSION,
    receiptId,
    digest,
    rawKey,
    envelope: input.envelope,
    receivedAt: input.receivedAt,
    advertisedRawSize: input.advertisedRawSize,
    consumedBytes: input.bytes.byteLength,
  } satisfies ReceiptManifest;
  await archive.put(manifestKey, encodeReceiptManifest(manifest));
  return await archivedFromManifest(manifest);
}

export function withReceiptPolicyFailure(
  manifest: ReceiptManifest,
  reason: string,
): ReceiptManifest {
  if (manifest.policyFailure !== undefined) {
    return manifest;
  }
  return { ...manifest, policyFailure: reason };
}

export function encodeReceiptManifest(manifest: ReceiptManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(Schema.encodeSync(ReceiptManifest)(manifest)));
}

async function readExistingManifest(
  archive: ReceiptArchive,
  manifestKey: ReceiptManifestKey,
): Promise<ReceiptManifest | null> {
  const bytes = await archive.get(manifestKey);
  if (bytes === null) {
    return null;
  }
  const decoded = Schema.decodeResult(Schema.fromJsonString(ReceiptManifest))(
    new TextDecoder().decode(bytes),
  );
  if (Result.isFailure(decoded)) {
    throw new Error("receipt manifest invalid");
  }
  return decoded.success;
}

async function archivedFromManifest(manifest: ReceiptManifest): Promise<ArchivedInboundReceipt> {
  const receiptId = await inboundMessageId(manifest.digest, manifest.envelope);
  if (receiptId !== manifest.receiptId) {
    throw new Error("receipt identity invalid");
  }
  return {
    receiptId,
    digest: manifest.digest,
    rawKey: manifest.rawKey,
    manifestKey: receiptManifestKey(receiptId),
    advertisedRawSize: manifest.advertisedRawSize,
    consumedBytes: manifest.consumedBytes,
    envelope: manifest.envelope,
    receivedAt: manifest.receivedAt,
  };
}
