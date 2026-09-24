import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { AccountConflictError, isExpectedStoreFailure } from "../../src/account/errors.ts";
import { createMemoryAccount } from "../api/memory-account-store.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("account-store RPC boundary", () => {
  it("fails with a typed AccountConflictError for a duplicate address", () => {
    const { account } = createMemoryAccount();
    const domain = requireMailDomain();
    Effect.runSync(account.createAddress("inbox", domain, undefined, NOW));

    const exit = Effect.runSyncExit(account.createAddress("inbox", domain, undefined, NOW));

    expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(
      Option.some("AccountConflictError"),
    );
  });

  it("recognizes expected failures as class instances and as plain RPC envelopes", () => {
    expect(isExpectedStoreFailure(new AccountConflictError({ resource: "address", id: "a" }))).toBe(
      true,
    );
    expect(isExpectedStoreFailure({ _tag: "AccountConflictError", resource: "address" })).toBe(
      true,
    );
    expect(isExpectedStoreFailure({ _tag: "RpcCallError" })).toBe(false);
    expect(isExpectedStoreFailure(new Error("boom"))).toBe(false);
  });

  it("dies and logs the defect when the storage itself fails", () => {
    const { storage, account } = createMemoryAccount();
    storage.close();
    const errors: Array<unknown> = [];
    const capture = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message);
    });

    const exit = Effect.runSyncExit(
      account.listAddresses().pipe(Effect.provide(Logger.layer([capture]))),
    );

    expect(Exit.hasDies(exit)).toBe(true);
    expect(Exit.hasFails(exit)).toBe(false);
    expect(errors).toEqual([expect.arrayContaining(["AccountStore call failed"])]);
  });
});

function requireMailDomain(): MailDomain {
  const parsed = parseMailDomain("umail.example.com");
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}
