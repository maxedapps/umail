import {
  PrincipalPolicy,
  parseMailAddressList,
  parsePrincipalMailboxIds,
  parsePrincipalRecipientAllowlist,
  requireApprovalSendMode,
  type PrincipalSendMode,
} from "@umail/api-contract";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { randomId } from "../crypto.ts";

// Who may use AgentMail lives in the auth database, next to the OAuth grants: an MCP client may act
// only while the operator's consent for it has an `mcpPolicy` row. The row references the consent
// with ON DELETE CASCADE, so deleting the consent revokes the policy with it.

export const MCP_POLICY_MODEL = "mcpPolicy" as const;

// One row of the clients page: an MCP consent (with or without its policy), or a client that only
// holds refresh tokens, like the CLI.
export type ClientGrant = {
  readonly clientId: string;
  readonly name: string | null;
  readonly consentId: string | null;
  readonly policy: PrincipalPolicy | null;
};

const StoredPolicy = Schema.fromJsonString(PrincipalPolicy);

const PolicyRow = Schema.Struct({ policy: Schema.String });

const ClientNameRow = Schema.Struct({ name: Schema.NullOr(Schema.String) });

const GrantRow = Schema.Struct({
  clientId: Schema.String,
  name: Schema.NullOr(Schema.String),
  consentId: Schema.NullOr(Schema.String),
  policy: Schema.NullOr(Schema.String),
});

