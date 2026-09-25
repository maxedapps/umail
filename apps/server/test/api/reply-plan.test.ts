import {
  MailContact,
  parseExternalMailAddress,
  parseMailDomain,
  parseMailboxAddress,
  type MailboxAddress,
} from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";

import { deriveReplyRecipients } from "../../src/api/reply-plan.ts";

const parsedDomain = parseMailDomain("umail.example.com");
if (parsedDomain.kind !== "ok") {
  throw new Error("expected mail domain");
}
const DOMAIN = parsedDomain.domain;

function contact(raw: string, displayName: string | null = null) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error(raw);
  }
  return new MailContact({ address: parsed.address, displayName });
}

function mailbox(raw: string): MailboxAddress {
  const parsed = parseMailboxAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error(raw);
  }
  return parsed.address;
}

const inbox = mailbox("inbox@umail.example.com");
const probe = mailbox("probe@umail.example.com");
const registered = new Set<MailboxAddress>([inbox, probe]);

describe("deriveReplyRecipients", () => {
  it("keeps external Reply-To for inbound reply", () => {
    const recipients = deriveReplyRecipients(
      "inbound",
      "reply",
      {
        from: [contact("alice@example.com", "Alice")],
        replyTo: [contact("replies@example.com")],
        to: [contact("inbox@umail.example.com", "Inbox")],
        cc: [contact("bob@example.com")],
      },
      registered,
      DOMAIN,
      inbox,
    );
    expect(recipients.to.map((item) => item.address)).toEqual(["replies@example.com"]);
    expect(recipients.cc).toEqual([]);
  });

  it("falls back to the other mailbox identity for an intra-mailbox outbound", () => {
    const recipients = deriveReplyRecipients(
      "outbound",
      "reply",
      {
        from: [contact("inbox@umail.example.com", "Inbox")],
        replyTo: [contact("inbox@umail.example.com", "Inbox")],
        to: [contact("probe@umail.example.com", "Probe")],
        cc: [],
      },
      registered,
      DOMAIN,
      probe,
    );
    expect(recipients.to.map((item) => item.address)).toEqual(["inbox@umail.example.com"]);
    expect(recipients.cc).toEqual([]);
  });
});
