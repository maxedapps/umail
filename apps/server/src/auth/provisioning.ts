import type { D1Database } from "@cloudflare/workers-types";
import { parseExternalMailAddress, type ExternalMailAddress } from "@umail/api-contract";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  AuthDb,
  AUTH_CONTROL_ROW_ID,
  AUTH_CONTROL_TABLE,
  AUTH_CONTROL_TABLE_SQL,
  readAuthControl,
  type AuthControl,
} from "./auth-control.ts";
import {
  CURSOR_CLOUD_CALLBACK_URI,
  CURSOR_GROK_BOT_CLIENT_ID,
  FIRST_PARTY_CLIENT_DISCOVERY_ID,
  FIRST_PARTY_CLIENT_METADATA_JSON,
  OFFLINE_ACCESS_SCOPE,
  UMAIL_OAUTH_SCOPE,
  cursorGrokBotClient,
  makeAuthOptions,
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

type AuthProvisionResult = {
  readonly operatorId: string;
};

export const AuthProvision = Alchemy.Action(
  "AuthProvision",
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    return Effect.fn(function* (input: AuthProvisionInput) {
      const password = Redacted.value(yield* Config.redacted("UMAIL_OPERATOR_PASSWORD"));
      const raw = yield* db.raw;
      return yield* Effect.promise(() =>
        provisionAuth(raw as AuthD1Database, { ...input, password }),
      );
    });
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
);

export type AuthD1Database = {
  prepare(query: string): AuthD1Statement;
  batch(statements: AuthD1Statement[]): Promise<ReadonlyArray<AuthD1BatchResult>>;
  exec(query: string): Promise<{ readonly count: number; readonly duration: number }>;
};

type AuthD1Statement = {
  bind(...values: ReadonlyArray<string | number | null>): AuthD1Statement;
  first(): Promise<AuthD1Row | null>;
  all(): Promise<AuthD1BatchResult>;
  run(): Promise<AuthD1BatchResult>;
};

type AuthD1Row = {
  readonly [column: string]: string | number | null;
};

type AuthD1BatchResult = {
  readonly meta: { readonly changes: number };
};

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

function authMigrationOptions() {
  return makeAuthOptions({ apiHostname: "schema.umail.invalid" }, "schema-migration-operator", {
    rateLimit: true,
  });
}

async function applyAuthSchema(database: AuthD1Database): Promise<void> {
  // Deployment-only: keep migration dependencies out of the Worker startup path.
  const { getMigrations } = await import("better-auth/db/migration");
  const migrations = await getMigrations({
    ...authMigrationOptions(),
    database: database as D1Database,
    secret: AUTH_SCHEMA_SECRET,
    telemetry: { enabled: false },
  });
  await migrations.runMigrations();
  await database.exec(AUTH_CONTROL_TABLE_SQL);
}

export async function provisionAuth(
  database: AuthD1Database,
  request: AuthProvisionInput & { readonly password: string },
): Promise<AuthProvisionResult> {
  if (request.password.length === 0) {
    throw new Error("UMAIL_OPERATOR_PASSWORD is required");
  }
  if (request.password.length < 12) {
    throw new Error("UMAIL_OPERATOR_PASSWORD must be at least 12 characters");
  }
  const canonicalEmail = canonicalOperatorEmail(request.operatorEmail);
  const operatorEmail = betterAuthLookupEmail(canonicalEmail);
  await applyAuthSchema(database);
  const now = new Date().toISOString();
  const control = await readAuthControl(database);
  const operatorId = control?.operatorId ?? crypto.randomUUID();
  const existingAccount = await loadCredentialAccount(database, operatorId);
  const passwordHash = await nextPasswordHash(request.password, existingAccount?.password ?? null);
  const generation = nextGeneration(control, passwordHash.changed);

  await persistOperatorIdentity(database, {
    operatorId,
    operatorEmail,
    canonicalEmail,
    passwordHash: passwordHash.hash,
    passwordChanged: passwordHash.changed,
    generation,
    now,
  });
  await provisionStaticResources(database, request, now);
  await provisionStaticClient(database, request.mcpResource, now);
  await markAuthReady(database, now);

  return { operatorId };
}

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

async function nextPasswordHash(
  password: string,
  existingHash: string | null,
): Promise<{ readonly hash: string; readonly changed: boolean }> {
  if (existingHash !== null && (await verifyPassword({ hash: existingHash, password }))) {
    return { hash: existingHash, changed: false };
  }
  return { hash: await hashPassword(password), changed: true };
}

function nextGeneration(control: AuthControl | null, passwordChanged: boolean): number {
  if (control === null) return 1;
  if (passwordChanged) return control.credentialGeneration + 1;
  return control.credentialGeneration;
}

async function loadCredentialAccount(
  database: AuthD1Database,
  operatorId: string,
): Promise<typeof ExistingAccountRow.Type | null> {
  const row = await database
    .prepare(
      `SELECT id, password, issuer, providerId, accountId, userId
       FROM account
       WHERE userId = ? AND providerId = ?`,
    )
    .bind(operatorId, CREDENTIAL_PROVIDER_ID)
    .first();
  if (row === null) return null;
  const decoded = Schema.decodeUnknownResult(ExistingAccountRow)(row);
  if (Result.isFailure(decoded)) {
    throw new Error("credential account row does not match Better Auth 1.7.2 mapping");
  }
  return decoded.success;
}

async function persistOperatorIdentity(
  database: AuthD1Database,
  input: {
    readonly operatorId: string;
    readonly operatorEmail: ExternalMailAddress;
    readonly canonicalEmail: ExternalMailAddress;
    readonly passwordHash: string;
    readonly passwordChanged: boolean;
    readonly generation: number;
    readonly now: string;
  },
): Promise<void> {
  const user = await database
    .prepare(`SELECT id FROM user WHERE id = ?`)
    .bind(input.operatorId)
    .first();
  const account = await loadCredentialAccount(database, input.operatorId);
  const statements: AuthD1Statement[] = [];

  if (user === null) {
    statements.push(
      database
        .prepare(
          `INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .bind(input.operatorId, "operator", input.operatorEmail, 1, input.now, input.now),
    );
  } else {
    statements.push(
      database
        .prepare(
          `UPDATE user SET email = ?, name = ?, emailVerified = ?, updatedAt = ? WHERE id = ?`,
        )
        .bind(input.operatorEmail, "operator", 1, input.now, input.operatorId),
    );
  }

  if (account === null) {
    statements.push(
      database
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
  } else if (
    account.issuer !== CREDENTIAL_ISSUER ||
    account.accountId !== input.operatorId ||
    account.userId !== input.operatorId ||
    input.passwordChanged
  ) {
    statements.push(
      database
        .prepare(
          `UPDATE account
           SET issuer = ?, accountId = ?, userId = ?, providerId = ?, password = ?, updatedAt = ?
           WHERE id = ?`,
        )
        .bind(
          CREDENTIAL_ISSUER,
          input.operatorId,
          input.operatorId,
          CREDENTIAL_PROVIDER_ID,
          input.passwordHash,
          input.now,
          account.id,
        ),
    );
  }

  if (input.passwordChanged && account !== null) {
    statements.push(
      database.prepare(`DELETE FROM session WHERE userId = ?`).bind(input.operatorId),
      database.prepare(`DELETE FROM oauthRefreshToken WHERE userId = ?`).bind(input.operatorId),
      database.prepare(`DELETE FROM oauthAccessToken WHERE userId = ?`).bind(input.operatorId),
      database.prepare(`DELETE FROM oauthConsent WHERE userId = ?`).bind(input.operatorId),
      database.prepare(`DELETE FROM verification`).bind(),
      database.prepare(`DELETE FROM deviceCode`).bind(),
    );
  }

  const existingControl = await readAuthControl(database);
  if (existingControl === null) {
    statements.push(
      database
        .prepare(
          `INSERT INTO ${AUTH_CONTROL_TABLE} (
             id, operatorId, canonicalEmail, credentialGeneration, ready, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          AUTH_CONTROL_ROW_ID,
          input.operatorId,
          input.canonicalEmail,
          input.generation,
          input.now,
          input.now,
        ),
    );
  } else {
    statements.push(
      database
        .prepare(
          `UPDATE ${AUTH_CONTROL_TABLE}
           SET operatorId = ?, canonicalEmail = ?, credentialGeneration = ?, updatedAt = ?
           WHERE id = ?`,
        )
        .bind(
          input.operatorId,
          input.canonicalEmail,
          input.generation,
          input.now,
          AUTH_CONTROL_ROW_ID,
        ),
    );
  }

  if (statements.length > 0) {
    await database.batch(statements);
  }
}

async function provisionStaticResources(
  database: AuthD1Database,
  request: AuthProvisionInput,
  now: string,
): Promise<void> {
  const scopes = jsonText([UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE]);
  await upsertOwnedResource(database, {
    identifier: request.restResource,
    name: "AgentMail REST",
    allowedScopes: scopes,
    now,
  });
  await upsertOwnedResource(database, {
    identifier: request.mcpResource,
    name: "AgentMail MCP",
    allowedScopes: scopes,
    now,
  });
}

async function upsertOwnedResource(
  database: AuthD1Database,
  input: {
    readonly identifier: string;
    readonly name: string;
    readonly allowedScopes: string;
    readonly now: string;
  },
): Promise<void> {
  const existing = await database
    .prepare(`SELECT identifier FROM oauthResource WHERE identifier = ?`)
    .bind(input.identifier)
    .first();
  if (existing === null) {
    await database
      .prepare(
        `INSERT INTO oauthResource (
           id, identifier, name, accessTokenTtl, refreshTokenTtl, signingAlgorithm, signingKeyId,
           allowedScopes, customClaims, dpopBoundAccessTokensRequired, disabled, policyVersion,
           metadata, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
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
  await database
    .prepare(
      `UPDATE oauthResource
       SET name = ?, accessTokenTtl = ?, allowedScopes = ?, updatedAt = ?
       WHERE identifier = ?`,
    )
    .bind(input.name, 300, input.allowedScopes, input.now, input.identifier)
    .run();
}

async function provisionStaticClient(
  database: AuthD1Database,
  mcpResource: string,
  now: string,
): Promise<void> {
  const client = cursorGrokBotClient();
  const existing = await database
    .prepare(`SELECT clientId, clientDiscoveryId FROM oauthClient WHERE clientId = ?`)
    .bind(client.clientId)
    .first();
  if (existing === null) {
    await database
      .prepare(
        `INSERT INTO oauthClient (
           id, clientId, clientDiscoveryId, name, tokenEndpointAuthMethod, grantTypes, responseTypes,
           redirectUris, scopes, requirePKCE, disabled, metadata, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        CURSOR_GROK_BOT_CLIENT_ID,
        client.clientId,
        FIRST_PARTY_CLIENT_DISCOVERY_ID,
        client.name ?? "Cursor / Grok Bot",
        "none",
        jsonText(["authorization_code", "refresh_token"]),
        jsonText(["code"]),
        jsonText([CURSOR_CLOUD_CALLBACK_URI]),
        jsonText([UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE]),
        1,
        0,
        FIRST_PARTY_CLIENT_METADATA_JSON,
        now,
        now,
      )
      .run();
  } else {
    const decoded = Schema.decodeUnknownResult(ExistingClientRow)(existing);
    if (Result.isFailure(decoded)) {
      throw new Error("oauthClient row for the static client is not usable");
    }
    if (decoded.success.clientDiscoveryId !== FIRST_PARTY_CLIENT_DISCOVERY_ID) {
      throw new Error(
        `oauthClient ${CURSOR_GROK_BOT_CLIENT_ID} is owned by ${decoded.success.clientDiscoveryId ?? "another registrant"}`,
      );
    }
    await database
      .prepare(
        `UPDATE oauthClient
         SET name = ?, tokenEndpointAuthMethod = ?, grantTypes = ?, responseTypes = ?,
             redirectUris = ?, scopes = ?, requirePKCE = ?, metadata = ?, updatedAt = ?
         WHERE clientId = ?`,
      )
      .bind(
        client.name ?? "Cursor / Grok Bot",
        "none",
        jsonText(["authorization_code", "refresh_token"]),
        jsonText(["code"]),
        jsonText([CURSOR_CLOUD_CALLBACK_URI]),
        jsonText([UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE]),
        1,
        FIRST_PARTY_CLIENT_METADATA_JSON,
        now,
        client.clientId,
      )
      .run();
  }

  const link = await database
    .prepare(`SELECT clientId FROM oauthClientResource WHERE clientId = ? AND resourceId = ?`)
    .bind(client.clientId, mcpResource)
    .first();
  if (link === null) {
    await database
      .prepare(
        `INSERT INTO oauthClientResource (id, clientId, resourceId, metadata, createdAt)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), client.clientId, mcpResource, now)
      .run();
  }
}

async function markAuthReady(database: AuthD1Database, now: string): Promise<void> {
  await database
    .prepare(`UPDATE ${AUTH_CONTROL_TABLE} SET ready = 1, updatedAt = ? WHERE id = ?`)
    .bind(now, AUTH_CONTROL_ROW_ID)
    .run();
}

function jsonText(values: ReadonlyArray<string>): string {
  return JSON.stringify(values);
}
