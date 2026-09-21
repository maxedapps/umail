/// <reference types="@cloudflare/vitest-plugin/types" />

import { toRpcAsync } from "alchemy/Cloudflare/Bridge";
import { describe, expect, it } from "vitest";

import { accountStore, taggedName } from "./harness.ts";

describe("account-store command transactions", () => {
  it("rolls back a failed command so no partial rows remain", async () => {
    const store = accountStore("account-tx-conflict");
    await store.recordItemGroup({
      groupId: "kept",
      items: [{ id: "item-a", label: "first" }],
    });
    let failure: unknown;
    try {
      await store.recordItemGroup({
        groupId: "partial",
        items: [
          { id: "item-b", label: "should-roll-back" },
          { id: "item-a", label: "duplicate" },
        ],
      });
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("CommandConflictError");
    expect(await store.listItemsByIds(["item-a", "item-b"])).toEqual([
      { id: "item-a", groupId: "kept", label: "first" },
    ]);
  });

  it("lists 100 and 101 ids with a single json_each bind", async () => {
    const store = accountStore("account-tx-json");
    const hundred = idsFor(100);
    const hundredAndOne = idsFor(101);
    await store.recordItemGroup({
      groupId: "json-100",
      items: hundred.map((id) => ({ id, label: id })),
    });
    await store.recordItemGroup({
      groupId: "json-101-extra",
      items: [{ id: "item-101", label: "item-101" }],
    });
    expect(await store.listItemsByIds(hundred)).toHaveLength(100);
    expect(await store.listItemsByIds(hundredAndOne)).toHaveLength(101);
  });

  it("unwraps tagged RPC error envelopes instead of treating them as success", async () => {
    const stub = {
      recordItemGroup: () =>
        Promise.resolve({
          _tag: "~alchemy/rpc/error",
          error: {
            _tag: "CommandConflictError",
            groupId: "partial",
            id: "item-a",
          },
        }),
    };
    const rpc = toRpcAsync<typeof stub>(stub);
    let failure: unknown;
    try {
      await rpc.recordItemGroup();
    } catch (cause) {
      failure = cause;
    }
    expect(failure).not.toEqual(
      expect.objectContaining({
        _tag: "~alchemy/rpc/error",
      }),
    );
    expect(taggedName(failure)).toBe("CommandConflictError");
  });
});

function idsFor(count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    ids.push(`item-${String(index)}`);
  }
  return ids;
}
