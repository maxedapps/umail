import type { D1Database } from "@cloudflare/workers-types";
import { parseExternalMailAddress, type ExternalMailAddress } from "@umail/api-contract";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { WebCrypto, randomId } from "../crypto.ts";
import { AuthDb } from "../resources.ts";
import {
  FIRST_PARTY_CLIENT_DISCOVERY_ID,
  OFFLINE_ACCESS_SCOPE,
  UMAIL_OAUTH_SCOPE,
  firstPartyClients,
  makeAuthOptions,
  type FirstPartyClient,
} from "./options.ts";

const CREDENTIAL_PROVIDER_ID = "credential" as const;
const CREDENTIAL_ISSUER = "local:credential" as const;
const AUTH_SCHEMA_SECRET = "umail-auth-schema" as const;

type AuthProvisionInput = {
  readonly identity: { readonly databaseId: string };
  readonly runNonce: string;
  readonly operatorEmail: string;
  readonly restResource: string;
  readonly mcpResource: string;
};

type AuthDatabase = Cloudflare.D1.QueryDatabaseClient;

export const AuthProvision = Alchemy.Action(
  "AuthProvision",
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    return Effect.fn(function* (input: AuthProvisionInput) {
      const password = Redacted.value(yield* Config.redacted("UMAIL_OPERATOR_PASSWORD"));
      return yield* provisionAuth(db, { ...input, password });
    }, Effect.provide(WebCrypto));
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
);

const IdRow = Schema.Struct({ id: Schema.String });

const ExistingClientRow = Schema.Struct({
  clientId: Schema.String,
  clientDiscoveryId: Schema.NullOr(Schema.String),
});

const ExistingAccountRow = Schema.Struct({
  id: Schema.String,
  password: Schema.NullOr(Schema.String),
  issuer: Schema.String,
  providerId: Schema.String,
  accountId: Schema.String,
  userId: Schema.String,
});
type ExistingAccountRow = typeof ExistingAccountRow.Type;

function authMigrationOptions() {
  return makeAuthOptions({ apiHostname: "schema.umail.invalid" }, "schema-migration-operator", {
    rateLimit: true,
  });
}

const applyAuthSchema = Effect.fn("applyAuthSchema")(function* (db: AuthDatabase) {
  const database = yield* db.raw;
  // Deployment-only: keep migration dependencies out of the Worker startup path.
  const { getMigrations } = yield* Effect.promise(() => import("better-auth/db/migration"));
  const migrations = yield* Effect.promise(() =>
    getMigrations({
      ...authMigrationOptions(),
      database: database as D1Database,
      secret: AUTH_SCHEMA_SECRET,
      telemetry: { enabled: false },
    }),
  );
  yield* Effect.promise(() => migrations.runMigrations());
});

export const provisionAuth = Effect.fn("provisionAuth")(function* (
  db: AuthDatabase,
  request: AuthProvisionInput & { readonly password: string },
) {
  if (request.password.length === 0) {
    return yield* Effect.die(new Error("UMAIL_OPERATOR_PASSWORD is required"));
  }
  if (request.password.length < 12) {
    return yield* Effect.die(new Error("UMAIL_OPERATOR_PASSWORD must be at least 12 characters"));
  }
  const operatorEmail = betterAuthLookupEmail(canonicalOperatorEmail(request.operatorEmail));
  yield* applyAuthSchema(db);
  const now = DateTime.formatIso(yield* DateTime.now);
  // The operator is the user with the configured email.
  const existingUser = yield* db
    .prepare(`SELECT id FROM user WHERE email = ?`)
    .bind(operatorEmail)
    .first();
  const operatorId =
    existingUser === null ? yield* randomId : Schema.decodeUnknownSync(IdRow)(existingUser).id;
  const existingAccount = yield* loadCredentialAccount(db, operatorId);
  const passwordHash = yield* nextPasswordHash(request.password, existingAccount?.password ?? null);

  yield* persistOperatorIdentity(db, {
    operatorId,
    operatorEmail,
    userExists: existingUser !== null,
    account: existingAccount,
    passwordHash: passwordHash.hash,
    passwordChanged: passwordHash.changed,
    now,
  });
  yield* provisionStaticResources(db, request, now);
  for (const { client, resource } of firstPartyClients()) {
    const resourceUrl = resource === "rest" ? request.restResource : request.mcpResource;
    yield* provisionStaticClient(db, client, resourceUrl, now);
  }

  return { operatorId };
});

