/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountStore, taggedName } from "./harness.ts";

const ACCOUNT_TABLES = [
  "account_meta",
  "addresses",
  "approval_notifications",
  "approval_requests",
  "attachments",
  "command_items",
  "forwarding_destinations",
  "inbound_receipts",
  "mcp_oauth_policies",
  "message_participants",
  "message_references",
  "messages",
  "outbound_jobs",
  "recovery_scans",
  "rfc_lookups",
  "schema_migrations",
  "thread_component_links",
  "thread_nodes",
  "thread_parent_edges",
  "threading_diagnostics",
] as const;

const ACCOUNT_MIGRATIONS = [{ version: 9, name: "0009_account" }] as const;

describe("account-store schema activation", () => {
  it("applies versioned migrations before serving commands", async () => {
    const store = accountStore("account-schema-activate");
    const status = await store.schemaStatus();
    expect(status).toEqual({
      schemaVersion: 9,
      accountId: "account-schema-activate",
    });
    expect(await store.listTables()).toEqual(ACCOUNT_TABLES);
    expect(await store.listMigrations()).toEqual(ACCOUNT_MIGRATIONS);
    expect(await store.listMessageColumns()).toContain("parsed_date");
  });

  it("rolls back failed schema work", async () => {
    const store = accountStore("account-schema-rollback");
    await store.schemaStatus();
    let failure: unknown;
    try {
      await store.applyFailingMigration();
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("SchemaMigrationError");
    expect(await store.listTables()).toEqual(ACCOUNT_TABLES);
    expect(await store.listMigrations()).toEqual(ACCOUNT_MIGRATIONS);
  });

  it("rejects a different account identity without changing the stored identity", async () => {
    const store = accountStore("account-schema-identity");
    await store.schemaStatus();
    let failure: unknown;
    try {
      await store.applySchemaForAccount("different-account");
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("AccountIdentityError");
    expect(await store.schemaStatus()).toEqual({
      schemaVersion: 9,
      accountId: "account-schema-identity",
    });
  });

  it("rejects a newer schema rather than partially initializing", async () => {
    const store = accountStore("account-schema-newer");
    await store.schemaStatus();
    await store.installUnsupportedSchema(999);
    await evictDurableObject(store);
    let failure: unknown;
    try {
      await store.schemaStatus();
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("SchemaIncompatibleError");
  });

  it("rejects an old development schema without modifying it", async () => {
    const store = accountStore("account-schema-old");
    await store.installOldSchema();
    const before = await store.inspectUninitializedSchema();
    await evictDurableObject(store);
    let failure: unknown;
    try {
      await store.schemaStatus();
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("SchemaIncompatibleError");
    expect(await store.inspectUninitializedSchema()).toEqual(before);
  });

  it("retains committed schema state after restart", async () => {
    const store = accountStore("account-schema-restart");
    await store.recordItemGroup({
      groupId: "schema-group",
      items: [{ id: "schema-item", label: "kept" }],
    });
    await evictDurableObject(store);
    expect(await store.schemaStatus()).toEqual({
      schemaVersion: 9,
      accountId: "account-schema-restart",
    });
    expect(await store.listItemsByIds(["schema-item"])).toEqual([
      { id: "schema-item", groupId: "schema-group", label: "kept" },
    ]);
  });
});
