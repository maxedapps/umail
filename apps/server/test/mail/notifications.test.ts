import { createHmac } from "node:crypto";

import {
  ApprovalToken,
  hashApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
} from "@umail/api-contract";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_NOTIFICATION_SUBJECT,
  approvalNotificationMail,
  deriveApprovalToken,
  newApprovalCapability,
  notificationKeyFromSecret,
} from "../../src/mail/notifications.ts";

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const NOW = "2026-01-01T00:00:00.000Z";

describe("approval tokens", () => {
  it("derives the token as lowercase hex HMAC-SHA256 of the approval id", async () => {
    const key = notificationKeyFromSecret(Encoding.encodeBase64Url(KEY_BYTES));
    const token = await deriveApprovalToken(key, "approval-1");

    expect(token).toBe(createHmac("sha256", KEY_BYTES).update("approval-1").digest("hex"));
    expect(Schema.is(ApprovalToken)(token)).toBe(true);
    expect(await deriveApprovalToken(key, "approval-1")).toBe(token);
    expect(await deriveApprovalToken(key, "approval-2")).not.toBe(token);
    expect(
      await deriveApprovalToken(crypto.getRandomValues(new Uint8Array(32)), "approval-1"),
    ).not.toBe(token);
  });

  it("stores only the hash of the token SendConsumer re-derives", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const capability = await newApprovalCapability(key, NOW);

    const token = await deriveApprovalToken(key, capability.approvalId);
    expect(await hashApprovalToken(token)).toBe(capability.tokenHash);
    expect(capability.tokenHash).not.toBe(token);
    expect(capability.expiresAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("builds a canned notification without attacker-controlled subject or body copy", () => {
    const mailDomain = requireMailDomain("umail.example.com");
    const admin = requireExternal("operator@example.com");
    const mail = approvalNotificationMail({
      mailDomain,
      approvalAdminEmail: admin,
      expiresAt: "2026-01-02T00:00:00.000Z",
      reviewUrl: "https://umail.example.com/approvals/abc",
    });
    expect(mail.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(mail.subject).not.toContain("Click here");
    expect(mail.text).toContain("https://umail.example.com/approvals/abc");
    expect(mail.text).toContain("AgentMail");
    expect(mail.text).not.toContain("Please send bitcoin");
    expect(mail.html).toBeNull();
  });

  it("rejects missing, padded, standard-base64, and short notification secrets", () => {
    expect(() => notificationKeyFromSecret("")).toThrow(
      "UMAIL_NOTIFICATION_KEY is not valid base64url",
    );
    expect(() =>
      notificationKeyFromSecret(Encoding.encodeBase64(new Uint8Array(32).fill(0xfb))),
    ).toThrow("UMAIL_NOTIFICATION_KEY is not valid base64url");
    expect(() => notificationKeyFromSecret(Encoding.encodeBase64Url(new Uint8Array(16)))).toThrow(
      "UMAIL_NOTIFICATION_KEY is not valid base64url",
    );
    expect(notificationKeyFromSecret(Encoding.encodeBase64Url(KEY_BYTES))).toEqual(KEY_BYTES);
  });
});

function requireMailDomain(raw: string) {
  const parsed = parseMailDomain(raw);
  if (parsed.kind === "invalid") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected email");
  }
  return parsed.address;
}
