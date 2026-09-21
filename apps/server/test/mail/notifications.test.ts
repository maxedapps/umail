import {
  generateApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
} from "@umail/api-contract";
import * as Encoding from "effect/Encoding";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_NOTIFICATION_SUBJECT,
  approvalNotificationMail,
  createNotificationKeyring,
  decryptNotificationPayload,
  encryptNotificationPayload,
  notificationKeyringFromSecret,
  randomNotificationSecret,
  type NotificationJobIdentity,
} from "../../src/mail/notifications.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const IDENTITY: NotificationJobIdentity = {
  requesterClientId: "agent",
  requestId: "11111111-1111-4111-8111-111111111111",
  purpose: "approval_notification",
};

describe("notification payload encryption", () => {
  it("decrypts a persisted v1 payload produced before notification consolidation", async () => {
    // Fixed synthetic legacy wire fixture, independently encoded with Node AES-256-GCM:
    // key bytes 00..1f, nonce bytes 00..0b, JSON version/token/expiresAt, and v1 job AAD.
    const keyring = notificationKeyringFromSecret(
      Encoding.encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index)),
    );
    const record = {
      keyVersion: "v1",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext:
        "PCCgfreWq3TjY626ncsMAuiz6RbKWW9NClTRsCteOItgcs2YyqciqUaXS9i-sBABjzsD6T-wk-sNpB4sLtTN15FepR62txZQLmeeW9m4NtFZ6KoGEwVxRN-Y5rwRgtz-iox73IZz-CioMQ6DZUUTK4pXWJvT_xWqY89n_djEEz_W3AgSK1J6pstKypRgDvQ",
    };
    expect(await decryptNotificationPayload(record, IDENTITY, keyring, NOW)).toEqual({
      kind: "ok",
      payload: { version: 1, token: "0123456789abcdef".repeat(4), expiresAt: EXPIRES }, // gitleaks:allow -- synthetic legacy wire fixture
    });
    expect(
      await decryptNotificationPayload(
        record,
        { ...IDENTITY, requesterClientId: "other-agent" },
        keyring,
        NOW,
      ),
    ).toEqual({ kind: "forged" });
  });

  it("round-trips the same capability and binds job identity as AAD", async () => {
    const keyring = createNotificationKeyring("v1", [
      { version: "v1", secret: randomNotificationSecret() },
    ]);
    const token = generateApprovalToken();
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: EXPIRES },
      IDENTITY,
      keyring,
    );

    const decrypted = await decryptNotificationPayload(encrypted, IDENTITY, keyring, NOW);
    expect(decrypted).toEqual({
      kind: "ok",
      payload: { version: 1, token, expiresAt: EXPIRES },
    });

    const wrongJob = await decryptNotificationPayload(
      encrypted,
      { ...IDENTITY, requestId: "22222222-2222-4222-8222-222222222222" },
      keyring,
      NOW,
    );
    expect(wrongJob.kind).toBe("forged");
  });

  it("rejects a wrong key version and tampered ciphertext", async () => {
    const current = randomNotificationSecret();
    const other = randomNotificationSecret();
    const keyring = createNotificationKeyring("v1", [{ version: "v1", secret: current }]);
    const otherRing = createNotificationKeyring("v2", [{ version: "v2", secret: other }]);
    const token = generateApprovalToken();
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: EXPIRES },
      IDENTITY,
      keyring,
    );

    expect((await decryptNotificationPayload(encrypted, IDENTITY, otherRing, NOW)).kind).toBe(
      "unknown_key",
    );

    const tampered = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -2)}aa`,
    };
    expect((await decryptNotificationPayload(tampered, IDENTITY, keyring, NOW)).kind).toBe(
      "forged",
    );
  });

  it("surfaces expiry without leaking a usable send", async () => {
    const keyring = createNotificationKeyring("v1", [
      { version: "v1", secret: randomNotificationSecret() },
    ]);
    const token = generateApprovalToken();
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: NOW },
      IDENTITY,
      keyring,
    );
    const decrypted = await decryptNotificationPayload(
      encrypted,
      IDENTITY,
      keyring,
      "2026-01-01T00:00:01.000Z",
    );
    expect(decrypted.kind).toBe("expired");
    if (decrypted.kind === "expired") {
      expect(decrypted.payload.token).toBe(token);
    }
  });

  it("builds a canned notification without attacker-controlled subject or body copy", () => {
    const mailDomain = requireMailDomain("umail.example.com");
    const admin = requireExternal("operator@example.com");
    const mail = approvalNotificationMail({
      mailDomain,
      approvalAdminEmail: admin,
      expiresAt: EXPIRES,
      reviewUrl: "https://umail.example.com/approvals/abc",
    });
    expect(mail.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(mail.subject).not.toContain("Click here");
    expect(mail.text).toContain("https://umail.example.com/approvals/abc");
    expect(mail.text).toContain("AgentMail");
    expect(mail.text).not.toContain("Please send bitcoin");
    expect(mail.html).toBeNull();
  });

  it("rejects missing, padded, and standard-base64 notification secrets", () => {
    expect(() => notificationKeyringFromSecret("")).toThrow(
      "UMAIL_NOTIFICATION_KEY is not valid base64url",
    );
    expect(() =>
      notificationKeyringFromSecret(Encoding.encodeBase64(new Uint8Array(32).fill(0xfb))),
    ).toThrow("UMAIL_NOTIFICATION_KEY is not valid base64url");
    expect(() =>
      notificationKeyringFromSecret(Encoding.encodeBase64Url(new Uint8Array(16))),
    ).toThrow("UMAIL_NOTIFICATION_KEY is not valid base64url");
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
