import type { MailboxAddress } from "@umail/api-contract";
import { sha256Hex } from "./policy.ts";

export type InboundMessageId = `in_${string}`;
export type InboundAttachmentId = `att_${string}`;

export function inboundMessageId(
  digest: string,
  envelope: { readonly from: string; readonly to: MailboxAddress },
): Promise<InboundMessageId> {
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
