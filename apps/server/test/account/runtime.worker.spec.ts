/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountStore } from "./harness.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("account-store SQLite Durable Object runtime", () => {
  it("persists and reads a named object across eviction", async () => {
    const store = accountStore();
    const created = await store.createAddress("runtime", requireMailDomain(), "Runtime", NOW);
    await evictDurableObject(store);
    expect(await store.listMigrations()).toEqual([{ version: 10, name: "0010_account" }]);
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
