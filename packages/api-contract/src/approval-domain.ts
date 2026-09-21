import * as Schema from "effect/Schema";

import type { Principal } from "./principal-authorization.ts";

const APPROVAL_CAPABILITY_HEX = /^[0-9a-f]{64}$/;
const ApprovalRequesterIdentifier = Schema.String.check(Schema.isMinLength(1));
const ApprovalRequesterLabel = Schema.String.check(Schema.isMinLength(1));

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export const ApprovalToken = Schema.String.check(Schema.isPattern(APPROVAL_CAPABILITY_HEX)).pipe(
  Schema.brand("ApprovalToken"),
);
export type ApprovalToken = typeof ApprovalToken.Type;

export const ApprovalTokenHash = Schema.String.check(
  Schema.isPattern(APPROVAL_CAPABILITY_HEX),
).pipe(Schema.brand("ApprovalTokenHash"));
export type ApprovalTokenHash = typeof ApprovalTokenHash.Type;

export class ApprovalRequesterSnapshot extends Schema.Class<ApprovalRequesterSnapshot>(
  "ApprovalRequesterSnapshot",
)({
  clientId: ApprovalRequesterIdentifier,
  label: ApprovalRequesterLabel,
}) {}

export function approvalRequesterSnapshot(principal: Principal): ApprovalRequesterSnapshot {
  const identity = principal.identity;
  return new ApprovalRequesterSnapshot({
    clientId: identity.clientId,
    label: identity.clientLabel,
  });
}

export function generateApprovalToken(): ApprovalToken {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Schema.decodeSync(ApprovalToken)(bytesToHex(bytes));
}

export async function hashApprovalToken(token: ApprovalToken): Promise<ApprovalTokenHash> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Schema.decodeSync(ApprovalTokenHash)(bytesToHex(new Uint8Array(digest)));
}
