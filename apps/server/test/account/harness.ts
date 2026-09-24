import { ApprovalTokenHash } from "@umail/api-contract";
import { env, runInDurableObject } from "cloudflare:test";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { AccountStoreTestHost } from "./worker-host.ts";

export const ACCOUNT_ID = "account-test";

type AccountStoreTestEnv = {
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as AccountStoreTestEnv;

const TaggedFailure = Schema.Struct({
  _tag: Schema.String,
});

export function accountStore(name = ACCOUNT_ID): DurableObjectStub<AccountStoreTestHost> {
  return testEnv.ACCOUNT_STORE.getByName(name);
}

export function taggedName(cause: unknown): string | undefined {
  const decoded = Schema.decodeUnknownResult(TaggedFailure)(cause);
  if (Result.isFailure(decoded)) return undefined;
  return decoded.success._tag;
}

// Runs the call inside the DO and returns what it threw, so the failure never crosses RPC as an
// uncaught rejection.
export function failureOf(
  store: DurableObjectStub<AccountStoreTestHost>,
  call: (host: AccountStoreTestHost) => unknown,
): Promise<unknown> {
  return runInDurableObject(store, async (host: AccountStoreTestHost) => {
    try {
      await call(host);
    } catch (cause) {
      return cause;
    }
    return undefined;
  });
}

// Every submit carries approval material; the store keeps it only when the job needs approval.
// Account specs decide by hash, so a random hash stands in for a real token's.
export function approvalMaterial(expiresAt: string) {
  return {
    approvalId: crypto.randomUUID(),
    tokenHash: Schema.decodeSync(ApprovalTokenHash)(
      Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(32))),
    ),
    expiresAt,
  };
}
