import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

const APPROVAL_CAPABILITY_HEX = /^[0-9a-f]{64}$/;

export const ApprovalToken = Schema.String.check(Schema.isPattern(APPROVAL_CAPABILITY_HEX)).pipe(
  Schema.brand("ApprovalToken"),
);
export type ApprovalToken = typeof ApprovalToken.Type;

export const ApprovalTokenHash = Schema.String.check(
  Schema.isPattern(APPROVAL_CAPABILITY_HEX),
).pipe(Schema.brand("ApprovalTokenHash"));
export type ApprovalTokenHash = typeof ApprovalTokenHash.Type;

export const hashApprovalToken = Effect.fn("hashApprovalToken")(function* (token: ApprovalToken) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(token))
    .pipe(Effect.orDie);
  return Schema.decodeSync(ApprovalTokenHash)(Encoding.encodeHex(digest));
});
