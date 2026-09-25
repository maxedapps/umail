import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

import { ExternalMailAddress, parseExternalMailAddress } from "./mail-contact.ts";

export const PrincipalMailboxIds = Schema.Union([
  Schema.Literal("all"),
  Schema.NonEmptyArray(Schema.String),
]);
export type PrincipalMailboxIds = typeof PrincipalMailboxIds.Type;

export const PrincipalRecipientAllowlist = Schema.Union([
  Schema.Literal("any"),
  Schema.NonEmptyArray(ExternalMailAddress),
]);
export type PrincipalRecipientAllowlist = typeof PrincipalRecipientAllowlist.Type;

export const PrincipalSendMode = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("deny") }),
  Schema.Struct({ kind: Schema.Literal("allow") }),
  Schema.Struct({
    kind: Schema.Literal("requireApproval"),
    preapprovedRecipients: Schema.Array(ExternalMailAddress),
  }),
]);
export type PrincipalSendMode = typeof PrincipalSendMode.Type;

export function requireApprovalSendMode(
  preapprovedRecipients: ReadonlyArray<ExternalMailAddress> = [],
): PrincipalSendMode {
  return { kind: "requireApproval", preapprovedRecipients };
}

export type MailAddressListParseResult =
  | { readonly kind: "ok"; readonly addresses: ReadonlyArray<ExternalMailAddress> }
  | { readonly kind: "invalid_address"; readonly value: string };

export type PrincipalMailboxIdsParseResult =
  | { readonly kind: "ok"; readonly mailboxIds: PrincipalMailboxIds }
  | { readonly kind: "empty" };

export type PrincipalRecipientAllowlistParseResult =
  | { readonly kind: "ok"; readonly recipientAllowlist: PrincipalRecipientAllowlist }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid_address"; readonly value: string };

export function parseMailAddressList(raw: string): MailAddressListParseResult {
  const addresses: Array<ExternalMailAddress> = [];
  for (const entry of splitPolicyList(raw)) {
    const parsed = parseExternalMailAddress(entry);
    if (parsed.kind !== "ok") {
      return { kind: "invalid_address", value: entry };
    }
    addresses.push(parsed.address);
  }
  return { kind: "ok", addresses: [...new Set(addresses)] };
}

export function parsePrincipalMailboxIds(raw: string): PrincipalMailboxIdsParseResult {
  if (raw.trim() === "all") {
    return { kind: "ok", mailboxIds: "all" };
  }
  const [first, ...rest] = [...new Set(splitPolicyList(raw))];
  if (first === undefined) {
    return { kind: "empty" };
  }
  return { kind: "ok", mailboxIds: [first, ...rest] };
}

export function parsePrincipalRecipientAllowlist(
  raw: string,
): PrincipalRecipientAllowlistParseResult {
  if (raw.trim() === "any") {
    return { kind: "ok", recipientAllowlist: "any" };
  }
  const parsed = parseMailAddressList(raw);
  if (parsed.kind !== "ok") {
    return parsed;
  }
  const [first, ...rest] = parsed.addresses;
  if (first === undefined) {
    return { kind: "empty" };
  }
  return { kind: "ok", recipientAllowlist: [first, ...rest] };
}

function splitPolicyList(raw: string): ReadonlyArray<string> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const PrincipalPolicy = Schema.Struct({
  mailboxIds: PrincipalMailboxIds,
  canRead: Schema.Boolean,
  sendMode: PrincipalSendMode,
  recipientAllowlist: PrincipalRecipientAllowlist,
});
export type PrincipalPolicy = typeof PrincipalPolicy.Type;

export type OAuthIdentity = {
  readonly kind: "oauth";
  readonly userId: string;
  readonly clientId: string;
  readonly clientLabel: string;
};

export type PrincipalIdentity = OAuthIdentity;

export type OperatorPrincipal = {
  readonly authority: "operator";
  readonly identity: PrincipalIdentity;
  readonly policy: PrincipalPolicy;
};

export type McpPrincipal = {
  readonly authority: "mcp";
  readonly identity: PrincipalIdentity;
  readonly policy: PrincipalPolicy;
};

export type Principal = OperatorPrincipal | McpPrincipal;

// The static public OAuth client the CLI signs in as, and the scopes its tokens carry.
export const UMAIL_CLI_CLIENT_ID = "umail-cli" as const;
export const UMAIL_OAUTH_SCOPE = "umail:access" as const;
export const OFFLINE_ACCESS_SCOPE = "offline_access" as const;

// The operator's full access; the API and the account store's send check both use it.
export const OPERATOR_POLICY = {
  mailboxIds: "all",
  canRead: true,
  sendMode: { kind: "allow" },
  recipientAllowlist: "any",
} as const satisfies PrincipalPolicy;

export function operatorOAuthPrincipal(userId: string, clientId: string): OperatorPrincipal {
  return {
    authority: "operator",
    identity: { kind: "oauth", userId, clientId, clientLabel: "AgentMail CLI" },
    policy: OPERATOR_POLICY,
  };
}

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "umail/CurrentPrincipal",
) {}

export class PrincipalAuthorization extends HttpApiMiddleware.Service<
  PrincipalAuthorization,
  {
    provides: CurrentPrincipal;
    requires: never;
  }
>()("umail/PrincipalAuthorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
}) {}
