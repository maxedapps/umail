import { SendingIdentity } from "@umail/api-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  constructMailboxAddress,
  MailboxAddress,
  MailboxLocalPart,
  MailDomain,
  parseMailboxAddress,
  parseMailboxAddressForRegistration,
} from "../src/mailbox-address.ts";

describe("mailbox address contract", () => {
  it.each([
    {
      raw: " Inbox@UMail.Example.COM ",
      localPart: "inbox",
      domain: "umail.example.com",
      address: "inbox@umail.example.com",
    },
    {
      raw: "first.last-tag_1@Example.COM",
      localPart: "first.last-tag_1",
      domain: "example.com",
      address: "first.last-tag_1@example.com",
    },
  ])("canonicalizes $raw", ({ raw, localPart, domain, address }) => {
    expect(parseMailboxAddress(raw)).toEqual({
      kind: "ok",
      localPart,
      domain,
      address,
    });
  });

  it.each([
    "",
    "inbox",
    "@example.com",
    "inbox@",
    "in+box@example.com",
    "in box@example.com",
    "inbox@example.com@extra",
  ])("rejects invalid mailbox syntax: %s", (raw) => {
    expect(parseMailboxAddress(raw)).toEqual({ kind: "invalid" });
  });

  it.each([
    "postmaster",
    "abuse",
    "webmaster",
    "hostmaster",
    "admin",
    "administrator",
    "root",
    "mailer-daemon",
  ])("allows inbound %s but rejects it for registration", (localPart) => {
    const address = `${localPart}@example.com`;
    expect(parseMailboxAddress(address)).toMatchObject({ kind: "ok", address });
    expect(parseMailboxAddressForRegistration(address)).toEqual({ kind: "reserved" });
    expect(constructMailboxAddress(localPart, "example.com")).toEqual({ kind: "reserved" });
  });

  it("constructs a canonical registration address from independently supplied parts", () => {
    expect(constructMailboxAddress(" Inbox ", " UMail.Example.COM ")).toEqual({
      kind: "ok",
      localPart: "inbox",
      domain: "umail.example.com",
      address: "inbox@umail.example.com",
    });
  });

  it("rejects invalid registration parts", () => {
    expect(constructMailboxAddress("in+box", "example.com")).toEqual({ kind: "invalid" });
    expect(constructMailboxAddress("inbox", "example.com@extra")).toEqual({ kind: "invalid" });
  });

  it("rejects Unicode local parts that case-fold into the ASCII alphabet", () => {
    expect(parseMailboxAddress("K@example.com")).toEqual({ kind: "invalid" });
    expect(parseMailboxAddressForRegistration("K@example.com")).toEqual({ kind: "invalid" });
    expect(constructMailboxAddress(" K ", "example.com")).toEqual({ kind: "invalid" });
  });

  it("validates only canonical values through the branded schemas", () => {
    expect(Result.isSuccess(Schema.decodeResult(MailDomain)("example.com"))).toBe(true);
    expect(Result.isFailure(Schema.decodeResult(MailDomain)("Example.COM"))).toBe(true);
    expect(Result.isSuccess(Schema.decodeResult(MailboxLocalPart)("inbox"))).toBe(true);
    expect(Result.isFailure(Schema.decodeResult(MailboxLocalPart)("Inbox"))).toBe(true);
    expect(Result.isSuccess(Schema.decodeResult(MailboxAddress)("inbox@example.com"))).toBe(true);
    expect(Result.isFailure(Schema.decodeResult(MailboxAddress)("Inbox@example.com"))).toBe(true);
  });

  it("encodes a sending identity without admin-only address fields", () => {
    const parsed = parseMailboxAddress("inbox@example.com");
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;

    const encoded = Schema.encodeSync(SendingIdentity)(
      new SendingIdentity({
        id: "addr-1",
        address: parsed.address,
        displayName: "Inbox",
      }),
    );

    expect(encoded).toEqual({
      id: "addr-1",
      address: "inbox@example.com",
      displayName: "Inbox",
    });
  });
});
