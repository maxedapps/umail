import * as Alchemy from "alchemy";
import { UserFacingError } from "alchemy/UserFacingError";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ExternalMailAddress } from "../../../packages/api-contract/src/mail-contact.ts";
import { MailDomain, parseMailDomain } from "../../../packages/api-contract/src/mailbox-address.ts";
import { ConfiguredMailDomain, mailDomains, type MailDomainConfiguration } from "./mail/domains.ts";

const previewMailLocalParts = ["probe", "inbox"] as const;

export type StageSite =
  | {
      readonly kind: "prod";
      readonly apiHostname: string;
      readonly mailDomain: MailDomain;
      readonly mailDomains: ReadonlyArray<MailDomainConfiguration>;
    }
  | {
      readonly kind: "preview";
      readonly apiHostname: string;
      readonly mailDomain: MailDomain;
      readonly mailDomains: ReadonlyArray<MailDomainConfiguration>;
      readonly testLocalParts: typeof previewMailLocalParts;
    };

// A deploy configuration problem. alchemy prints a UserFacingError as one line instead of a trace.
class DeployConfigError extends Data.TaggedError("DeployConfigError")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

// Names the variable, which is the config issue's path: "UMAIL_DOMAIN is missing. Set it in .env."
// Environment values are always strings, so a type mismatch means the variable is unset or empty.
const formatConfigIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey" || issue._tag === "InvalidType"
      ? "is missing. Set it in .env."
      : SchemaIssue.defaultLeafHook(issue),
});

export function deployConfigError(error: Config.ConfigError): DeployConfigError {
  if (error.cause._tag === "SourceError") {
    return new DeployConfigError({ message: error.cause.message });
  }
  const [issue] = formatConfigIssue(error.cause.issue).issues;
  const name = issue?.path?.map(String).join(".") ?? "A variable";
  return new DeployConfigError({ message: `${name} ${issue?.message ?? "is invalid."}` });
}

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

// Stack identity is case-sensitive and must not be normalized: it selects existing cloud state.
// Only an absent variable keeps the original installation; a blank value is a config error.
export const stackName = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/, {
      message: "must start with a letter and contain only letters, digits or internal hyphens.",
    }),
    Schema.isMaxLength(32, { message: "must be at most 32 characters." }),
  ),
  "UMAIL_STACK",
).pipe(Config.withDefault("uMail"));

// Checked when the stack is evaluated, so a bad value fails before anything changes.
export const operatorPassword = Config.schema(
  Schema.Redacted(
    Schema.String.check(Schema.isMinLength(12, { message: "must be at least 12 characters." })),
  ),
  "UMAIL_OPERATOR_PASSWORD",
);

// The operator inbox receives send approvals, so it must not be a mailbox umail hosts: a client that
// can read it could approve its own sends. Every stage's mail domain is the root or a subdomain.
export const operatorEmail = Config.all([
  mailDomains,
  Config.schema(ConfiguredMailAddress, "UMAIL_OPERATOR_EMAIL"),
]).pipe(
  Config.mapEffect(([domains, address]) => {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return domains
      .filter(({ receive }) => receive)
      .map(({ name }) => name)
      .some((hosted) => domain === hosted || domain.endsWith(`.${hosted}`))
      ? Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "UMAIL_OPERATOR_EMAIL must be an inbox outside the receiving mail domains.",
            }),
          ),
        )
      : Effect.succeed(address);
  }),
);

export const currentSite = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return layoutForStage(yield* rootDomain, stack.stage, yield* mailDomains);
});

export function stageHostnameLabel(stage: string): string {
  // Leave room for the preview mail domain's "-mail" suffix in a 63-byte DNS label.
  if (stage.length > 58 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(stage)) {
    throw new DeployConfigError({
      message: `Invalid stage "${stage}". Use 1–58 lowercase letters, digits, or internal hyphens, such as "pr-42". Stage names are not normalized; existing noncanonical previews require an explicit migration.`,
    });
  }
  return stage;
}

export function layoutForStage(
  root: MailDomain,
  stage: string,
  domains: ReadonlyArray<MailDomainConfiguration>,
): StageSite {
  const primary = domains.find(({ send }) => send) ?? domains[0];
  if (primary === undefined)
    throw new DeployConfigError({ message: "UMAIL_MAIL_DOMAINS is empty." });
  if (stage === "prod") {
    return { kind: "prod", apiHostname: root, mailDomain: primary.name, mailDomains: domains };
  }
  const label = stageHostnameLabel(stage);
  if (domains.some(({ name }) => `${label}-mail.${name}`.length > 253)) {
    throw new DeployConfigError({
      message: `Stage "${stage}" produces a mail domain longer than 253 characters under ${root}. Choose a shorter stage name or UMAIL_DOMAIN.`,
    });
  }
  return {
    kind: "preview",
    apiHostname: `${label}.${root}`,
    mailDomain: previewMailDomain(label, primary.name),
    mailDomains: domains.map((domain) => ({
      ...domain,
      name: previewMailDomain(label, domain.name),
    })),
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
    throw new DeployConfigError({
      message: `Stage label "${label}" does not form a valid mail domain under ${root}.`,
    });
  }
  return parsed.domain;
}
