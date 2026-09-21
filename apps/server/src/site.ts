import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import {
  type MailDomain,
  parseMailDomain,
} from "../../../packages/api-contract/src/mailbox-address.ts";

export const previewMailLocalParts = ["probe", "inbox"] as const;

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

export const rootDomain: Config.Config<MailDomain> = Config.string("UMAIL_DOMAIN").pipe(
  Config.mapOrFail((raw) => {
    const parsed = parseMailDomain(raw);
    if (parsed.kind === "invalid") {
      return Effect.die(new Error("UMAIL_DOMAIN is not a valid mail domain."));
    }
    return Effect.succeed(parsed.domain);
  }),
);

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

function previewMailDomain(label: string, root: MailDomain): MailDomain {
  const parsed = parseMailDomain(`${label}-mail.${root}`);
  if (parsed.kind === "invalid") {
    throw new Error(`Stage label "${label}" does not form a valid mail domain under ${root}.`);
  }
  return parsed.domain;
}
