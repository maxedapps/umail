import { ExternalMailAddress } from "@umail/api-contract";
import { expect, layer } from "@effect/vitest";
import { betterAuth } from "better-auth";
import { verifyPassword } from "better-auth/crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { MemoryD1, memoryQueryDatabase } from "../api/memory-d1.ts";
import {
  CURSOR_GROK_BOT_CLIENT_ID,
  FIRST_PARTY_CLIENT_DISCOVERY_ID,
  UMAIL_CLI_CLIENT_ID,
  asUmailBetterAuth,
  makeAuthOptions,
  mcpResourceUrl,
  restResourceUrl,
} from "../../src/auth/options.ts";
import { provisionAuth } from "../../src/auth/provisioning.ts";
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, TEST_SITE, WorkerServices } from "../api/world.ts";

const REST_RESOURCE = restResourceUrl(TEST_SITE);
const MCP_RESOURCE = mcpResourceUrl(TEST_SITE);
const AUTH_SECRET = "umail-test-better-auth-secret";
const SESSION_TIME = "2026-01-01T00:00:00.000Z";

layer(WorkerServices)("auth provisioning", (it) => {
  it.effect.each(["x", "12345678901"])(
    "rejects a password shorter than 12 characters before modifying auth storage",
    (password) =>
      Effect.gen(function* () {
        const db = new MemoryD1();
        yield* expectDefect(
          provision(db, { ...provisionRequest("short-password"), password }),
          "UMAIL_OPERATOR_PASSWORD must be at least 12 characters",
        );
        expect(yield* query(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
      }),
  );

  it.effect("accepts a 12-character password without requiring character classes", () =>
    Effect.gen(function* () {
      const db = new MemoryD1();
      const password = "abcdefghijkl";
      yield* provision(db, { ...provisionRequest("minimum-password"), password });
      const hash = yield* credentialHash(db);
      expect(yield* Effect.promise(() => verifyPassword({ hash, password }))).toBe(true);
    }),
  );

  it.effect("preserves the existing operator credentials when a weak replacement is rejected", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      const hash = yield* credentialHash(db);
      yield* expectDefect(
        provision(db, { ...provisionRequest("weak-replacement"), password: "short" }),
        "UMAIL_OPERATOR_PASSWORD must be at least 12 characters",
      );
      expect(yield* credentialHash(db)).toBe(hash);
    }),
  );

  it.effect("provisions schema, operator, and static clients on an empty database", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      const operator = yield* query(db, "SELECT id, email FROM user");
      expect(operator).toEqual([{ id: expect.any(String), email: OPERATOR_EMAIL }]);
      expect(yield* query(db, "SELECT issuer, providerId, accountId, userId FROM account")).toEqual(
        [
          {
            issuer: "local:credential",
            providerId: "credential",
            accountId: operator[0]?.id,
            userId: operator[0]?.id,
          },
        ],
      );
      expect(
        yield* query(db, "SELECT identifier, disabled FROM oauthResource ORDER BY identifier"),
      ).toEqual([
        { identifier: REST_RESOURCE, disabled: 0 },
        { identifier: MCP_RESOURCE, disabled: 0 },
      ]);
      expect(
        yield* query(
          db,
          "SELECT clientId, clientDiscoveryId, disabled, grantTypes FROM oauthClient ORDER BY clientId",
        ),
      ).toEqual([
        {
          clientId: CURSOR_GROK_BOT_CLIENT_ID,
          clientDiscoveryId: FIRST_PARTY_CLIENT_DISCOVERY_ID,
          disabled: 0,
          grantTypes: '["authorization_code","refresh_token"]',
        },
        {
          clientId: UMAIL_CLI_CLIENT_ID,
          clientDiscoveryId: FIRST_PARTY_CLIENT_DISCOVERY_ID,
          disabled: 0,
          grantTypes: '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]',
        },
      ]);
      expect(yield* staticClientLinks(db)).toEqual([
        { clientId: CURSOR_GROK_BOT_CLIENT_ID, resourceId: MCP_RESOURCE },
        { clientId: UMAIL_CLI_CLIENT_ID, resourceId: REST_RESOURCE },
      ]);
      expect(yield* query(db, "SELECT name FROM sqlite_master WHERE name = 'mcpPolicy'")).toEqual([
        { name: "mcpPolicy" },
      ]);
    }),
  );

  it.effect("reuses the generated operator id on repeated applies", () =>
    Effect.gen(function* () {
      const db = new MemoryD1();
      const first = yield* provision(db, provisionRequest("nonce-1"));
      const second = yield* provision(db, provisionRequest("nonce-2"));
      expect(second).toEqual({ operatorId: first.operatorId });
      expect(yield* query(db, "SELECT id FROM user")).toEqual([{ id: first.operatorId }]);
    }),
  );

  it.effect("resumes a partly failed first provisioning with the same operator", () =>
    Effect.gen(function* () {
      class InterruptedClientD1 extends MemoryD1 {
        interruptClient = true;
        override batch(statements: Parameters<MemoryD1["batch"]>[0]) {
          return super.batch(statements).then((result) =>
            this.interruptClient
              ? super
                  .exec(
                    `CREATE TRIGGER IF NOT EXISTS interrupt_client
                     BEFORE INSERT ON oauthClient BEGIN SELECT RAISE(FAIL, 'client interrupted'); END`,
                  )
                  .then(() => result)
              : result,
          );
        }
      }
      const db = new InterruptedClientD1();
      yield* expectDefect(provision(db, provisionRequest("client-failed")), "client interrupted");
      const operatorId = yield* operatorIdOf(db);
      const hash = yield* credentialHash(db);
      expect(yield* query(db, "SELECT clientId FROM oauthClient")).toEqual([]);
      yield* Effect.promise(() => db.exec("DROP TRIGGER interrupt_client"));
      db.interruptClient = false;
      const result = yield* provision(db, provisionRequest("client-retry"));
      expect(result.operatorId).toBe(operatorId);
      expect(yield* credentialHash(db)).toBe(hash);
      expect(yield* staticClientLinks(db)).toHaveLength(2);
    }),
  );

  it.effect("does not rewrite credentials when only the provisioning nonce changes", () =>
    Effect.gen(function* () {
      const db = new MemoryD1();
      const first = yield* provision(db, provisionRequest("nonce-a"));
      const hashBefore = yield* credentialHash(db);
      yield* insertSession(db, first.operatorId);
      const second = yield* provision(db, provisionRequest("nonce-b"));
      expect(second.operatorId).toBe(first.operatorId);
      expect(yield* credentialHash(db)).toBe(hashBefore);
      expect(yield* query(db, "SELECT id FROM session")).toEqual([{ id: "session-1" }]);
    }),
  );

  it.effect(
    "rotates the password hash and ends sessions, grants, and their policies on a real change",
    () =>
      Effect.gen(function* () {
        const db = new MemoryD1();
        const first = yield* provision(db, provisionRequest("rotate-1"));
        yield* insertSession(db, first.operatorId);
        yield* execute(
          db,
          `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
          "consent-1",
          CURSOR_GROK_BOT_CLIENT_ID,
          first.operatorId,
          "[]",
          SESSION_TIME,
          SESSION_TIME,
        );
        yield* execute(
          db,
          `INSERT INTO mcpPolicy (id, consentId, policy) VALUES (?, ?, ?)`,
          "policy-1",
          "consent-1",
          "{}",
        );
        const oldHash = yield* credentialHash(db);
        yield* provision(db, {
          ...provisionRequest("rotate-2"),
          password: "replacement-passphrase",
        });
        const newHash = yield* credentialHash(db);
        expect(newHash).not.toBe(oldHash);
        expect(
          yield* Effect.promise(() =>
            verifyPassword({ hash: oldHash, password: OPERATOR_PASSWORD }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            verifyPassword({ hash: newHash, password: "replacement-passphrase" }),
          ),
        ).toBe(true);
        expect(yield* query(db, "SELECT id FROM session")).toEqual([]);
        expect(yield* query(db, "SELECT id FROM oauthConsent")).toEqual([]);
        expect(yield* query(db, "SELECT id FROM mcpPolicy")).toEqual([]);
      }),
  );

  it.effect("signs in through Better Auth using the credential issuer mapping", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      const response = yield* signIn(db, OPERATOR_EMAIL);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("session");
    }),
  );

  it.effect(
    "signs in a mixed-case operator email through Better Auth using the credential issuer mapping",
    () =>
      Effect.gen(function* () {
        const mixedCaseEmail = Schema.decodeSync(ExternalMailAddress)("Admin@example.com");
        const lookupEmail = Schema.decodeSync(ExternalMailAddress)("admin@example.com");
        const db = new MemoryD1();
        yield* provision(db, { ...provisionRequest("mixed-case"), operatorEmail: mixedCaseEmail });
        expect(yield* query(db, "SELECT email FROM user")).toEqual([{ email: lookupEmail }]);
        const response = yield* signIn(db, mixedCaseEmail);
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toContain("session");
      }),
  );

  it.effect("repairs missing static resource links without recreating the clients", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      const links = yield* staticClientLinks(db);
      yield* execute(db, "DELETE FROM oauthClientResource");
      const clients = yield* query(db, "SELECT id FROM oauthClient ORDER BY id");
      yield* provision(db, provisionRequest("repair"));
      expect(yield* query(db, "SELECT id FROM oauthClient ORDER BY id")).toEqual(clients);
      expect(yield* staticClientLinks(db)).toEqual(links);
    }),
  );

  it.effect("preserves disabled resources across provision and insert-only cold start", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      yield* execute(
        db,
        "UPDATE oauthResource SET disabled = 1 WHERE identifier = ?",
        MCP_RESOURCE,
      );
      yield* provision(db, provisionRequest("disabled-resource"));
      const disabled = "SELECT disabled FROM oauthResource WHERE identifier = ?";
      expect(yield* query(db, disabled, MCP_RESOURCE)).toEqual([{ disabled: 1 }]);
      const auth = yield* betterAuthFor(db);
      yield* Effect.promise(() => auth.$context);
      expect(yield* query(db, disabled, MCP_RESOURCE)).toEqual([{ disabled: 1 }]);
    }),
  );

  it.effect("preserves a disabled static client", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      yield* execute(
        db,
        "UPDATE oauthClient SET disabled = 1 WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      );
      yield* provision(db, provisionRequest("disabled-client"));
      expect(
        yield* query(
          db,
          "SELECT disabled FROM oauthClient WHERE clientId = ?",
          CURSOR_GROK_BOT_CLIENT_ID,
        ),
      ).toEqual([{ disabled: 1 }]);
    }),
  );

  it.effect("rejects an ownership conflict for the static client id", () =>
    Effect.gen(function* () {
      const db = yield* provisionedDatabase;
      yield* execute(
        db,
        "UPDATE oauthClient SET clientDiscoveryId = ? WHERE clientId = ?",
        "other-discovery",
        CURSOR_GROK_BOT_CLIENT_ID,
      );
      yield* expectDefect(
        provision(db, provisionRequest("conflict")),
        `oauthClient ${CURSOR_GROK_BOT_CLIENT_ID} is owned by other-discovery`,
      );
    }),
  );
});

function provision(db: MemoryD1, request: Parameters<typeof provisionAuth>[1]) {
  return provisionAuth(memoryQueryDatabase(db), request);
}

const provisionedDatabase = Effect.gen(function* () {
  const db = new MemoryD1();
  yield* provision(db, provisionRequest("initial"));
  return db;
});

function provisionRequest(runNonce: string): Parameters<typeof provisionAuth>[1] {
  return {
    identity: { databaseId: "test-auth" },
    runNonce,
    operatorEmail: OPERATOR_EMAIL,
    restResource: REST_RESOURCE,
    mcpResource: MCP_RESOURCE,
    password: OPERATOR_PASSWORD,
  };
}

function expectDefect<A, E, R>(effect: Effect.Effect<A, E, R>, message: string) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "succeeded").toContain(
      message,
    );
  });
}

function query(db: MemoryD1, sql: string, ...params: ReadonlyArray<string | number | null>) {
  return Effect.promise(() => db.all(sql, ...params));
}

function execute(db: MemoryD1, sql: string, ...params: ReadonlyArray<string | number | null>) {
  return Effect.promise(() =>
    db
      .prepare(sql)
      .bind(...params)
      .run(),
  );
}

function insertSession(db: MemoryD1, operatorId: string) {
  return execute(
    db,
    `INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    "session-1",
    operatorId,
    "token-1",
    "2026-01-01T00:01:00.000Z",
    SESSION_TIME,
    SESSION_TIME,
  );
}

function staticClientLinks(db: MemoryD1) {
  return query(db, "SELECT clientId, resourceId FROM oauthClientResource ORDER BY clientId");
}

function operatorIdOf(db: MemoryD1) {
  return Effect.map(query(db, "SELECT id FROM user"), (rows) => String(rows[0]?.id));
}

function credentialHash(db: MemoryD1) {
  return Effect.map(
    query(db, "SELECT password FROM account WHERE providerId = ?", "credential"),
    (rows) => String(rows[0]?.password),
  );
}

function betterAuthFor(db: MemoryD1) {
  return Effect.map(operatorIdOf(db), (operatorId) =>
    asUmailBetterAuth(
      betterAuth({
        ...makeAuthOptions(TEST_SITE, operatorId, { rateLimit: false }),
        database: db,
        secret: AUTH_SECRET,
      }),
    ),
  );
}

function signIn(db: MemoryD1, email: string) {
  return Effect.flatMap(betterAuthFor(db), (auth) =>
    Effect.promise(() =>
      auth.handler(
        new Request("http://umail.test/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: OPERATOR_PASSWORD }),
        }),
      ),
    ),
  );
}
