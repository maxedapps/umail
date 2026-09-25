import type { MailboxAddress } from "@umail/api-contract";
import * as Effect from "effect/Effect";

import { sha256Hex } from "../crypto.ts";

export type InboundMessageId = `in_${string}`;
export type InboundAttachmentId = `att_${string}`;

export const inboundMessageId = Effect.fn("inboundMessageId")(function* (
  digest: string,
  envelope: { readonly from: string; readonly to: MailboxAddress },
) {
  const identity = JSON.stringify([digest, envelope.from, envelope.to] as const);
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