export function makeAccess(db: Cloudflare.D1.QueryDatabaseClient, operatorId: string) {
  // The operator's grant to the client: none (never given, or revoked), a consent without a usable
  // policy, or the policy. Only a policy gives access.
  const mcpGrant = Effect.fn("Access.mcpGrant")(function* (clientId: string) {
    const row = yield* db
      .prepare(
        `SELECT p.policy AS policy
         FROM oauthConsent c
         LEFT JOIN mcpPolicy p ON p.consentId = c.id
         WHERE c.clientId = ? AND c.userId = ?`,
      )
      .bind(clientId, operatorId)
      .first();
    if (row === null) return { kind: "none" } as const;
    const policy = decodeStoredPolicy(row);
    return policy === null
      ? ({ kind: "no_policy" } as const)
      : ({ kind: "policy", policy } as const);
  });
  return {
    mcpGrant,

    // The client's policy, or null for no access.
    mcpPolicy: (clientId: string) =>
      Effect.map(mcpGrant(clientId), (grant) => (grant.kind === "policy" ? grant.policy : null)),

    list: Effect.fn("Access.list")(function* () {
      const { results } = yield* db
        .prepare(
          `SELECT c.clientId AS clientId, cl.name AS name, c.id AS consentId, p.policy AS policy
           FROM oauthConsent c
           LEFT JOIN mcpPolicy p ON p.consentId = c.id
           LEFT JOIN oauthClient cl ON cl.clientId = c.clientId
           WHERE c.userId = ?
           UNION
           SELECT DISTINCT t.clientId, cl.name, NULL, NULL
           FROM oauthRefreshToken t
           LEFT JOIN oauthClient cl ON cl.clientId = t.clientId
           WHERE t.userId = ? AND t.revoked IS NULL
             AND t.clientId NOT IN (SELECT clientId FROM oauthConsent WHERE userId = ?)
           ORDER BY clientId`,
        )
        .bind(operatorId, operatorId, operatorId)
        .all();
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(GrantRow))(results).pipe(
        Effect.orDie,
      );
      return rows.map((row): ClientGrant => ({
        clientId: row.clientId,
        name: row.name,
        consentId: row.consentId,
        policy: row.policy === null ? null : decodeStoredPolicy(row),
      }));
    }),

    // Sets the policy of one of the operator's consents; false when there is no such consent.
    setPolicy: Effect.fn("Access.setPolicy")(function* (
      consentId: string,
      policy: PrincipalPolicy,
    ) {
      const consent = yield* db
        .prepare("SELECT id FROM oauthConsent WHERE id = ? AND userId = ?")
        .bind(consentId, operatorId)
        .first();
      if (consent === null) return false;
      yield* db
        .prepare(
          `INSERT INTO mcpPolicy (id, consentId, policy) VALUES (?, ?, ?)
           ON CONFLICT (consentId) DO UPDATE SET policy = excluded.policy`,
        )
        .bind(yield* randomId, consentId, encodePolicy(policy))
        .run();
      return true;
    }),

    // The registered client's name, or null for an unknown client or one without a name.
    clientName: Effect.fn("Access.clientName")(function* (clientId: string) {
      const row = yield* db
        .prepare("SELECT name FROM oauthClient WHERE clientId = ?")
        .bind(clientId)
        .first();
      return Schema.decodeUnknownOption(ClientNameRow)(row).pipe(
        Option.flatMap((decoded) => Option.fromNullishOr(decoded.name)),
        Option.getOrNull,
      );
    }),

    // Ends every grant the client holds. Deleting the consent deletes its policy, so reconnecting
    // shows the consent screen again; the client's registration stays.
    revoke: (clientId: string) =>
      db
        .batch([
          db
            .prepare("DELETE FROM oauthAccessToken WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
          db
            .prepare("DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
          db
            .prepare("DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
        ])
        .pipe(Effect.asVoid),
  };
}

export type Access = ReturnType<typeof makeAccess>;

export function encodePolicy(policy: PrincipalPolicy): string {
  return Schema.encodeSync(StoredPolicy)(policy);
}

function decodeStoredPolicy(row: unknown): PrincipalPolicy | null {
  return Schema.decodeUnknownOption(PolicyRow)(row).pipe(
    Option.flatMap((stored) => Schema.decodeOption(StoredPolicy)(stored.policy)),
    Option.getOrNull,
  );
}

// The policy fields of the consent screen and the clients page. Omitted fields keep the consent
// defaults: read access, any recipient, and every send needing approval.
const PolicyForm = Schema.Struct({
  mailboxes: Schema.String,
  sendMode: Schema.Literals(["deny", "allow", "requireApproval"]),
  canRead: Schema.optionalKey(Schema.Boolean),
  recipients: Schema.optionalKey(Schema.String),
  preapproved: Schema.optionalKey(Schema.String),
});

export type PolicyField = "mailboxes" | "recipients" | "preapproved";

export type PolicyFormResult =
  | { readonly kind: "ok"; readonly policy: PrincipalPolicy }
  | { readonly kind: "invalid"; readonly field: PolicyField; readonly message: string };

export function policyFromForm(input: unknown): PolicyFormResult {
  const form = Schema.decodeUnknownOption(PolicyForm)(input);
  if (Option.isNone(form)) {
    return invalid("mailboxes", "Choose which mailboxes this client may use and how it may send.");
  }
  const mailboxIds = parsePrincipalMailboxIds(form.value.mailboxes);
  if (mailboxIds.kind !== "ok") return invalid("mailboxes", "Choose at least one mailbox.");
  const recipients = parsePrincipalRecipientAllowlist(form.value.recipients ?? "any");
  if (recipients.kind === "empty") {
    return invalid("recipients", "List at least one recipient, or allow anyone.");
  }
  if (recipients.kind !== "ok") return invalid("recipients", notAnAddress(recipients.value));
  const preapproved =
    form.value.sendMode === "requireApproval"
      ? parseMailAddressList(form.value.preapproved ?? "")
      : null;
  if (preapproved !== null && preapproved.kind !== "ok") {
    return invalid("preapproved", notAnAddress(preapproved.value));
  }
  const sendMode: PrincipalSendMode =
    form.value.sendMode === "requireApproval"
      ? requireApprovalSendMode(preapproved?.addresses)
      : { kind: form.value.sendMode };
  return {
    kind: "ok",
    policy: {
      mailboxIds: mailboxIds.mailboxIds,
      canRead: form.value.canRead ?? true,
      sendMode,
      recipientAllowlist: recipients.recipientAllowlist,
    },
  };
}

function invalid(field: PolicyField, message: string): PolicyFormResult {
  return { kind: "invalid", field, message };
}

function notAnAddress(value: string): string {
  return `“${value}” is not an email address.`;
}
