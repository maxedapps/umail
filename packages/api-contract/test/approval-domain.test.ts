import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ApprovalRequesterSnapshot,
  ApprovalToken,
  ApprovalTokenHash,
  approvalRequesterSnapshot,
  type Principal,
  requireApprovalSendMode,
} from "../src/index.ts";

const MCP_PRINCIPAL = {
  authority: "mcp",
  identity: {
    kind: "oauth",
    userId: "operator-1",
    clientId: "oauth-client-1",
    clientLabel: "Deployment agent",
  },
  policy: {
    mailboxIds: "all",
    canRead: true,
    canDelete: false,
    sendMode: requireApprovalSendMode(),
    recipientAllowlist: "any",
    canAdmin: false,
  },
} as const satisfies Principal;

describe("approval capability domains", () => {
  it("accepts only exact lowercase 32-byte hexadecimal tokens and hashes", () => {
    const token = Schema.decodeSync(ApprovalToken)("a".repeat(64));
    const hash = Schema.decodeSync(ApprovalTokenHash)("b".repeat(64));
    expect(token).toHaveLength(64);
    expect(hash).toHaveLength(64);
    for (const schema of [ApprovalToken, ApprovalTokenHash]) {
      expect(() => Schema.decodeSync(schema)("a".repeat(63))).toThrow();
      expect(() => Schema.decodeSync(schema)("A".repeat(64))).toThrow();
      expect(() => Schema.decodeSync(schema)(`${"a".repeat(63)}g`)).toThrow();
    }
  });

  it("keeps plaintext capabilities and persisted hashes noninterchangeable", () => {
    expectTypeOf<ApprovalToken>().not.toEqualTypeOf<ApprovalTokenHash>();
  });
});

describe("approval requester snapshots", () => {
  it("captures the verified OAuth client id and policy label", () => {
    expect(approvalRequesterSnapshot(MCP_PRINCIPAL)).toEqual(
      new ApprovalRequesterSnapshot({
        clientId: "oauth-client-1",
        label: "Deployment agent",
      }),
    );
  });

  it("rejects incomplete OAuth client display data", () => {
    expect(() =>
      Schema.decodeSync(ApprovalRequesterSnapshot)({
        clientId: "oauth-client-1",
        label: "",
      }),
    ).toThrow();
  });
});
