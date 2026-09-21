/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, SELF, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Exercise the generated bridge and its real SQLite storage.
const testEnv = env as {
  AccountStore: DurableObjectNamespace;
  AuthDb: D1Database;
};

describe("generated application runtime", () => {
  it("boots the production API bundle without operator password or deployment credentials", async () => {
    expect("UMAIL_OPERATOR_PASSWORD" in env).toBe(false);
    expect("CLOUDFLARE_API_TOKEN" in env).toBe(false);
    const response = await SELF.fetch("https://dev.umail.example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in");
    const tables = await testEnv.AuthDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all();
    expect(tables.results).not.toContainEqual(expect.objectContaining({ name: "user" }));
  });

  it("initializes the real AccountStore schema and seeds preview mailboxes once across eviction", async () => {
    const stub = testEnv.AccountStore.getByName("operator-test");
    // Enter the real object after its constructor completes; the pool cannot proxy dynamic RPC methods.
    const addresses = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT address FROM addresses ORDER BY address").toArray(),
      );
    expect(await addresses()).toEqual([
      { address: "inbox@dev-mail.umail.example.com" },
      { address: "probe@dev-mail.umail.example.com" },
    ]);
    const before = await runInDurableObject(stub, (_instance, state) => ({
      migrations: state.storage.sql.exec("SELECT version, name FROM schema_migrations").toArray(),
      tables: state.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .toArray(),
    }));
    expect(before.migrations).toEqual([{ version: 9, name: "0009_account" }]);
    expect(before.tables).toContainEqual({ name: "inbound_receipts" });
    expect(before.tables).toContainEqual({ name: "outbound_jobs" });
    expect(before.tables).toContainEqual({ name: "approval_notifications" });
    await evictDurableObject(stub);
    expect(await addresses()).toEqual([
      { address: "inbox@dev-mail.umail.example.com" },
      { address: "probe@dev-mail.umail.example.com" },
    ]);
  });
});
