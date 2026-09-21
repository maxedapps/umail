/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountStore } from "./harness.ts";

describe("account-store SQLite Durable Object runtime", () => {
  it("persists and reads a named object across eviction", async () => {
    const store = accountStore();
    await store.recordItemGroup({
      groupId: "runtime-group",
      items: [{ id: "runtime-item", label: "across-eviction" }],
    });
    await evictDurableObject(store);
    const status = await store.schemaStatus();
    expect(status).toEqual({
      schemaVersion: 9,
      accountId: "account-test",
    });
    expect(await store.listItemsByIds(["runtime-item"])).toEqual([
      { id: "runtime-item", groupId: "runtime-group", label: "across-eviction" },
    ]);
  });
});
