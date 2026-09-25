/// <reference types="@cloudflare/vitest-plugin/types" />
import {
  env,
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Exercise the generated bridge and its real SQLite storage.
const DUE_AT = "2030-01-01T00:00:00.000Z";
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
    // OPERATOR_ACCOUNT; importing account/worker.ts here would pull deployment code into workerd.
    const stub = testEnv.AccountStore.getByName("operator");
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
    expect(before.migrations).toEqual([{ version: 10, name: "0010_account" }]);
    expect(before.tables).toContainEqual({ name: "inbound_receipts" });
    expect(before.tables).toContainEqual({ name: "outbound_jobs" });
    expect(before.tables).toContainEqual({ name: "approval_requests" });
    await evictDurableObject(stub);
    expect(await addresses()).toEqual([
      { address: "inbox@dev-mail.umail.example.com" },
      { address: "probe@dev-mail.umail.example.com" },
    ]);
  });

  it("arms the store's alarm on start for the due work it finds", async () => {
    const stub = testEnv.AccountStore.getByName("operator");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO inbound_receipts (id, envelope_from, envelope_to, raw_key, received_at, retry_after)
         VALUES ('stuck', 'sender@example.com', 'inbox@dev-mail.umail.example.com', 'raw/stuck', ?, ?)`,
        DUE_AT,
        DUE_AT,
      );
      return state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      Date.parse(DUE_AT),
    );
  });

  it("sends an approval notification with the bound NotificationKey from the store's alarm", async () => {
    const stub = testEnv.AccountStore.getByName("operator");
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const mailbox = sql.exec("SELECT id FROM addresses ORDER BY address LIMIT 1").one().id;
      sql.exec(
        `INSERT INTO messages (id, thread_id, mailbox_id, direction, occurred_at, created_at, updated_at, subject)
         VALUES ('held', 'held', ?, 'outbound', ?, ?, ?, 'Held')`,
        mailbox,
        now,
        now,
        now,
      );
      for (const [id, purpose, jobState] of [
        ["held-job", "message", "waiting_approval"],
        ["held-notice", "approval_notification", "ready"],
      ]) {
        sql.exec(
          `INSERT INTO outbound_jobs (id, requester_kind, requester_client_id, requester_label,
             idempotency_key, intent_fingerprint, message_id, mailbox_id, purpose, state, created_at,
             updated_at)
           VALUES (?, 'operator', 'cli', 'CLI', ?, '', 'held', ?, ?, ?, ?, ?)`,
          id,
          id,
          mailbox,
          purpose,
          jobState,
          now,
          now,
        );
      }
      sql.exec(
        `INSERT INTO approval_requests (id, job_id, notification_job_id, token_hash, state,
           requester_client_id, requester_label, created_at, expires_at)
         VALUES ('held-approval', 'held-job', 'held-notice', ?, 'pending', 'cli', 'CLI', ?, ?)`,
        "0".repeat(64),
        now,
        expires,
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const notice = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT state FROM outbound_jobs WHERE id = 'held-notice'").one(),
    );
    // Deriving the link reads the key; a missing or malformed binding would leave the job ready.
    expect(notice.state).not.toBe("ready");
    expect(notice).toEqual({ state: "accepted" });
  });
});
