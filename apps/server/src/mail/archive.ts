import type { MailboxAddress } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sha256Hex } from "../crypto.ts";

export type InboundMessageId = `in_${string}`;
export type InboundAttachmentId = `att_${string}`;

// The receipt id hashes this JSON, so its encoding must stay byte-for-byte stable.
const EnvelopeIdentity = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, Schema.String]),
);

export const inboundMessageId = Effect.fn("inboundMessageId")(function* (
  digest: string,
  envelope: { readonly from: string; readonly to: MailboxAddress },
) {
  const identity = yield* Schema.encodeEffect(EnvelopeIdentity)([
    digest,
    envelope.from,
    envelope.to,
  ]).pipe(Effect.orDie);
  return formatInboundMessageId(yield* sha256Hex(new TextEncoder().encode(identity)));
});

export function inboundAttachmentId(
  messageId: InboundMessageId,
  position: number,
): InboundAttachmentId {
  return `att_${messageId}_${String(position)}`;
}

function formatInboundMessageId(hash: string): InboundMessageId {
  return `in_${hash}`;
}
