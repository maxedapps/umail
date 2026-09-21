import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  parseMailAddressList,
  parsePrincipalMailboxIds,
  parsePrincipalRecipientAllowlist,
  PrincipalPolicy,
  requireApprovalSendMode,
} from "../src/principal-authorization.ts";

describe("principal policy lists", () => {
  it("makes an empty mailbox or recipient set unrepresentable", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PrincipalPolicy)(policy([])))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(PrincipalPolicy)(policy("all", [])))).toBe(
      true,
    );
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(PrincipalPolicy)(policy(["mailbox-1"]))),
    ).toBe(true);
    expect(Result.isSuccess(Schema.decodeUnknownResult(PrincipalPolicy)(policy("all")))).toBe(true);
  });

  it("rejects a recipient allowlist entry that is not a mail address", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(PrincipalPolicy)(policy("all", ["not-an-address"])),
      ),
    ).toBe(true);
  });

  it("parses the mailbox wildcard, a list, and refuses an empty one", () => {
    expect(parsePrincipalMailboxIds("all")).toEqual({ kind: "ok", mailboxIds: "all" });
    expect(parsePrincipalMailboxIds(" mailbox-1 , mailbox-2 ")).toEqual({
      kind: "ok",
      mailboxIds: ["mailbox-1", "mailbox-2"],
    });
    expect(parsePrincipalMailboxIds("mailbox-1,mailbox-1")).toEqual({
      kind: "ok",
      mailboxIds: ["mailbox-1"],
    });
    expect(parsePrincipalMailboxIds(" , ")).toEqual({ kind: "empty" });
    expect(parsePrincipalMailboxIds("")).toEqual({ kind: "empty" });
  });

  it("names the offending entry rather than dropping it from an allowlist", () => {
    expect(parsePrincipalRecipientAllowlist("good@example.com,oops")).toEqual({
      kind: "invalid_address",
      value: "oops",
    });
    expect(parsePrincipalRecipientAllowlist("any")).toEqual({
      kind: "ok",
      recipientAllowlist: "any",
    });
    expect(parsePrincipalRecipientAllowlist(" , ")).toEqual({ kind: "empty" });
    const parsed = parsePrincipalRecipientAllowlist("a@example.com, a@example.com, b@example.com");
    expect(parsed).toEqual({
      kind: "ok",
      recipientAllowlist: ["a@example.com", "b@example.com"],
    });
  });

  it("treats an empty exemption list as valid because it means no exemptions", () => {
    expect(parseMailAddressList("")).toEqual({ kind: "ok", addresses: [] });
    expect(parseMailAddressList("a@example.com")).toEqual({
      kind: "ok",
      addresses: ["a@example.com"],
    });
    expect(parseMailAddressList("a@example.com,nope")).toEqual({
      kind: "invalid_address",
      value: "nope",
    });
  });
});

function policy(mailboxIds: unknown = "all", recipientAllowlist: unknown = "any") {
  return {
    mailboxIds,
    canRead: true,
    canDelete: false,
    sendMode: requireApprovalSendMode(),
    recipientAllowlist,
    canAdmin: false,
  };
}