function canonicalOperatorEmail(raw: string): ExternalMailAddress {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("UMAIL_OPERATOR_EMAIL is not a valid email address.");
  }
  return parsed.address;
}

function betterAuthLookupEmail(address: ExternalMailAddress): ExternalMailAddress {
  const parsed = parseExternalMailAddress(address.toLowerCase());
  if (parsed.kind !== "ok") {
    throw new Error("UMAIL_OPERATOR_EMAIL is not a valid email address.");
  }
  return parsed.address;
}

const nextPasswordHash = Effect.fn("nextPasswordHash")(function* (
  password: string,
  existingHash: string | null,
) {
  if (
    existingHash !== null &&
    (yield* Effect.promise(() => verifyPassword({ hash: existingHash, password })))
  ) {
    return { hash: existingHash, changed: false };
  }
  return { hash: yield* Effect.promise(() => hashPassword(password)), changed: true };
});

const loadCredentialAccount = Effect.fn("loadCredentialAccount")(function* (
  db: AuthDatabase,
  operatorId: string,
) {
  const row = yield* db
    .prepare(
      `SELECT id, password, issuer, providerId, accountId, userId
       FROM account
       WHERE userId = ? AND providerId = ?`,
    )
    .bind(operatorId, CREDENTIAL_PROVIDER_ID)
    .first();
  if (row === null) return null;
  const decoded = Schema.decodeUnknownOption(ExistingAccountRow)(row);
  if (Option.isNone(decoded)) {
    return yield* Effect.die(
      new Error("credential account row does not match Better Auth 1.7.2 mapping"),
    );
  }
  return decoded.value;
});

