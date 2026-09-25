import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  operatorPrincipal,
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

describe("principal authorization", () => {
  it("constructs the fixed full-authority operator policy for the acting client", () => {
    expect(operatorPrincipal("operator-1", "umail-web", "AgentMail web")).toEqual({
      authority: "operator",
      identity: {
        userId: "operator-1",
        clientId: "umail-web",
        clientLabel: "AgentMail web",
      },
      policy: {
        mailboxIds: "all",
        canRead: true,
        sendMode: { kind: "allow" },
        recipientAllowlist: "any",
      },
    });
  });

  it.effect("enforces live MCP mailbox, read, and send policy", () =>
    Effect.gen(function* () {
      expect(mailboxAllowed(MCP_PRINCIPAL, "mailbox-1")).toBe(true);
      expect(mailboxAllowed(MCP_PRINCIPAL, "mailbox-2")).toBe(false);
      expect(mailboxScopeOf(MCP_PRINCIPAL)).toEqual(["mailbox-1"]);
      expect(yield* requireSend(MCP_PRINCIPAL)).toBeUndefined();
      expect(yield* Effect.flip(requireRead(MCP_PRINCIPAL))).toMatchObject({
        _tag: "Forbidden",
      });
    }),
  );
});

function mailAddress(raw: string): ExternalMailAddress {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error(`Invalid test address: ${raw}`);
  }
  return parsed.address;
}
