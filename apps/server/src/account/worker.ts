import { isExpectedStoreFailure, type AccountStoreError } from "./errors.ts";
import {
  applyAccountSchema,
  acceptInbound,
  failInboundReceiptPolicy,
  getInboundReceipt,
  observeInboundForward,
  redriveDueInboundReceipts,
  registerInboundReceipt,
} from "./commands.ts";
import {
  claimDispatch,
  completeAttempt,
  getOutboundDispatch,
  decideApproval,
  getOutboundJob,
  listOutboundJobs,
  lookupApprovalByTokenHash,
  recoverOutbound,
  rejectReadyDispatch,
  submitOutbound,
} from "./jobs.ts";
import {
  createAddress,
  deleteDestination,
  ensureMcpOAuthPolicy,
  getAddress,
  getAddressByMailbox,
  getDestination,
  getMcpOAuthPolicy,
  insertDestination,
  listAddresses,
  listDestinations,
  listMcpOAuthPolicies,
  listSendingIdentities,
  patchAddress,
  resolveSendingIdentity,
  revokeMcpOAuthPolicy,
  setAddressForwarding,
  setMcpOAuthPolicyState,
  updateDestinationStatus,
  updateMcpOAuthPolicy,
} from "./administration.ts";
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
import { type AccountSqliteStorage } from "./sqlite.ts";
import { constructMailboxAddress, parseMailDomain, type MailDomain } from "@umail/api-contract";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// Expected domain errors stay typed failures; anything else is a defect, logged here inside the DO.
const runStore = <A>(run: () => A): Effect.Effect<A, AccountStoreError> =>
  Effect.try(run).pipe(
    Effect.catch(({ cause }) =>
      isExpectedStoreFailure(cause) ? Effect.fail(cause) : Effect.die(cause),
    ),
    Effect.tapDefect((defect) => Effect.logError("AccountStore call failed", defect)),
  );

export function makeAccountStoreRpc(storage: AccountSqliteStorage) {
  const call =
    <Args extends ReadonlyArray<unknown>, A>(
      fn: (storage: AccountSqliteStorage, ...args: Args) => A,
    ) =>
    (...args: Args) =>
      runStore(() => fn(storage, ...args));
  return {
    acceptInbound: call(acceptInbound),
    registerInboundReceipt: call(registerInboundReceipt),
    observeInboundForward: call(observeInboundForward),
    getInboundReceipt: call(getInboundReceipt),
    failInboundReceiptPolicy: call(failInboundReceiptPolicy),
    redriveDueInboundReceipts: call(redriveDueInboundReceipts),
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
    listDestinations: call(listDestinations),
    getDestination: call(getDestination),
    insertDestination: call(insertDestination),
    setAddressForwarding: call(setAddressForwarding),
    updateDestinationStatus: call(updateDestinationStatus),
    deleteDestination: call(deleteDestination),
    getMcpOAuthPolicy: call(getMcpOAuthPolicy),
    listMcpOAuthPolicies: call(listMcpOAuthPolicies),
    ensureMcpOAuthPolicy: call(ensureMcpOAuthPolicy),
    updateMcpOAuthPolicy: call(updateMcpOAuthPolicy),
    setMcpOAuthPolicyState: call(setMcpOAuthPolicyState),
    revokeMcpOAuthPolicy: call(revokeMcpOAuthPolicy),
    submitOutbound: call(submitOutbound),
    lookupApprovalByTokenHash: call(lookupApprovalByTokenHash),
    decideApproval: call(decideApproval),
    claimDispatch: call(claimDispatch),
    completeAttempt: call(completeAttempt),
    rejectReadyDispatch: call(rejectReadyDispatch),
    getOutboundDispatch: call(getOutboundDispatch),
    getOutboundJob: call(getOutboundJob),
    listOutboundJobs: call(listOutboundJobs),
    recoverOutbound: call(recoverOutbound),
  };
}

export type AccountStoreRpc = ReturnType<typeof makeAccountStoreRpc>;

export class AccountStore extends Cloudflare.DurableObject<AccountStore, AccountStoreRpc>()(
  "AccountStore",
) {}

// Single-operator service: every Worker addresses the one mailbox by this fixed name.
export const OPERATOR_ACCOUNT = "operator";

export const AccountStoreLive = AccountStore.make<never>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const storage = state.raw.storage;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      applyAccountSchema(storage, nowIso);
      const rpc = makeAccountStoreRpc(storage);
      const previewMailboxes = yield* Config.string("UMAIL_PREVIEW_MAILBOXES").pipe(
        Config.withDefault(""),
        Effect.orDie,
      );
      if (previewMailboxes === "") {
        return rpc;
      }
      const mailDomainRaw = yield* Config.string("UMAIL_MAIL_DOMAIN").pipe(Effect.orDie);
      const parsed = parseMailDomain(mailDomainRaw);
      if (parsed.kind !== "ok") {
        return yield* Effect.die(new Error("UMAIL_MAIL_DOMAIN is not a valid mail domain."));
      }
      yield* seedDevelopmentAddresses(rpc, {
        mailDomain: parsed.domain,
        localParts: previewMailboxes.split(","),
        nowIso,
      }).pipe(Effect.orDie);
      return rpc;
    });
  }),
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