const persistOperatorIdentity = Effect.fn("persistOperatorIdentity")(function* (
  db: AuthDatabase,
  input: {
    readonly operatorId: string;
    readonly operatorEmail: ExternalMailAddress;
    readonly userExists: boolean;
    readonly account: ExistingAccountRow | null;
    readonly passwordHash: string;
    readonly passwordChanged: boolean;
    readonly now: string;
  },
) {
  const account = input.account;
  const statements = [
    input.userExists
      ? db
          .prepare(`UPDATE user SET name = ?, emailVerified = ?, updatedAt = ? WHERE id = ?`)
          .bind("operator", 1, input.now, input.operatorId)
      : db
          .prepare(
            `INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          )
          .bind(input.operatorId, "operator", input.operatorEmail, 1, input.now, input.now),
  ];

  if (account === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO account (
             id, accountId, providerId, userId, issuer, password,
             accessToken, refreshToken, idToken, scope, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .bind(
          input.operatorId,
          input.operatorId,
          CREDENTIAL_PROVIDER_ID,
          input.operatorId,
          CREDENTIAL_ISSUER,
          input.passwordHash,
          input.now,
          input.now,
        ),
    );
  } else if (account.issuer !== CREDENTIAL_ISSUER || input.passwordChanged) {
    statements.push(
      db
        .prepare(`UPDATE account SET issuer = ?, password = ?, updatedAt = ? WHERE id = ?`)
        .bind(CREDENTIAL_ISSUER, input.passwordHash, input.now, account.id),
    );
  }

  // A new password ends every session and grant made with the old one.
  if (input.passwordChanged && account !== null) {
    statements.push(
      db.prepare(`DELETE FROM session WHERE userId = ?`).bind(input.operatorId),
      db.prepare(`DELETE FROM oauthAccessToken WHERE userId = ?`).bind(input.operatorId),
      db.prepare(`DELETE FROM oauthRefreshToken WHERE userId = ?`).bind(input.operatorId),
      db.prepare(`DELETE FROM oauthConsent WHERE userId = ?`).bind(input.operatorId),
      db.prepare(`DELETE FROM verification`),
      db.prepare(`DELETE FROM deviceCode`),
    );
  }

  yield* db.batch(statements);
});

const provisionStaticResources = Effect.fn("provisionStaticResources")(function* (
  db: AuthDatabase,
  request: AuthProvisionInput,
  now: string,
) {
  const scopes = jsonText([UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE]);
  yield* upsertOwnedResource(db, {
    identifier: request.restResource,
    name: "AgentMail REST",
    allowedScopes: scopes,
    now,
  });
  yield* upsertOwnedResource(db, {
    identifier: request.mcpResource,
    name: "AgentMail MCP",
    allowedScopes: scopes,
    now,
  });
});

const upsertOwnedResource = Effect.fn("upsertOwnedResource")(function* (
  db: AuthDatabase,
  input: {
    readonly identifier: string;
    readonly name: string;
    readonly allowedScopes: string;
    readonly now: string;
  },
) {
  const existing = yield* db
    .prepare(`SELECT identifier FROM oauthResource WHERE identifier = ?`)
    .bind(input.identifier)
    .first();
  if (existing === null) {
    yield* db
      .prepare(
        `INSERT INTO oauthResource (
           id, identifier, name, accessTokenTtl, refreshTokenTtl, signingAlgorithm, signingKeyId,
           allowedScopes, customClaims, dpopBoundAccessTokensRequired, disabled, policyVersion,
           metadata, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        yield* randomId,
        input.identifier,
        input.name,
        300,
        input.allowedScopes,
        0,
        0,
        1,
        input.now,
        input.now,
      )
      .run();
    return;
  }
  yield* db
    .prepare(
      `UPDATE oauthResource
       SET name = ?, accessTokenTtl = ?, allowedScopes = ?, updatedAt = ?
       WHERE identifier = ?`,
    )
    .bind(input.name, 300, input.allowedScopes, input.now, input.identifier)
    .run();
});

const provisionStaticClient = Effect.fn("provisionStaticClient")(function* (
  db: AuthDatabase,
  client: FirstPartyClient,
  resource: string,
  now: string,
) {
  const existing = yield* db
    .prepare(`SELECT clientId, clientDiscoveryId FROM oauthClient WHERE clientId = ?`)
    .bind(client.clientId)
    .first();
  const fields = [
    client.name ?? client.clientId,
    "none",
    jsonText(client.grantTypes ?? []),
    jsonText(client.responseTypes ?? []),
    jsonText(client.redirectUris ?? []),
    jsonText([UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE]),
    client.requirePKCE === true ? 1 : 0,
    client.metadata ?? null,
  ] as const;
  if (existing === null) {
    yield* db
      .prepare(
        `INSERT INTO oauthClient (
           id, clientId, clientDiscoveryId, name, tokenEndpointAuthMethod, grantTypes, responseTypes,
           redirectUris, scopes, requirePKCE, metadata, disabled, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(client.clientId, client.clientId, FIRST_PARTY_CLIENT_DISCOVERY_ID, ...fields, now, now)
      .run();
  } else {
    const decoded = Schema.decodeUnknownOption(ExistingClientRow)(existing);
    if (Option.isNone(decoded)) {
      return yield* Effect.die(new Error(`oauthClient row for ${client.clientId} is not usable`));
    }
    if (decoded.value.clientDiscoveryId !== FIRST_PARTY_CLIENT_DISCOVERY_ID) {
      return yield* Effect.die(
        new Error(
          `oauthClient ${client.clientId} is owned by ${decoded.value.clientDiscoveryId ?? "another registrant"}`,
        ),
      );
    }
    yield* db
      .prepare(
        `UPDATE oauthClient
         SET name = ?, tokenEndpointAuthMethod = ?, grantTypes = ?, responseTypes = ?,
             redirectUris = ?, scopes = ?, requirePKCE = ?, metadata = ?, updatedAt = ?
         WHERE clientId = ?`,
      )
      .bind(...fields, now, client.clientId)
      .run();
  }

  const link = yield* db
    .prepare(`SELECT clientId FROM oauthClientResource WHERE clientId = ? AND resourceId = ?`)
    .bind(client.clientId, resource)
    .first();
  if (link === null) {
    yield* db
      .prepare(
        `INSERT INTO oauthClientResource (id, clientId, resourceId, metadata, createdAt)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .bind(yield* randomId, client.clientId, resource, now)
      .run();
  }
});

function jsonText(values: ReadonlyArray<string>): string {
  return JSON.stringify(values);
}
