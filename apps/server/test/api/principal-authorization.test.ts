import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  operatorOAuthPrincipal,
  parseExternalMailAddress,
  type Principal,
  requireApprovalSendMode,
  type ExternalMailAddress,
} from "@umail/api-contract";
import {
  mailboxAllowed,
  mailboxScopeOf,
  requireRead,
  requireSend,
} from "../../src/api/principal.ts";

const MCP_PRINCIPAL = {
  authority: "mcp",
  identity: {
    kind: "oauth",
    userId: "operator-1",
    clientId: "client-1",
    clientLabel: "Reader",
  },
  policy: {
    mailboxIds: ["mailbox-1"],
    canRead: false,
    sendMode: requireApprovalSendMode(),
    recipientAllowlist: [mailAddress("recipient@example.com")],
  },
} as const satisfies Principal;

describe("OAuth principal authorization", () => {
  it("constructs the fixed full-authority operator policy", () => {
    expect(operatorOAuthPrincipal("operator-1", "cli-1")).toEqual({
      authority: "operator",
      identity: {
        kind: "oauth",
        userId: "operator-1",
        clientId: "cli-1",
        clientLabel: "AgentMail CLI",
      },
      policy: {
        mailboxIds: "all",
        canRead: true,
        sendMode: { kind: "allow" },
        recipientAllowlist: "any",
      },
    });
  });

  it("enforces live MCP mailbox, read, and send policy", async () => {
    expect(mailboxAllowed(MCP_PRINCIPAL, "mailbox-1")).toBe(true);
    expect(mailboxAllowed(MCP_PRINCIPAL, "mailbox-2")).toBe(false);
    expect(mailboxScopeOf(MCP_PRINCIPAL)).toEqual(["mailbox-1"]);
    await expect(Effect.runPromise(requireSend(MCP_PRINCIPAL))).resolves.toBeUndefined();
    await expect(Effect.runPromise(requireRead(MCP_PRINCIPAL))).rejects.toMatchObject({
      _tag: "Forbidden",
    });
  });
});

function mailAddress(raw: string): ExternalMailAddress {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error(`Invalid test address: ${raw}`);
  }
  return parsed.address;
}
