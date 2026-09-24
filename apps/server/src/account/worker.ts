import { OPERATOR_POLICY, constructMailboxAddress, type MailDomain } from "@umail/api-contract";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { createMailHtmlPolicy } from "../mail/html-policy.ts";
import { makeAccess, type AccessDatabase } from "../auth/access.ts";
import { cloudflareEmailSender } from "../mail/email-sender.ts";
import { notificationKeyFromSecret } from "../mail/notifications.ts";
import { AuthDb, MailIndex } from "../resources.ts";
import { currentSite, operatorEmail } from "../site.ts";
import {
  createAddress,
  getAddress,
  getAddressByMailbox,
  listAddresses,
  listSendingIdentities,
  patchAddress,
  resolveSendingIdentity,
  setAddressForwarding,
} from "./administration.ts";
import {
  applyAccountSchema,
  acceptInbound,
  failInboundReceiptPolicy,
  getInboundReceipt,
  observeInboundForward,
  registerInboundReceipt,
} from "./commands.ts";
import type { OutboundRequester } from "./domain.ts";
import { armDueWork, runDueWork, type AccountStorage } from "./due-work.ts";
import { isExpectedStoreFailure, type AccountStoreError } from "./errors.ts";
import {
  decideApproval,
  getOutboundJob,
  listOutboundJobs,
  lookupApprovalByTokenHash,
  submitOutbound,
} from "./jobs.ts";
import {
  getMessageBody,
  getMessageSource,
  getMessageSummary,
  getStoredAttachment,
  listMessageSummaries,
  listThreadMessageSummaries,
  listThreadSummaries,
  markThreadRead,
  softDeleteThread,
} from "./queries.ts";

// Expected domain errors stay typed failures; anything else is a defect, logged here inside the DO.
const runStore = <A>(run: () => A): Effect.Effect<A, AccountStoreError> =>
  Effect.try(run).pipe(
    Effect.catch(({ cause }) =>
      isExpectedStoreFailure(cause) ? Effect.fail(cause) : Effect.die(cause),
    ),
    Effect.tapDefect((defect) => Effect.logError("AccountStore call failed", defect)),
  );

export function makeAccountStoreRpc(storage: AccountStorage) {
  const call =
    <Args extends ReadonlyArray<unknown>, A>(fn: (storage: AccountStorage, ...args: Args) => A) =>
    (...args: Args) =>
      runStore(() => fn(storage, ...args));
  // Calls that can create due work arm the alarm for it.
  const callAndArm =
    <Args extends ReadonlyArray<unknown>, A>(fn: (storage: AccountStorage, ...args: Args) => A) =>
    (...args: Args) =>
      call(fn)(...args).pipe(
        Effect.tap(() =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.promise(() => armDueWork(storage, now)),
          ),
        ),
      );
  return {
    acceptInbound: call(acceptInbound),
    registerInboundReceipt: callAndArm(registerInboundReceipt),
    observeInboundForward: call(observeInboundForward),
    getInboundReceipt: call(getInboundReceipt),
    failInboundReceiptPolicy: call(failInboundReceiptPolicy),
    listMessageSummaries: call(listMessageSummaries),
    listThreadSummaries: call(listThreadSummaries),
    listThreadMessageSummaries: call(listThreadMessageSummaries),
    getMessageSummary: call(getMessageSummary),
    getMessageBody: call(getMessageBody),
    getStoredAttachment: call(getStoredAttachment),
    getMessageSource: call(getMessageSource),
    markThreadRead: call(markThreadRead),
    softDeleteThread: call(softDeleteThread),
    listAddresses: call(listAddresses),
    getAddress: call(getAddress),
    getAddressByMailbox: call(getAddressByMailbox),
    createAddress: call(createAddress),
    patchAddress: call(patchAddress),
    listSendingIdentities: call(listSendingIdentities),
    resolveSendingIdentity: call(resolveSendingIdentity),
    setAddressForwarding: call(setAddressForwarding),
    submitOutbound: callAndArm(submitOutbound),
    lookupApprovalByTokenHash: call(lookupApprovalByTokenHash),
    decideApproval: callAndArm(decideApproval),
    getOutboundJob: call(getOutboundJob),
    listOutboundJobs: call(listOutboundJobs),
  };
}

