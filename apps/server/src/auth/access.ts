import {
  PrincipalPolicy,
  parseMailAddressList,
  parsePrincipalMailboxIds,
  parsePrincipalRecipientAllowlist,
  requireApprovalSendMode,
  type PrincipalSendMode,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Who may use AgentMail lives in the auth database, next to the OAuth grants: an MCP client may act
// only while the operator's consent for it has an `mcpPolicy` row. The row references the consent
// with ON DELETE CASCADE, so deleting the consent revokes the policy with it.

export const MCP_POLICY_MODEL = "mcpPolicy" as const;

export type AccessDatabase = {
  prepare(query: string): AccessStatement;
  batch(statements: Array<AccessStatement>): Promise<unknown>;
};

type AccessStatement = {
  bind(...values: Array<string | number | null>): AccessStatement;
  first(): Promise<unknown>;
  all(): Promise<{ readonly results: ReadonlyArray<unknown> }>;
  run(): Promise<unknown>;
};

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

const GrantRow = Schema.Struct({
  clientId: Schema.String,
  name: Schema.NullOr(Schema.String),
  consentId: Schema.NullOr(Schema.String),
  policy: Schema.NullOr(Schema.String),
});

export function makeAccess(db: AccessDatabase, operatorId: string) {
  return {
    // The client's policy, or null: no consent, no policy, or a policy that no longer decodes all
    // mean no access.
    mcpPolicy: (clientId: string): Effect.Effect<PrincipalPolicy | null> =>
      Effect.promise(() =>
        db
          .prepare(
            `SELECT p.policy AS policy
             FROM oauthConsent c
             JOIN mcpPolicy p ON p.consentId = c.id
             WHERE c.clientId = ? AND c.userId = ?`,
          )
          .bind(clientId, operatorId)
          .first(),
      ).pipe(Effect.map((row) => decodeStoredPolicy(row))),

    list: (): Effect.Effect<ReadonlyArray<ClientGrant>> =>
      Effect.promise(() =>
        db
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
          .all(),
      ).pipe(
        Effect.map(({ results }) =>
          Schema.decodeUnknownSync(Schema.Array(GrantRow))(results).map((row) => ({
            clientId: row.clientId,
            name: row.name,
            consentId: row.consentId,
            policy: row.policy === null ? null : decodeStoredPolicy(row),
          })),
        ),
      ),

    // Sets the policy of one of the operator's consents; false when there is no such consent.
    setPolicy: (consentId: string, policy: PrincipalPolicy): Effect.Effect<boolean> =>
      Effect.promise(async () => {
        const consent = await db
          .prepare("SELECT id FROM oauthConsent WHERE id = ? AND userId = ?")
          .bind(consentId, operatorId)
          .first();
        if (consent === null) return false;
        await db
          .prepare(
            `INSERT INTO mcpPolicy (id, consentId, policy) VALUES (?, ?, ?)
             ON CONFLICT (consentId) DO UPDATE SET policy = excluded.policy`,
          )
          .bind(crypto.randomUUID(), consentId, encodePolicy(policy))
          .run();
        return true;
      }),

    // Ends every grant the client holds. Deleting the consent deletes its policy, so reconnecting
    // shows the consent screen again; the client's registration stays.
    revoke: (clientId: string): Effect.Effect<void> =>
      Effect.promise(() =>
        db.batch([
          db
            .prepare("DELETE FROM oauthAccessToken WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
          db
            .prepare("DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
          db
            .prepare("DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?")
            .bind(clientId, operatorId),
        ]),
      ).pipe(Effect.asVoid),
  };
}

export type Access = ReturnType<typeof makeAccess>;

export function encodePolicy(policy: PrincipalPolicy): string {
  return Schema.encodeSync(StoredPolicy)(policy);
}

function decodeStoredPolicy(row: unknown): PrincipalPolicy | null {
  return Schema.decodeUnknownOption(PolicyRow)(row).pipe(
    Option.flatMap((stored) => Schema.decodeUnknownOption(StoredPolicy)(stored.policy)),
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

export function policyFromForm(input: unknown): PrincipalPolicy | null {
  const form = Schema.decodeUnknownOption(PolicyForm)(input);
  if (Option.isNone(form)) return null;
  const mailboxIds = parsePrincipalMailboxIds(form.value.mailboxes);
  const recipients = parsePrincipalRecipientAllowlist(form.value.recipients ?? "any");
  const sendMode = parseSendMode(form.value.sendMode, form.value.preapproved ?? "");
  if (mailboxIds.kind !== "ok" || recipients.kind !== "ok" || sendMode === null) return null;
  return {
    mailboxIds: mailboxIds.mailboxIds,
    canRead: form.value.canRead ?? true,
    sendMode,
    recipientAllowlist: recipients.recipientAllowlist,
  };
}

function parseSendMode(
  kind: "deny" | "allow" | "requireApproval",
  preapproved: string,
): PrincipalSendMode | null {
  if (kind !== "requireApproval") return { kind };
  const parsed = parseMailAddressList(preapproved);
  return parsed.kind === "ok" ? requireApprovalSendMode(parsed.addresses) : null;
}
