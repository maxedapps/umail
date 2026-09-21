import { ApprovalToken, type ExternalMailAddress, type MailDomain } from "@umail/api-contract";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { NamedMailboxSender, OutboundMail } from "./email-sender.ts";

export const NOTIFICATION_PAYLOAD_VERSION = 1 as const;
export const APPROVAL_NOTIFICATION_SUBJECT = "Outbound email needs review";

export const NotificationJobIdentity = Schema.Struct({
  requesterClientId: Schema.String.check(Schema.isMinLength(1)),
  requestId: Schema.String.check(Schema.isMinLength(1)),
  purpose: Schema.Literal("approval_notification"),
});
export type NotificationJobIdentity = typeof NotificationJobIdentity.Type;

export const NotificationPayload = Schema.Struct({
  version: Schema.Literal(NOTIFICATION_PAYLOAD_VERSION),
  token: ApprovalToken,
  expiresAt: Schema.String,
});
export type NotificationPayload = typeof NotificationPayload.Type;

export type NotificationKey = {
  readonly version: string;
  readonly secret: Uint8Array;
};

export type NotificationKeyring = {
  readonly currentVersion: string;
  readonly keys: ReadonlyArray<NotificationKey>;
};

export type EncryptedNotification = {
  readonly keyVersion: string;
  readonly nonce: string;
  readonly ciphertext: string;
};

export type DecryptNotificationResult =
  | { readonly kind: "ok"; readonly payload: NotificationPayload }
  | { readonly kind: "expired"; readonly payload: NotificationPayload }
  | { readonly kind: "unknown_key" }
  | { readonly kind: "forged" };

const AES_GCM = "AES-GCM";
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

export function notificationAad(identity: NotificationJobIdentity): Uint8Array {
  const parsed = Schema.decodeSync(NotificationJobIdentity)(identity);
  return new TextEncoder().encode(
    `umail.notification.v1\n${parsed.requesterClientId}\n${parsed.requestId}\n${parsed.purpose}`,
  );
}

export async function encryptNotificationPayload(
  payload: NotificationPayload,
  identity: NotificationJobIdentity,
  keyring: NotificationKeyring,
): Promise<EncryptedNotification> {
  const parsed = Schema.decodeSync(NotificationPayload)(payload);
  const key = requireCurrentKey(keyring);
  const cryptoKey = await importAesKey(key.secret);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: AES_GCM,
      iv: arrayBufferOf(nonce),
      additionalData: arrayBufferOf(notificationAad(identity)),
    },
    cryptoKey,
    arrayBufferOf(plaintext),
  );
  return {
    keyVersion: key.version,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function decryptNotificationPayload(
  record: EncryptedNotification,
  identity: NotificationJobIdentity,
  keyring: NotificationKeyring,
  nowIso: string,
): Promise<DecryptNotificationResult> {
  const key = keyForVersion(keyring, record.keyVersion);
  if (key === null) {
    return { kind: "unknown_key" };
  }
  const nonce = base64UrlToBytes(record.nonce);
  const ciphertext = base64UrlToBytes(record.ciphertext);
  if (nonce === null || ciphertext === null || nonce.byteLength !== NONCE_LENGTH) {
    return { kind: "forged" };
  }
  try {
    const cryptoKey = await importAesKey(key.secret);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: AES_GCM,
        iv: arrayBufferOf(nonce),
        additionalData: arrayBufferOf(notificationAad(identity)),
      },
      cryptoKey,
      arrayBufferOf(ciphertext),
    );
    const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(NotificationPayload))(
      new TextDecoder().decode(decrypted),
    );
    if (Result.isFailure(parsed)) {
      return { kind: "forged" };
    }
    if (parsed.success.expiresAt <= nowIso) {
      return { kind: "expired", payload: parsed.success };
    }
    return { kind: "ok", payload: parsed.success };
  } catch {
    return { kind: "forged" };
  }
}

export function createNotificationKeyring(
  currentVersion: string,
  keys: ReadonlyArray<NotificationKey>,
): NotificationKeyring {
  if (currentVersion.length === 0) {
    throw new Error("notification key version is required");
  }
  for (const key of keys) {
    if (key.secret.byteLength !== KEY_LENGTH) {
      throw new Error(`notification key ${key.version} must be ${KEY_LENGTH} bytes`);
    }
  }
  if (keyForVersion({ currentVersion, keys }, currentVersion) === null) {
    throw new Error("current notification key is missing from the keyring");
  }
  return { currentVersion, keys };
}

export function randomNotificationSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}

export function notificationKeyringFromSecret(secret: string): NotificationKeyring {
  const decoded = Encoding.decodeBase64Url(secret);
  if (Result.isFailure(decoded) || decoded.success.byteLength !== KEY_LENGTH) {
    throw new Error("UMAIL_NOTIFICATION_KEY is not valid base64url");
  }
  return createNotificationKeyring("v1", [{ version: "v1", secret: decoded.success }]);
}

export function approvalNotificationText(expiresAt: string, reviewUrl: string): string {
  return [
    "An outbound email is waiting for review in AgentMail.",
    "Open the secure review page to inspect the message and approve or deny it.",
    `This request expires at ${expiresAt}.`,
    "",
    `Review & decide: ${reviewUrl}`,
  ].join("\n");
}

export function approvalReviewUrl(applicationUrl: URL, token: ApprovalToken): string {
  return new URL(`/approvals/${encodeURIComponent(token)}`, applicationUrl.origin).href;
}

export function approvalNotificationMail(input: {
  readonly mailDomain: MailDomain;
  readonly approvalAdminEmail: ExternalMailAddress;
  readonly expiresAt: string;
  readonly reviewUrl: string;
}): OutboundMail {
  const from: NamedMailboxSender = { email: `noreply@${input.mailDomain}`, name: null };
  return {
    from,
    replyTo: from,
    to: [input.approvalAdminEmail],
    cc: [],
    subject: APPROVAL_NOTIFICATION_SUBJECT,
    text: approvalNotificationText(input.expiresAt, input.reviewUrl),
    html: null,
    inReplyTo: null,
    references: null,
  };
}

function requireCurrentKey(keyring: NotificationKeyring): NotificationKey {
  const key = keyForVersion(keyring, keyring.currentVersion);
  if (key === null) {
    throw new Error("current notification key is missing from the keyring");
  }
  return key;
}

function keyForVersion(keyring: NotificationKeyring, version: string): NotificationKey | null {
  for (const key of keyring.keys) {
    if (key.version === version) {
      return key;
    }
  }
  return null;
}

async function importAesKey(secret: Uint8Array) {
  return crypto.subtle.importKey("raw", arrayBufferOf(secret), { name: AES_GCM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Encoding.encodeBase64Url(bytes);
}

function base64UrlToBytes(raw: string): Uint8Array | null {
  const decoded = Encoding.decodeBase64Url(raw);
  if (Result.isFailure(decoded)) {
    return null;
  }
  return decoded.success;
}

export function notificationIdentity(
  requesterClientId: string,
  requestId: string,
): NotificationJobIdentity {
  return Schema.decodeSync(NotificationJobIdentity)({
    requesterClientId,
    requestId,
    purpose: "approval_notification",
  });
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
