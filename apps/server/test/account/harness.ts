import {
  ApprovalTokenHash,
  requireApprovalSendMode,
  type PrincipalPolicy,
  type PrincipalSendMode,
} from "@umail/api-contract";
import { env, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
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
) {
  return Effect.promise(() =>
    runInDurableObject(store, (host: AccountStoreTestHost) =>
      Promise.resolve()
        .then(() => call(host))
        .then(
          () => undefined,
          (cause: unknown) => cause,
        ),
    ),
  );
}

let approvalSequence = 0;

// Every submit carries approval material; the store keeps it only when the job needs approval.
// Account specs decide by hash, so a unique fixed hash stands in for a real token's.
export function approvalMaterial(expiresAt: string) {
  approvalSequence += 1;
  return {
    approvalId: `approval-${approvalSequence}`,
    tokenHash: Schema.decodeSync(ApprovalTokenHash)(
      approvalSequence.toString(16).padStart(64, "0"),
    ),
    expiresAt,
  };
}

// A client policy for specs; the store takes the requester's policy as an argument.
export function testPolicy(
  sendMode: PrincipalSendMode = requireApprovalSendMode(),
  overrides: Partial<PrincipalPolicy> = {},
): PrincipalPolicy {
  return {
    mailboxIds: "all",
    canRead: true,
    sendMode,
    recipientAllowlist: "any",
    ...overrides,
  };
}
