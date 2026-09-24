import * as Schema from "effect/Schema";

const APPROVAL_CAPABILITY_HEX = /^[0-9a-f]{64}$/;

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

export async function hashApprovalToken(token: ApprovalToken): Promise<ApprovalTokenHash> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Schema.decodeSync(ApprovalTokenHash)(bytesToHex(new Uint8Array(digest)));
}
