import { env } from "cloudflare:test";
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