export type AccountStoreRpc = ReturnType<typeof makeAccountStoreRpc>;

export class AccountStore extends Cloudflare.DurableObject<AccountStore, AccountStoreRpc>()(
  "AccountStore",
) {}

// Single-operator service: the Worker addresses the one mailbox by this fixed name.
export const OPERATOR_ACCOUNT = "operator";

export const AccountStoreLive = AccountStore.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const site = yield* currentSite;
    const email = yield* Cloudflare.Email.Send(Cloudflare.Email.SendEmail("EMAIL"));
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    const authDb = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    const notificationSecret = yield* Config.redacted("UMAIL_NOTIFICATION_KEY");
    const approvalAdminEmail = yield* operatorEmail;
    const htmlPolicy = createMailHtmlPolicy();
    return Effect.gen(function* () {
      const storage = state.raw.storage;
      const now = yield* DateTime.now;
      applyAccountSchema(storage, DateTime.formatIso(now));
      const rpc = makeAccountStoreRpc(storage);
      if (site.kind === "preview") {
        yield* seedDevelopmentAddresses(rpc, {
          mailDomain: site.mailDomain,
          localParts: site.testLocalParts,
          nowIso: DateTime.formatIso(now),
        }).pipe(Effect.orDie);
      }
      // Read at runtime: the provisioned operator id is only in the deployed Worker's env.
      const operatorId = yield* Config.string("AUTH_OPERATOR_ID").pipe(Effect.orDie);
      const access = makeAccess((yield* authDb.raw) as AccessDatabase, operatorId);
      const ports = {
        sender: yield* cloudflareEmailSender(email),
        index,
        htmlPolicy,
        applicationUrl: new URL(`https://${site.apiHostname}`),
        notification: {
          key: notificationKeyFromSecret(Redacted.value(notificationSecret)),
          mailDomain: site.mailDomain,
          approvalAdminEmail,
        },
        policyFor: (requester: OutboundRequester) =>
          requester.kind === "operator"
            ? Effect.succeed(OPERATOR_POLICY)
            : access.mcpPolicy(requester.clientId),
      };
      // Covers due work whose alarm was never set, e.g. after a deploy.
      yield* Effect.promise(() => armDueWork(storage, DateTime.toEpochMillis(now)));
      return {
        ...rpc,
        alarm: () =>
          Effect.flatMap(Clock.currentTimeMillis, (nowMs) => runDueWork(storage, ports, nowMs)),
      };
    });
  }).pipe(
    Effect.orDie,
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Email.SendBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.D1.QueryDatabaseBinding,
      ),
    ),
  ),
);

export default AccountStoreLive;

export function seedDevelopmentAddresses(
  store: Pick<AccountStoreRpc, "createAddress">,
  input: {
    readonly mailDomain: MailDomain;
    readonly localParts: ReadonlyArray<string>;
    readonly nowIso: string;
  },
): Effect.Effect<{ readonly seeded: number }, AccountStoreError> {
  return Effect.gen(function* () {
    let seeded = 0;
    for (const localPart of input.localParts) {
      const normalized = constructMailboxAddress(localPart, input.mailDomain);
      if (normalized.kind !== "ok") {
        return yield* Effect.die(
          new Error(
            `SeedAddresses: mailbox address ${localPart}@${input.mailDomain} is ${normalized.kind}`,
          ),
        );
      }
      const created = yield* store
        .createAddress(normalized.localPart, input.mailDomain, undefined, input.nowIso)
        .pipe(Effect.catchTag("AccountConflictError", () => Effect.succeed(null)));
      if (created !== null) seeded += 1;
    }
    return { seeded };
  });
}
