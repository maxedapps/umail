import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ExternalMailAddress } from "../../../packages/api-contract/src/mail-contact.ts";
import { MailDomain, parseMailDomain } from "../../../packages/api-contract/src/mailbox-address.ts";

const previewMailLocalParts = ["probe", "inbox"] as const;

export type StageSite =
  | {
      readonly kind: "prod";
      readonly apiHostname: string;
      readonly mailDomain: MailDomain;
    }
  | {
      readonly kind: "preview";
      readonly apiHostname: string;
      readonly mailDomain: MailDomain;
      readonly testLocalParts: typeof previewMailLocalParts;
    };

// Trims and lower-cases the domain, as `parseMailDomain` does.
const ConfiguredMailDomain = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim().compose(SchemaTransformation.toLowerCase())),
  Schema.decodeTo(MailDomain),
);

// Trims the address and lower-cases its domain, as `parseExternalMailAddress` does.
const ConfiguredMailAddress = Schema.String.pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (raw: string) => {
        const trimmed = raw.trim();
        const at = trimmed.lastIndexOf("@");
        return at < 0 ? trimmed : `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
      },
      encode: (address: string) => address,
    }),
  ),
  Schema.decodeTo(ExternalMailAddress),
);

export const rootDomain = Config.schema(ConfiguredMailDomain, "UMAIL_DOMAIN");

// The operator inbox receives send approvals, so it must not be a mailbox umail hosts: a client that
// can read it could approve its own sends. Every stage's mail domain is the root or a subdomain.
export const operatorEmail = Config.all([
  rootDomain,
  Config.schema(ConfiguredMailAddress, "UMAIL_OPERATOR_EMAIL"),
]).pipe(
  Config.mapOrFail(([root, address]) => {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return domain === root || domain.endsWith(`.${root}`)
      ? Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `UMAIL_OPERATOR_EMAIL must be an inbox outside UMAIL_DOMAIN (${root}).`,
            }),
          ),
        )
      : Effect.succeed(address);
  }),
);

export const currentSite = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return layoutForStage(yield* rootDomain, stack.stage);
});

export function stageHostnameLabel(stage: string): string {
  // Leave room for the preview mail domain's "-mail" suffix in a 63-byte DNS label.
  if (stage.length > 58 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(stage)) {
    throw new Error(
      `Invalid stage "${stage}". Use 1–58 lowercase letters, digits, or internal hyphens, such as "pr-42". Stage names are not normalized; existing noncanonical previews require an explicit migration.`,
    );
  }
  return stage;
}

export function layoutForStage(root: MailDomain, stage: string): StageSite {
  if (stage === "prod") {
    return { kind: "prod", apiHostname: root, mailDomain: root };
  }
  const label = stageHostnameLabel(stage);
  if (`${label}-mail.${root}`.length > 253) {
    throw new Error(
      `Stage "${stage}" produces a mail domain longer than 253 characters under ${root}. Choose a shorter stage name or UMAIL_DOMAIN.`,
    );
  }
  return {
    kind: "preview",
    apiHostname: `${label}.${root}`,
    mailDomain: previewMailDomain(label, root),
    testLocalParts: previewMailLocalParts,
  };
}

export function stageSendsMail(stage: string): boolean {
  return stage === "prod" || stage === "dev";
}

// Prod and dev hold real mail and logins, so destroying them keeps their data. A preview's data is
// disposable, and destroying the preview removes it.
export function stageKeepsData(stage: string): boolean {
  return stage === "prod" || stage === "dev";
}

function previewMailDomain(label: string, root: MailDomain): MailDomain {
  const parsed = parseMailDomain(`${label}-mail.${root}`);
  if (parsed.kind === "invalid") {
    throw new Error(`Stage label "${label}" does not form a valid mail domain under ${root}.`);
  }
  return parsed.domain;
}
