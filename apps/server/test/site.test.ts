import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { MailDomain } from "../../../packages/api-contract/src/mailbox-address.ts";
import {
  layoutForStage,
  operatorEmail,
  rootDomain,
  stageHostnameLabel,
  stageSendsMail,
} from "../src/site.ts";

const ROOT = Schema.decodeSync(MailDomain)("umail.example.com");

const readRoot = (env: Record<string, string>) =>
  Effect.exit(rootDomain.parse(ConfigProvider.fromEnv({ env })));

describe("stageHostnameLabel", () => {
  it("keeps canonical DNS-safe names unchanged", () => {
    expect(stageHostnameLabel("dev")).toBe("dev");
    expect(stageHostnameLabel("dev-max")).toBe("dev-max");
    expect(stageHostnameLabel("pr-12")).toBe("pr-12");
  });
});

describe("layoutForStage", () => {
  it("puts prod on the root domain itself", () => {
    expect(layoutForStage(ROOT, "prod")).toEqual({
      kind: "prod",
      apiHostname: "umail.example.com",
      mailDomain: "umail.example.com",
    });
  });

  it("gives every other stage a prefixed API host and a separate mail domain", () => {
    expect(layoutForStage(ROOT, "dev")).toEqual({
      kind: "preview",
      apiHostname: "dev.umail.example.com",
      mailDomain: "dev-mail.umail.example.com",
      testLocalParts: ["probe", "inbox"],
    });
    expect(layoutForStage(ROOT, "staging")).toEqual({
      kind: "preview",
      apiHostname: "staging.umail.example.com",
      mailDomain: "staging-mail.umail.example.com",
      testLocalParts: ["probe", "inbox"],
    });
  });

  it("rejects stage aliases instead of sharing another stage's DNS names", () => {
    expect(layoutForStage(ROOT, "pr-42").mailDomain).toBe("pr-42-mail.umail.example.com");
    expect(() => layoutForStage(ROOT, "pr_42")).toThrow(/not normalized/);
    expect(() => layoutForStage(ROOT, "PR-42")).toThrow(/lowercase/);
  });

  it.each(["", "-dev", "dev-", "dev.example", "dev/42", "dev 42"])(
    "rejects invalid stage %j before creating hostnames",
    (stage) => expect(() => layoutForStage(ROOT, stage)).toThrow(/Invalid stage/),
  );

  it("reserves five label characters for the mail suffix", () => {
    const longest = "a".repeat(58);
    expect(layoutForStage(ROOT, longest).mailDomain).toBe(`${longest}-mail.${ROOT}`);
    expect(() => layoutForStage(ROOT, "a".repeat(59))).toThrow(/1–58/);
  });

  it("rejects a preview when the full mail hostname exceeds the DNS limit", () => {
    const longRoot = Schema.decodeSync(MailDomain)(
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(52)}`,
    );
    expect(layoutForStage(longRoot, "dev").mailDomain).toHaveLength(253);
    expect(() => layoutForStage(longRoot, "test")).toThrow(/253 characters/);
  });

  it("never reuses the preview API host as the preview mail domain", () => {
    const site = layoutForStage(ROOT, "dev");
    expect(site.mailDomain).not.toBe(site.apiHostname);
  });
});

describe("rootDomain", () => {
  it.effect("parses UMAIL_DOMAIN into a mail domain", () =>
    Effect.gen(function* () {
      const exit = yield* readRoot({ UMAIL_DOMAIN: " Umail.Example.com " });
      expect(exit).toStrictEqual(Exit.succeed("umail.example.com"));
    }),
  );

  it.effect("rejects a missing UMAIL_DOMAIN", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* readRoot({}))).toBe(true);
    }),
  );

  it.effect("rejects an invalid UMAIL_DOMAIN", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* readRoot({ UMAIL_DOMAIN: "" }))).toBe(true);
      expect(Exit.isFailure(yield* readRoot({ UMAIL_DOMAIN: "inbox@umail.example.com" }))).toBe(
        true,
      );
    }),
  );
});

describe("operatorEmail", () => {
  const read = (value: string) =>
    Effect.exit(
      operatorEmail.parse(
        ConfigProvider.fromEnv({
          env: { UMAIL_DOMAIN: "umail.example.com", UMAIL_OPERATOR_EMAIL: value },
        }),
      ),
    );
  const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

  it.effect("parses an inbox outside UMAIL_DOMAIN and rejects an invalid address", () =>
    Effect.gen(function* () {
      expect(yield* read(" Operator@Example.NET ")).toStrictEqual(
        Exit.succeed("Operator@example.net"),
      );
      expect(failureMessage(yield* read("not-an-address"))).toContain("ConfigError");
    }),
  );

  // An inbox umail hosts would let a client that reads it approve its own sends.
  it.effect.each(["operator@umail.example.com", "operator@Dev-Mail.Umail.Example.com"])(
    "rejects %s because umail hosts it",
    (address) =>
      Effect.gen(function* () {
        expect(failureMessage(yield* read(address))).toContain(
          "must be an inbox outside UMAIL_DOMAIN",
        );
      }),
  );
});

describe("stageSendsMail", () => {
  it("is true only for prod and dev", () => {
    expect(stageSendsMail("prod")).toBe(true);
    expect(stageSendsMail("dev")).toBe(true);
    expect(stageSendsMail("staging")).toBe(false);
    expect(stageSendsMail("pr-12")).toBe(false);
  });
});
