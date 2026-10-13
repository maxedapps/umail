import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Schema } from "effect";
import { MailDomainManifest, mailDomains } from "../../src/mail/domains.ts";
import { layoutForStage, operatorEmail } from "../../src/site.ts";
import { MailDomain } from "@umail/api-contract";

describe("installation mail-domain manifest", () => {
  it("normalizes domains, preserves capabilities and keeps web and receiving hosts separate", () => {
    const manifest = Schema.decodeSync(MailDomainManifest)([
      { name: " MAIL.Example.COM ", receive: true, send: false },
    ]);
    const site = layoutForStage(MailDomain.make("console.example.com"), "prod", manifest);
    expect(site).toMatchObject({
      apiHostname: "console.example.com",
      mailDomain: "mail.example.com",
      mailDomains: [{ name: "mail.example.com", receive: true, send: false }],
    });
    expect(
      layoutForStage(MailDomain.make("console.example.com"), "test-931", manifest),
    ).toMatchObject({
      apiHostname: "test-931.console.example.com",
      mailDomains: [{ name: "test-931-mail.mail.example.com" }],
    });
  });

  it.each([
    { manifest: [] },
    { manifest: [{ name: "example.com", receive: false, send: false }] },
    { manifest: [{ name: "example.com", receive: false, send: true }] },
    {
      manifest: [
        { name: "example.com", receive: true, send: false },
        { name: " EXAMPLE.com ", receive: true, send: true },
      ],
    },
  ])("rejects an empty, meaningless, sender-only or duplicate manifest: %j", ({ manifest }) => {
    expect(() => Schema.decodeSync(MailDomainManifest)(manifest)).toThrow();
  });

  it.effect("requires the manifest rather than silently using the web domain", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        mailDomains.parse(ConfigProvider.fromUnknown({ UMAIL_DOMAIN: "console.example.com" })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "protects approval mail from every receiving domain without treating the web host as a mailbox",
    () =>
      Effect.gen(function* () {
        const provider = (address: string) =>
          ConfigProvider.fromUnknown({
            UMAIL_DOMAIN: "console.example.com",
            UMAIL_OPERATOR_EMAIL: address,
            UMAIL_MAIL_DOMAINS: JSON.stringify([
              { name: "mail.example.com", receive: true, send: false },
              { name: "other.example.com", receive: true, send: false },
            ]),
          });
        expect(yield* operatorEmail.parse(provider("operator@console.example.com"))).toBe(
          "operator@console.example.com",
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(operatorEmail.parse(provider("operator@other.example.com"))),
          ),
        ).toBe(true);
      }),
  );
});
