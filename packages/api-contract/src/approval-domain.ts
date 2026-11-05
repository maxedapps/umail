import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
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
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(token));
  return yield* Schema.decodeEffect(ApprovalTokenHash)(hash).pipe(Effect.orDie);
});
