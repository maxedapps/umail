import {
  MailContact,
  dedupeMailContacts,
  isOwnRegisteredIdentity,
  parseMailboxAddress,
  type MailDomain,
  type MailboxAddress,
} from "@umail/api-contract";

export type ReplyMode = "reply" | "reply-all";

export type ReplyParticipants = {
  readonly from: ReadonlyArray<MailContact>;
  readonly replyTo: ReadonlyArray<MailContact>;
  readonly to: ReadonlyArray<MailContact>;
  readonly cc: ReadonlyArray<MailContact>;
};

export type ReplyRecipients = {
  readonly to: ReadonlyArray<MailContact>;
  readonly cc: ReadonlyArray<MailContact>;
};

export function deriveReplyRecipients(
  direction: "inbound" | "outbound",
  mode: ReplyMode,
  participants: ReplyParticipants,
  registered: ReadonlySet<MailboxAddress>,
  mailDomain: MailDomain,
  sendingAddress?: MailboxAddress,
): ReplyRecipients {
  const toSeed = direction === "inbound" ? inboundReplyTo(participants) : participants.to;
  const ccSeed =
    direction === "outbound" || mode === "reply-all"
      ? direction === "inbound"
        ? [...participants.to, ...participants.cc]
        : participants.cc
      : [];
  let to = excludeOwn(toSeed, registered, mailDomain);
  if (to.length === 0 && sendingAddress !== undefined) {
    to = excludeSendingAddress(toSeed, sendingAddress);
  }
  if (to.length === 0 && sendingAddress !== undefined && direction === "outbound") {
    to = excludeSendingAddress(participants.from, sendingAddress);
  }
  const toKeys = new Set(to.map((contact) => contact.address));
  const cc = excludeOwn(ccSeed, registered, mailDomain).filter(
    (contact) => !toKeys.has(contact.address),
  );
  return {
    to: dedupeMailContacts(to),
    cc: dedupeMailContacts(cc),
  };
}

function inboundReplyTo(participants: ReplyParticipants): ReadonlyArray<MailContact> {
  if (participants.replyTo.length > 0) {
    return participants.replyTo;
  }
  return participants.from;
}

function excludeOwn(
  contacts: ReadonlyArray<MailContact>,
  registered: ReadonlySet<MailboxAddress>,
  mailDomain: MailDomain,
): ReadonlyArray<MailContact> {
  const kept: Array<MailContact> = [];
  for (const contact of contacts) {
    if (isOwnRegisteredIdentity(contact.address, mailDomain, registered)) {
      continue;
    }
    kept.push(contact);
  }
  return kept;
}

function excludeSendingAddress(
  contacts: ReadonlyArray<MailContact>,
  sendingAddress: MailboxAddress,
): ReadonlyArray<MailContact> {
  const kept: Array<MailContact> = [];
  for (const contact of contacts) {
    const parsed = parseMailboxAddress(contact.address);
    if (parsed.kind === "ok" && parsed.address === sendingAddress) {
      continue;
    }
    kept.push(contact);
  }
  return kept;
}
