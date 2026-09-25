import { describe, expect, it, layer } from "@effect/vitest";
import {
  ApprovalToken,
  hashApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

import { WebCrypto } from "../../src/crypto.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  approvalNotificationMail,
  deriveApprovalToken,
  newApprovalCapability,
  notificationKeyFromHex,
} from "../../src/mail/notifications.ts";

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
// HMAC-SHA256(KEY_BYTES, "approval-1"), computed independently.
const APPROVAL_1_TOKEN = "e4c030328644f464a3361f06fc31ab5c19d62193322871732e31531afc7f8f4c";
const NOW = "2026-01-01T00:00:00.000Z";

layer(WebCrypto)("approval tokens", (it) => {
  it.effect("derives the token as lowercase hex HMAC-SHA256 of the approval id", () =>
    Effect.gen(function* () {
      const key = notificationKeyFromHex(Encoding.encodeHex(KEY_BYTES));
      const token = yield* deriveApprovalToken(key, "approval-1");

      expect(token).toBe(APPROVAL_1_TOKEN);
      expect(Schema.is(ApprovalToken)(token)).toBe(true);
      expect(yield* deriveApprovalToken(key, "approval-2")).not.toBe(token);
      expect(yield* deriveApprovalToken(OTHER_KEY, "approval-1")).not.toBe(token);
    }),
  );

  it.effect("stores only the hash of the token the due-work pass re-derives", () =>
    Effect.gen(function* () {
      const capability = yield* newApprovalCapability(KEY_BYTES, NOW);

      const token = yield* deriveApprovalToken(KEY_BYTES, capability.approvalId);
      expect(yield* hashApprovalToken(token)).toBe(capability.tokenHash);
      expect(capability.tokenHash).not.toBe(token);
      expect(capability.expiresAt).toBe("2026-01-02T00:00:00.000Z");
    }),
  );
});

describe("approval notifications", () => {
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

  it("reads the key resource's 32 bytes of hex and rejects anything else", () => {
    expect(notificationKeyFromHex(Encoding.encodeHex(KEY_BYTES))).toEqual(KEY_BYTES);
    for (const secret of ["", Encoding.encodeHex(new Uint8Array(16)), "zz".repeat(32)]) {
      expect(() => notificationKeyFromHex(secret)).toThrow(
        "The notification key is not 32 bytes of hex",
      );
    }
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
