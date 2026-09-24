import { betterAuth } from "better-auth";
import { verifyPassword } from "better-auth/crypto";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { MemoryD1 } from "../api/memory-d1.ts";
import {
  CURSOR_GROK_BOT_CLIENT_ID,
  FIRST_PARTY_CLIENT_DISCOVERY_ID,
  asUmailBetterAuth,
  makeAuthOptions,
  mcpResourceUrl,
  restResourceUrl,
} from "../../src/auth/options.ts";
import { AuthProvision, provisionAuth, type AuthD1Database } from "../../src/auth/provisioning.ts";
import { ExternalMailAddress } from "@umail/api-contract";
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, TEST_SITE } from "../api/world.ts";

const REST_RESOURCE = restResourceUrl(TEST_SITE);
const MCP_RESOURCE = mcpResourceUrl(TEST_SITE);
const AUTH_SECRET = "umail-test-better-auth-secret";

describe("auth provisioning", () => {
  it.each(["x", "12345678901"])(
    "rejects a password shorter than 12 characters before modifying auth storage",
    async (password) => {
      const db = emptyAuthDatabase();
      await expect(
        provisionAuth(db, { ...provisionRequest("short-password"), password }),
      ).rejects.toThrow("UMAIL_OPERATOR_PASSWORD must be at least 12 characters");
      expect(await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    },
  );

  it("accepts a 12-character password without requiring character classes", async () => {
    const db = emptyAuthDatabase();
    const password = "abcdefghijkl";
    await provisionAuth(db, { ...provisionRequest("minimum-password"), password });
    expect(await verifyPassword({ hash: await credentialHash(db), password })).toBe(true);
  });

  it("preserves the existing operator credentials when a weak replacement is rejected", async () => {
    const db = await provisionedDatabase();
    const hash = await credentialHash(db);
    const control = await db.all("SELECT ready, credentialGeneration FROM umailAuthControl");
    await expect(
      provisionAuth(db, { ...provisionRequest("weak-replacement"), password: "short" }),
    ).rejects.toThrow("UMAIL_OPERATOR_PASSWORD must be at least 12 characters");
    expect(await credentialHash(db)).toBe(hash);
    expect(await db.all("SELECT ready, credentialGeneration FROM umailAuthControl")).toEqual(
      control,
    );
  });

  it("provisions schema, operator, and static clients on an empty database", async () => {
    const db = await provisionedDatabase();
    const operator = await db.all("SELECT id, email FROM user");
    expect(operator).toEqual([{ id: expect.any(String), email: OPERATOR_EMAIL }]);
    expect(await db.all("SELECT issuer, providerId, accountId, userId FROM account")).toEqual([
      {
        issuer: "local:credential",
        providerId: "credential",
        accountId: operator[0]?.id,
        userId: operator[0]?.id,
      },
    ]);
    expect(
      await db.all("SELECT identifier, disabled FROM oauthResource ORDER BY identifier"),
    ).toEqual([
      { identifier: REST_RESOURCE, disabled: 0 },
      { identifier: MCP_RESOURCE, disabled: 0 },
    ]);
    expect(
      await db.all(
        "SELECT clientId, clientDiscoveryId, disabled FROM oauthClient WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ).toEqual([
      {
        clientId: CURSOR_GROK_BOT_CLIENT_ID,
        clientDiscoveryId: FIRST_PARTY_CLIENT_DISCOVERY_ID,
        disabled: 0,
      },
    ]);
    expect(
      await db.all(
        "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ).toEqual([{ resourceId: MCP_RESOURCE }]);
    expect(await db.all("SELECT ready, credentialGeneration FROM umailAuthControl")).toEqual([
      { ready: 1, credentialGeneration: 1 },
    ]);
  });

  it("reuses the generated operator id on repeated applies", async () => {
    const db = emptyAuthDatabase();
    const first = await provisionAuth(db, provisionRequest("nonce-1"));
    const second = await provisionAuth(db, provisionRequest("nonce-2"));
    expect(second.operatorId).toBe(first.operatorId);
    expect(second.generation).toBe(1);
    expect(second.schemaRevision).toBe(first.schemaRevision);
    expect(first.schemaRevision.length).toBeGreaterThan(0);
    expect(await db.all("SELECT schemaRevision FROM umailAuthControl")).toEqual([
      { schemaRevision: first.schemaRevision },
    ]);
    expect(await db.all("SELECT id FROM user")).toEqual([{ id: first.operatorId }]);
  });

  it("retries after schema creation fails without creating operator authority", async () => {
    class InterruptedSchemaD1 extends MemoryD1 {
      interrupted = false;
      override async exec(query: string) {
        if (!this.interrupted && query.includes("umailAuthControl")) {
          this.interrupted = true;
          throw new Error("schema interrupted");
        }
        return super.exec(query);
      }
    }
    const db = new InterruptedSchemaD1() as InterruptedSchemaD1 & AuthD1Database;
    await expect(provisionAuth(db, provisionRequest("schema-failed"))).rejects.toThrow(
      "schema interrupted",
    );
    expect(await db.all("SELECT id FROM user")).toEqual([]);
    const result = await provisionAuth(db, provisionRequest("schema-retry"));
    expect(await db.all("SELECT id FROM user")).toEqual([{ id: result.operatorId }]);
    expect(await db.all("SELECT ready FROM umailAuthControl")).toEqual([{ ready: 1 }]);
  });

  it("leaves first provisioning unready on a partial failure and resumes with the same identity", async () => {
    class InterruptedClientD1 extends MemoryD1 {
      interruptClient = true;
      override async exec(query: string) {
        const result = await super.exec(query);
        if (this.interruptClient && query.includes("CREATE TABLE IF NOT EXISTS umailAuthControl")) {
          await super.exec(`CREATE TRIGGER IF NOT EXISTS interrupt_client
            BEFORE INSERT ON oauthClient BEGIN SELECT RAISE(FAIL, 'client interrupted'); END`);
        }
        return result;
      }
    }
    const db = new InterruptedClientD1() as InterruptedClientD1 & AuthD1Database;
    await expect(provisionAuth(db, provisionRequest("client-failed"))).rejects.toThrow(
      "client interrupted",
    );
    const operatorId = await operatorIdOf(db);
    const hash = await credentialHash(db);
    expect(await db.all("SELECT ready FROM umailAuthControl")).toEqual([{ ready: 0 }]);
    expect(await db.all("SELECT clientId FROM oauthClient")).toEqual([]);
    await db.exec("DROP TRIGGER interrupt_client");
    db.interruptClient = false;
    const result = await provisionAuth(db, provisionRequest("client-retry"));
    expect(result.operatorId).toBe(operatorId);
    expect(result.generation).toBe(1);
    expect(await credentialHash(db)).toBe(hash);
    expect(await db.all("SELECT ready FROM umailAuthControl")).toEqual([{ ready: 1 }]);
    expect(await db.all("SELECT resourceId FROM oauthClientResource")).toEqual([
      { resourceId: MCP_RESOURCE },
    ]);
  });

  it("does not rewrite credentials when only the provisioning nonce changes", async () => {
    const db = emptyAuthDatabase();
    const first = await provisionAuth(db, provisionRequest("nonce-a"));
    const hashBefore = await credentialHash(db);
    await db
      .prepare(
        `INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "session-1",
        first.operatorId,
        "token-1",
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const second = await provisionAuth(db, provisionRequest("nonce-b"));
    expect(second.operatorId).toBe(first.operatorId);
    expect(second.generation).toBe(1);
    expect(await credentialHash(db)).toBe(hashBefore);
    expect(await db.all("SELECT id FROM session")).toEqual([{ id: "session-1" }]);
  });

  it("rotates the password hash and invalidates grants on a real password change", async () => {
    const db = emptyAuthDatabase();
    const first = await provisionAuth(db, provisionRequest("rotate-1"));
    await db
      .prepare(
        `INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "session-1",
        first.operatorId,
        "token-1",
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    await db
      .prepare(
        `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "consent-1",
        CURSOR_GROK_BOT_CLIENT_ID,
        first.operatorId,
        "[]",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    const oldHash = await credentialHash(db);
    const rotated = await provisionAuth(db, {
      ...provisionRequest("rotate-2"),
      password: "replacement-passphrase",
    });
    expect(rotated.generation).toBe(2);
    const newHash = await credentialHash(db);
    expect(newHash).not.toBe(oldHash);
    expect(await verifyPassword({ hash: oldHash, password: OPERATOR_PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: newHash, password: "replacement-passphrase" })).toBe(true);
    expect(await db.all("SELECT id FROM session")).toEqual([]);
    expect(await db.all("SELECT id FROM oauthConsent")).toEqual([]);
  });

  it("signs in through Better Auth using the credential issuer mapping", async () => {
    const db = await provisionedDatabase();
    const auth = asUmailBetterAuth(
      betterAuth({
        ...makeAuthOptions(TEST_SITE, await operatorIdOf(db), { rateLimit: false }),
        database: db,
        secret: AUTH_SECRET,
      }),
    );
    const response = await auth.handler(
      new Request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session");
  });

  it("signs in a mixed-case operator email through Better Auth using the credential issuer mapping", async () => {
    const mixedCaseEmail = Schema.decodeSync(ExternalMailAddress)("Admin@example.com");
    const lookupEmail = Schema.decodeSync(ExternalMailAddress)("admin@example.com");
    const db = emptyAuthDatabase();
    await provisionAuth(db, { ...provisionRequest("mixed-case"), operatorEmail: mixedCaseEmail });
    expect(await db.all("SELECT email FROM user")).toEqual([{ email: lookupEmail }]);
    expect(await db.all("SELECT canonicalEmail FROM umailAuthControl")).toEqual([
      { canonicalEmail: mixedCaseEmail },
    ]);
    const auth = asUmailBetterAuth(
      betterAuth({
        ...makeAuthOptions(TEST_SITE, await operatorIdOf(db), { rateLimit: false }),
        database: db,
        secret: AUTH_SECRET,
      }),
    );
    const response = await auth.handler(
      new Request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: mixedCaseEmail, password: OPERATOR_PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session");
  });

  it("repairs a missing static resource link without recreating the client", async () => {
    const db = await provisionedDatabase();
    await db.prepare("DELETE FROM oauthClientResource").run();
    const clientId = await db.all(
      "SELECT id FROM oauthClient WHERE clientId = ?",
      CURSOR_GROK_BOT_CLIENT_ID,
    );
    await provisionAuth(db, provisionRequest("repair"));
    expect(
      await db.all("SELECT id FROM oauthClient WHERE clientId = ?", CURSOR_GROK_BOT_CLIENT_ID),
    ).toEqual(clientId);
    expect(
      await db.all(
        "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ).toEqual([{ resourceId: MCP_RESOURCE }]);
  });

  it("preserves disabled resources across provision and insert-only cold start", async () => {
    const db = await provisionedDatabase();
    await db
      .prepare("UPDATE oauthResource SET disabled = 1 WHERE identifier = ?")
      .bind(MCP_RESOURCE)
      .run();
    await provisionAuth(db, provisionRequest("disabled-resource"));
    expect(
      await db.all("SELECT disabled FROM oauthResource WHERE identifier = ?", MCP_RESOURCE),
    ).toEqual([{ disabled: 1 }]);
    const auth = asUmailBetterAuth(
      betterAuth({
        ...makeAuthOptions(TEST_SITE, await operatorIdOf(db), { rateLimit: false }),
        database: db,
        secret: AUTH_SECRET,
      }),
    );
    await auth.$context;
    expect(
      await db.all("SELECT disabled FROM oauthResource WHERE identifier = ?", MCP_RESOURCE),
    ).toEqual([{ disabled: 1 }]);
  });

  it("preserves a disabled static client and does not touch mcp_oauth_policies", async () => {
    const db = await provisionedDatabase();
    await db
      .prepare("UPDATE oauthClient SET disabled = 1 WHERE clientId = ?")
      .bind(CURSOR_GROK_BOT_CLIENT_ID)
      .run();
    db.applyMigration(
      `CREATE TABLE IF NOT EXISTS mcp_oauth_policies (
         client_id TEXT PRIMARY KEY NOT NULL,
         state TEXT NOT NULL
       )`,
    );
    await db
      .prepare(`INSERT INTO mcp_oauth_policies (client_id, state) VALUES (?, ?)`)
      .bind(CURSOR_GROK_BOT_CLIENT_ID, "revoked")
      .run();
    await provisionAuth(db, provisionRequest("disabled-client"));
    expect(
      await db.all(
        "SELECT disabled FROM oauthClient WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ).toEqual([{ disabled: 1 }]);
    expect(await db.all("SELECT client_id, state FROM mcp_oauth_policies")).toEqual([
      { client_id: CURSOR_GROK_BOT_CLIENT_ID, state: "revoked" },
    ]);
  });

  it("rejects an ownership conflict for the static client id", async () => {
    const db = await provisionedDatabase();
    await db
      .prepare("UPDATE oauthClient SET clientDiscoveryId = ? WHERE clientId = ?")
      .bind("other-discovery", CURSOR_GROK_BOT_CLIENT_ID)
      .run();
    await expect(provisionAuth(db, provisionRequest("conflict"))).rejects.toThrow(
      `oauthClient ${CURSOR_GROK_BOT_CLIENT_ID} is owned by other-discovery`,
    );
  });

  it("keeps Action inputs and outputs free of passwords and hashes", async () => {
    const db = emptyAuthDatabase();
    const input: Omit<Parameters<typeof provisionAuth>[1], "password"> = {
      identity: { databaseId: "test-auth" },
      runNonce: "fresh-nonce",
      operatorEmail: OPERATOR_EMAIL,
      restResource: REST_RESOURCE,
      mcpResource: MCP_RESOURCE,
    };
    const serializedInput = JSON.stringify(input);
    expect(serializedInput).not.toContain(OPERATOR_PASSWORD);
    expect(serializedInput).not.toMatch(/password/i);
    const result = await provisionAuth(db, { ...input, password: OPERATOR_PASSWORD });
    const hash = await credentialHash(db);
    const serializedOutput = JSON.stringify(result);
    expect(serializedOutput).not.toContain(OPERATOR_PASSWORD);
    expect(serializedOutput).not.toContain(hash);
    expect(serializedOutput).not.toMatch(/password/i);
    expect(AuthProvision.Type).toBe("AuthProvision");
  });
});

async function provisionedDatabase(): Promise<MemoryD1 & AuthD1Database> {
  const db = emptyAuthDatabase();
  await provisionAuth(db, provisionRequest("initial"));
  return db;
}

function emptyAuthDatabase(): MemoryD1 & AuthD1Database {
  return new MemoryD1() as MemoryD1 & AuthD1Database;
}

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

async function operatorIdOf(db: AuthD1Database): Promise<string> {
  const row = await db.prepare("SELECT id FROM user").first();
  if (row === null || row.id === null) {
    throw new Error("provisioned operator id is missing");
  }
  return String(row.id);
}

async function credentialHash(db: AuthD1Database): Promise<string> {
  const row = await db
    .prepare("SELECT password FROM account WHERE providerId = ?")
    .bind("credential")
    .first();
  if (row === null || row.password === null) {
    throw new Error("credential hash is missing");
  }
  return String(row.password);
}
