import {
  ApprovalToken,
  hashApprovalToken,
  type ExternalMailAddress,
  type MailDomain,
} from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ApprovalCapabilityWrite } from "../account/domain.ts";
import { randomId } from "../crypto.ts";
import type { NamedMailboxSender, OutboundMail } from "./email-sender.ts";

export const APPROVAL_NOTIFICATION_SUBJECT = "Outbound email needs review";
export const APPROVAL_TTL_HOURS = 24;

const KEY_LENGTH = 32;

// The HMAC key behind approval links, shared by the API and the store that sends notifications.
export type NotificationKey = Uint8Array<ArrayBuffer>;

// The `NotificationKey` resource holds 32 random bytes as hex.
export function notificationKeyFromHex(secret: string): NotificationKey {
  const decoded = Encoding.decodeHex(secret);
  if (Result.isFailure(decoded) || decoded.success.byteLength !== KEY_LENGTH) {
    throw new Error("The notification key is not 32 bytes of hex");
  }
  return new Uint8Array(decoded.success);
}

// The review-link token is `hex(HMAC-SHA256(key, approvalId))`. The approval id is generated here on
// the server and never shown to clients, and only the token's hash is stored, so the store's
// due-work pass re-derives the link instead of reading it back from storage.
// Effect's Crypto service has no HMAC, so this one call uses WebCrypto directly.
export const deriveApprovalToken = Effect.fn("deriveApprovalToken")(function* (
  key: NotificationKey,
  approvalId: string,
) {
  const hmacKey = yield* Effect.promise(() =>
    crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  );
  const mac = yield* Effect.promise(() =>
    crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(approvalId)),
  );
  return Schema.decodeSync(ApprovalToken)(Encoding.encodeHex(new Uint8Array(mac)));
});

// Every submit carries approval material; the store uses it only when the job needs approval.
export const newApprovalCapability = Effect.fn("newApprovalCapability")(function* (
  key: NotificationKey,
  nowIso: string,
) {
  const approvalId = yield* randomId;
  const token = yield* deriveApprovalToken(key, approvalId);
  return {
    approvalId,
    tokenHash: yield* hashApprovalToken(token),
    expiresAt: DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(nowIso), { hours: APPROVAL_TTL_HOURS }),
    ),
  } satisfies ApprovalCapabilityWrite;
});

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
