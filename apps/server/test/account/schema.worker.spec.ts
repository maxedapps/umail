/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountStore, failureOf, taggedName } from "./harness.ts";

const ACCOUNT_TABLES = [
  "addresses",
  "approval_requests",
  "attachments",
  "inbound_receipts",
  "message_participants",
  "message_references",
  "messages",
  "outbound_jobs",
  "schema_migrations",
] as const;

const ACCOUNT_MIGRATIONS = [{ version: 10, name: "0010_account" }] as const;

describe("account-store schema activation", () => {
  it("applies versioned migrations before serving commands", async () => {
    const store = accountStore("account-schema-activate");
    expect(await store.listTables()).toEqual(ACCOUNT_TABLES);
    expect(await store.listMigrations()).toEqual(ACCOUNT_MIGRATIONS);
    const messageColumns = await store.listMessageColumns();
    expect(messageColumns).toContain("parsed_date");
    expect(messageColumns).toContain("thread_id");
    expect(messageColumns).not.toContain("node_id");
  });

  it("rolls back failed schema work", async () => {
    const store = accountStore("account-schema-rollback");
    await store.listMigrations();
    const failure = await failureOf(store, (host) => host.applyFailingMigration());
    expect(taggedName(failure)).toBe("SchemaMigrationError");
    expect(await store.listTables()).toEqual(ACCOUNT_TABLES);
    expect(await store.listMigrations()).toEqual(ACCOUNT_MIGRATIONS);
  });

  it("rejects a newer schema rather than partially initializing", async () => {
    const store = accountStore("account-schema-newer");
    await store.installUnsupportedSchema(999);
    await evictDurableObject(store);
    const failure = await failureOf(store, (host) => host.listMigrations());
    expect(taggedName(failure)).toBe("SchemaIncompatibleError");
  });

  it("rejects a stale pre-squash schema without modifying it", async () => {
    const store = accountStore("account-schema-old");
    await store.installOldSchema();
    const before = await store.inspectUninitializedSchema();
    await evictDurableObject(store);
    const failure = await failureOf(store, (host) => host.listMigrations());
    expect(taggedName(failure)).toBe("SchemaIncompatibleError");
    expect(await store.inspectUninitializedSchema()).toEqual(before);
  });

  it("retains committed schema state after restart", async () => {
    const store = accountStore("account-schema-restart");
    const created = await store.createAddress(
      "kept",
      requireMailDomain(),
      "Kept",
      "2026-01-01T00:00:00.000Z",
    );
    await evictDurableObject(store);
    expect(await store.listMigrations()).toEqual(ACCOUNT_MIGRATIONS);
    expect(created).not.toBeNull();
    expect(await store.getAddress(created?.id ?? "")).toEqual(created);
  });
});

function requireMailDomain(): MailDomain {
  const parsed = parseMailDomain("umail.example.com");
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}
