/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
  it.effect("applies versioned migrations before serving commands", () =>
    Effect.gen(function* () {
      const store = accountStore("account-schema-activate");
      expect(yield* Effect.promise(() => store.listTables())).toEqual(ACCOUNT_TABLES);
      expect(yield* Effect.promise(() => store.listMigrations())).toEqual(ACCOUNT_MIGRATIONS);
      const messageColumns = yield* Effect.promise(() => store.listMessageColumns());
      expect(messageColumns).toContain("parsed_date");
      expect(messageColumns).toContain("thread_id");
      expect(messageColumns).not.toContain("node_id");
    }),
  );

  it.effect("rolls back failed schema work", () =>
    Effect.gen(function* () {
      const store = accountStore("account-schema-rollback");
      yield* Effect.promise(() => store.listMigrations());
      const failure = yield* failureOf(store, (host) => host.applyFailingMigration());
      expect(taggedName(failure)).toBe("SchemaMigrationError");
      expect(yield* Effect.promise(() => store.listTables())).toEqual(ACCOUNT_TABLES);
      expect(yield* Effect.promise(() => store.listMigrations())).toEqual(ACCOUNT_MIGRATIONS);
    }),
  );

  it.effect("rejects a newer schema rather than partially initializing", () =>
    Effect.gen(function* () {
      const store = accountStore("account-schema-newer");
      yield* Effect.promise(() => store.installUnsupportedSchema(999));
      yield* Effect.promise(() => evictDurableObject(store));
      const failure = yield* failureOf(store, (host) => host.listMigrations());
      expect(taggedName(failure)).toBe("SchemaIncompatibleError");
    }),
  );

  it.effect("rejects a stale pre-squash schema without modifying it", () =>
    Effect.gen(function* () {
      const store = accountStore("account-schema-old");
      yield* Effect.promise(() => store.installOldSchema());
      const before = yield* Effect.promise(() => store.inspectUninitializedSchema());
      yield* Effect.promise(() => evictDurableObject(store));
      const failure = yield* failureOf(store, (host) => host.listMigrations());
      expect(taggedName(failure)).toBe("SchemaIncompatibleError");
      expect(yield* Effect.promise(() => store.inspectUninitializedSchema())).toEqual(before);
    }),
  );

  it.effect("retains committed schema state after restart", () =>
    Effect.gen(function* () {
      const store = accountStore("account-schema-restart");
      const created = yield* Effect.promise(() =>
        store.createAddress("kept", requireMailDomain(), "Kept", "2026-01-01T00:00:00.000Z"),
      );
      yield* Effect.promise(() => evictDurableObject(store));
      expect(yield* Effect.promise(() => store.listMigrations())).toEqual(ACCOUNT_MIGRATIONS);
      expect(created).not.toBeNull();
      expect(yield* Effect.promise(() => store.getAddress(created?.id ?? ""))).toEqual(created);
    }),
  );
});

function requireMailDomain(): MailDomain {
  const parsed = parseMailDomain("umail.example.com");
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}
