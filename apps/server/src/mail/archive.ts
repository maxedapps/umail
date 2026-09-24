import type { MailboxAddress } from "@umail/api-contract";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { sha256Hex } from "./policy.ts";

export const MailArchive = Cloudflare.R2.Bucket("MailArchive").pipe(Alchemy.RemovalPolicy.retain());

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
