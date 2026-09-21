import {
  AcceptInboundInput,
  ClaimDispatchInput,
  ClaimInboundReceiptInput,
  CompleteAttemptInput,
  DecideApprovalInput,
  EnsureMcpOAuthPolicyInput,
  ExpireApprovalInput,
  FailInboundReceiptPolicyInput,
  ListInboundReceiptWorkInput,
  ListDueApprovalsInput,
  ListPurgeableNotificationsInput,
  ListSendWorkInput,
  JobViewer,
  ListMessageSummariesQuery,
  ListOutboundJobsQuery,
  ListThreadMessageSummariesQuery,
  ListThreadSummariesQuery,
  MailboxScope,
  ObserveInboundForwardInput,
  PatchAddressInput,
  PutRecoveryScanInput,
  RecordInboundReceiptRedriveInput,
  RegisterInboundReceiptInput,
  SetMcpOAuthPolicyStateInput,
  SettleExpiredInFlightInput,
  PurgeNotificationCiphertextInput,
  RejectReadyDispatchInput,
  SubmitOutboundInput,
  UpdateMcpOAuthPolicyInput,
  type AcceptMessageResult,
  type AccountAddress,
  type AccountDestination,
  type AccountSendingIdentity,
  type ApprovalConvergenceResult,
  type ApprovalDecisionResult,
  type ApprovalLookupResult,
  type ClaimDispatchResult,
  type ClaimInboundReceiptResult,
  type CompleteAttemptResult,
  type ListDueApprovalsPage,
  type ListPurgeableNotificationsPage,
  type ListSendWorkPage,
  type OutboundDispatch,
  type PurgeNotificationCiphertextResult,
  type RejectReadyDispatchResult,
  type InboundReceipt,
  type ListInboundReceiptWorkPage,
  type McpOAuthPolicy,
  type MessageBody,
  type MessageSummary,
  type MessageSummaryPage,
  type OutboundJob,
  type OutboundJobPage,
  type RecoveryScan,
  type RegisterInboundReceiptResult,
  type StoredAttachment,
  type StoredMessageSource,
  type SubmitOutboundResult,
  type ThreadMessageSummaryPage,
  type ThreadSummaryPage,
} from "./domain.ts";
import { AccountIdentityError, toAccountStoreError, type AccountStoreError } from "./errors.ts";
import {
  applyAccountSchema,
  acceptInbound,
  claimInboundReceipt,
  completeInboundReceipt,
  failInboundReceiptPolicy,
  getInboundReceipt,
  getRecoveryScan,
  listInboundReceiptWork,
  observeInboundForward,
  putRecoveryScan,
  recordInboundReceiptRedrive,
  registerInboundReceipt,
} from "./commands.ts";
import {
  claimDispatch,
  completeAttempt,
  getOutboundDispatch,
  decideApproval,
  expirePendingApproval,
  getOutboundJob,
  listDuePendingApprovals,
  listOutboundJobs,
  listPurgeableNotifications,
  listSendWork,
  lookupApprovalByTokenHash,
  purgeNotificationCiphertext,
  rejectReadyDispatch,
  settleExpiredInFlight,
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
import { ApprovalTokenHash, MailDomain, parseMailDomain, constructMailboxAddress } from "@umail/api-contract";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";


export type AccountStoreRpc = {
  readonly acceptInbound: (
    input: AcceptInboundInput,
  ) => Effect.Effect<AcceptMessageResult, AccountStoreError>;
  readonly registerInboundReceipt: (
    input: RegisterInboundReceiptInput,
  ) => Effect.Effect<RegisterInboundReceiptResult, AccountStoreError>;
  readonly observeInboundForward: (
    input: ObserveInboundForwardInput,
  ) => Effect.Effect<InboundReceipt, AccountStoreError>;
  readonly getInboundReceipt: (
    receiptId: string,
  ) => Effect.Effect<InboundReceipt | null, AccountStoreError>;
  readonly failInboundReceiptPolicy: (
    input: FailInboundReceiptPolicyInput,
  ) => Effect.Effect<InboundReceipt, AccountStoreError>;
  readonly claimInboundReceipt: (
    input: ClaimInboundReceiptInput,
  ) => Effect.Effect<ClaimInboundReceiptResult, AccountStoreError>;
  readonly completeInboundReceipt: (
    receiptId: string,
  ) => Effect.Effect<InboundReceipt, AccountStoreError>;
  readonly recordInboundReceiptRedrive: (
    input: RecordInboundReceiptRedriveInput,
  ) => Effect.Effect<InboundReceipt, AccountStoreError>;
  readonly listInboundReceiptWork: (
    input: ListInboundReceiptWorkInput,
  ) => Effect.Effect<ListInboundReceiptWorkPage, AccountStoreError>;
  readonly getRecoveryScan: (
    scanId: string,
  ) => Effect.Effect<RecoveryScan | null, AccountStoreError>;
  readonly putRecoveryScan: (
    input: PutRecoveryScanInput,
  ) => Effect.Effect<RecoveryScan, AccountStoreError>;
  readonly listMessageSummaries: (
    input: ListMessageSummariesQuery,
  ) => Effect.Effect<MessageSummaryPage, AccountStoreError>;
  readonly listThreadSummaries: (
    input: ListThreadSummariesQuery,
  ) => Effect.Effect<ThreadSummaryPage, AccountStoreError>;
  readonly listThreadMessageSummaries: (
    handle: string,
    input: ListThreadMessageSummariesQuery,
  ) => Effect.Effect<ThreadMessageSummaryPage, AccountStoreError>;
  readonly getMessageSummary: (
    messageId: string,
    mailboxScope: MailboxScope,
  ) => Effect.Effect<MessageSummary | null, AccountStoreError>;
  readonly getMessageBody: (
    messageId: string,
    mailboxScope: MailboxScope,
  ) => Effect.Effect<MessageBody | null, AccountStoreError>;
  readonly getStoredAttachment: (
    messageId: string,
    attachmentId: string,
    mailboxScope: MailboxScope,
  ) => Effect.Effect<StoredAttachment | null, AccountStoreError>;
  readonly getMessageSource: (
    messageId: string,
    mailboxScope: MailboxScope,
  ) => Effect.Effect<StoredMessageSource | null, AccountStoreError>;
  readonly markThreadRead: (
    handle: string,
    isRead: boolean,
    mailboxScope: MailboxScope,
    nowIso: string,
  ) => Effect.Effect<void, AccountStoreError>;
  readonly softDeleteThread: (
    handle: string,
    mailboxScope: MailboxScope,
    deletedAt: string,
  ) => Effect.Effect<void, AccountStoreError>;
  readonly listAddresses: () => Effect.Effect<ReadonlyArray<AccountAddress>, AccountStoreError>;
  readonly getAddress: (id: string) => Effect.Effect<AccountAddress | null, AccountStoreError>;
  readonly getAddressByMailbox: (
    address: string,
  ) => Effect.Effect<AccountAddress | null, AccountStoreError>;
  readonly createAddress: (
    localPart: string,
    mailDomain: MailDomain,
    displayName: string | undefined,
    nowIso: string,
  ) => Effect.Effect<AccountAddress | null, AccountStoreError>;
  readonly patchAddress: (
    id: string,
    payload: PatchAddressInput,
    nowIso: string,
  ) => Effect.Effect<AccountAddress | null, AccountStoreError>;
  readonly listSendingIdentities: (
    mailDomain: MailDomain,
    mailboxScope: MailboxScope,
  ) => Effect.Effect<ReadonlyArray<AccountSendingIdentity>, AccountStoreError>;
  readonly resolveSendingIdentity: (
    id: string,
    mailDomain: MailDomain,
  ) => Effect.Effect<AccountSendingIdentity | null, AccountStoreError>;
  readonly listDestinations: () => Effect.Effect<
    ReadonlyArray<AccountDestination>,
    AccountStoreError
  >;
  readonly getDestination: (
    id: string,
  ) => Effect.Effect<AccountDestination | null, AccountStoreError>;
  readonly insertDestination: (
    cloudflareId: string,
    email: string,
    verifiedAt: string | null,
    nowIso: string,
  ) => Effect.Effect<AccountDestination, AccountStoreError>;
  readonly setAddressForwarding: (
    addressId: string,
    destinationId: string | null,
    nowIso: string,
  ) => Effect.Effect<AccountAddress | null, AccountStoreError>;
  readonly updateDestinationStatus: (
    id: string,
    verifiedAt: string | null,
    nowIso: string,
  ) => Effect.Effect<AccountDestination | null, AccountStoreError>;
  readonly deleteDestination: (
    id: string,
    nowIso: string,
  ) => Effect.Effect<void, AccountStoreError>;
  readonly getMcpOAuthPolicy: (
    clientId: string,
  ) => Effect.Effect<McpOAuthPolicy | null, AccountStoreError>;
  readonly listMcpOAuthPolicies: () => Effect.Effect<
    ReadonlyArray<McpOAuthPolicy>,
    AccountStoreError
  >;
  readonly ensureMcpOAuthPolicy: (
    input: EnsureMcpOAuthPolicyInput,
  ) => Effect.Effect<McpOAuthPolicy, AccountStoreError>;
  readonly updateMcpOAuthPolicy: (
    input: UpdateMcpOAuthPolicyInput,
  ) => Effect.Effect<McpOAuthPolicy | null, AccountStoreError>;
  readonly setMcpOAuthPolicyState: (
    input: SetMcpOAuthPolicyStateInput,
  ) => Effect.Effect<McpOAuthPolicy | null, AccountStoreError>;
  readonly revokeMcpOAuthPolicy: (
    clientId: string,
    updatedAt: string,
  ) => Effect.Effect<McpOAuthPolicy | null, AccountStoreError>;
  readonly submitOutbound: (
    input: SubmitOutboundInput,
  ) => Effect.Effect<SubmitOutboundResult, AccountStoreError>;
  readonly lookupApprovalByTokenHash: (
    tokenHash: ApprovalTokenHash,
  ) => Effect.Effect<ApprovalLookupResult, AccountStoreError>;
  readonly decideApproval: (
    input: DecideApprovalInput,
  ) => Effect.Effect<ApprovalDecisionResult, AccountStoreError>;
  readonly expirePendingApproval: (
    input: ExpireApprovalInput,
  ) => Effect.Effect<ApprovalConvergenceResult, AccountStoreError>;
  readonly claimDispatch: (
    input: ClaimDispatchInput,
  ) => Effect.Effect<ClaimDispatchResult, AccountStoreError>;
  readonly completeAttempt: (
    input: CompleteAttemptInput,
  ) => Effect.Effect<CompleteAttemptResult, AccountStoreError>;
  readonly settleExpiredInFlight: (
    input: SettleExpiredInFlightInput,
  ) => Effect.Effect<CompleteAttemptResult, AccountStoreError>;
  readonly rejectReadyDispatch: (
    input: RejectReadyDispatchInput,
  ) => Effect.Effect<RejectReadyDispatchResult, AccountStoreError>;
  readonly getOutboundDispatch: (
    jobId: string,
  ) => Effect.Effect<OutboundDispatch | null, AccountStoreError>;
  readonly getOutboundJob: (
    jobId: string,
    viewer: JobViewer,
  ) => Effect.Effect<OutboundJob | null, AccountStoreError>;
  readonly listOutboundJobs: (
    input: ListOutboundJobsQuery,
  ) => Effect.Effect<OutboundJobPage, AccountStoreError>;
  readonly listSendWork: (
    input: ListSendWorkInput,
  ) => Effect.Effect<ListSendWorkPage, AccountStoreError>;
  readonly listDuePendingApprovals: (
    input: ListDueApprovalsInput,
  ) => Effect.Effect<ListDueApprovalsPage, AccountStoreError>;
  readonly listPurgeableNotifications: (
    input: ListPurgeableNotificationsInput,
  ) => Effect.Effect<ListPurgeableNotificationsPage, AccountStoreError>;
  readonly purgeNotificationCiphertext: (
    input: PurgeNotificationCiphertextInput,
  ) => Effect.Effect<PurgeNotificationCiphertextResult, AccountStoreError>;
};

export type ApiAccountStore = Pick<
  AccountStoreRpc,
  | "listMessageSummaries"
  | "listThreadSummaries"
  | "listThreadMessageSummaries"
  | "getMessageSummary"
  | "getMessageBody"
  | "getStoredAttachment"
  | "getMessageSource"
  | "markThreadRead"
  | "softDeleteThread"
  | "listAddresses"
  | "getAddress"
  | "createAddress"
  | "patchAddress"
  | "listSendingIdentities"
  | "resolveSendingIdentity"
  | "listDestinations"
  | "getDestination"
  | "insertDestination"
  | "setAddressForwarding"
  | "updateDestinationStatus"
  | "deleteDestination"
  | "getMcpOAuthPolicy"
  | "listMcpOAuthPolicies"
  | "ensureMcpOAuthPolicy"
  | "updateMcpOAuthPolicy"
  | "setMcpOAuthPolicyState"
  | "revokeMcpOAuthPolicy"
  | "submitOutbound"
  | "lookupApprovalByTokenHash"
  | "decideApproval"
  | "expirePendingApproval"
  | "getOutboundJob"
  | "listOutboundJobs"
>;

export function makeAccountStoreRpc(storage: AccountSqliteStorage): AccountStoreRpc {
  return {
    acceptInbound: (input: AcceptInboundInput) =>
      Effect.try({
        try: () => acceptInbound(storage, Schema.decodeSync(AcceptInboundInput)(input)),
        catch: toAccountStoreError,
      }),
    registerInboundReceipt: (input: RegisterInboundReceiptInput) =>
      Effect.try({
        try: () =>
          registerInboundReceipt(storage, Schema.decodeSync(RegisterInboundReceiptInput)(input)),
        catch: toAccountStoreError,
      }),
    observeInboundForward: (input: ObserveInboundForwardInput) =>
      Effect.try({
        try: () =>
          observeInboundForward(storage, Schema.decodeSync(ObserveInboundForwardInput)(input)),
        catch: toAccountStoreError,
      }),
    getInboundReceipt: (receiptId: string) =>
      Effect.try({
        try: () => getInboundReceipt(storage, receiptId),
        catch: toAccountStoreError,
      }),
    failInboundReceiptPolicy: (input: FailInboundReceiptPolicyInput) =>
      Effect.try({
        try: () =>
          failInboundReceiptPolicy(
            storage,
            Schema.decodeSync(FailInboundReceiptPolicyInput)(input),
          ),
        catch: toAccountStoreError,
      }),
    claimInboundReceipt: (input: ClaimInboundReceiptInput) =>
      Effect.try({
        try: () => claimInboundReceipt(storage, Schema.decodeSync(ClaimInboundReceiptInput)(input)),
        catch: toAccountStoreError,
      }),
    completeInboundReceipt: (receiptId: string) =>
      Effect.try({
        try: () => completeInboundReceipt(storage, receiptId),
        catch: toAccountStoreError,
      }),
    recordInboundReceiptRedrive: (input: RecordInboundReceiptRedriveInput) =>
      Effect.try({
        try: () =>
          recordInboundReceiptRedrive(
            storage,
            Schema.decodeSync(RecordInboundReceiptRedriveInput)(input),
          ),
        catch: toAccountStoreError,
      }),
    listInboundReceiptWork: (input: ListInboundReceiptWorkInput) =>
      Effect.try({
        try: () =>
          listInboundReceiptWork(storage, Schema.decodeSync(ListInboundReceiptWorkInput)(input)),
        catch: toAccountStoreError,
      }),
    getRecoveryScan: (scanId: string) =>
      Effect.try({
        try: () => getRecoveryScan(storage, scanId),
        catch: toAccountStoreError,
      }),
    putRecoveryScan: (input: PutRecoveryScanInput) =>
      Effect.try({
        try: () => putRecoveryScan(storage, Schema.decodeSync(PutRecoveryScanInput)(input)),
        catch: toAccountStoreError,
      }),
    listMessageSummaries: (input: ListMessageSummariesQuery) =>
      Effect.try({
        try: () =>
          listMessageSummaries(storage, Schema.decodeSync(ListMessageSummariesQuery)(input)),
        catch: toAccountStoreError,
      }),
    listThreadSummaries: (input: ListThreadSummariesQuery) =>
      Effect.try({
        try: () => listThreadSummaries(storage, Schema.decodeSync(ListThreadSummariesQuery)(input)),
        catch: toAccountStoreError,
      }),
    listThreadMessageSummaries: (handle: string, input: ListThreadMessageSummariesQuery) =>
      Effect.try({
        try: () =>
          listThreadMessageSummaries(
            storage,
            handle,
            Schema.decodeSync(ListThreadMessageSummariesQuery)(input),
          ),
        catch: toAccountStoreError,
      }),
    getMessageSummary: (messageId: string, mailboxScope: MailboxScope) =>
      Effect.try({
        try: () => getMessageSummary(storage, messageId, mailboxScope),
        catch: toAccountStoreError,
      }),
    getMessageBody: (messageId: string, mailboxScope: MailboxScope) =>
      Effect.try({
        try: () => getMessageBody(storage, messageId, mailboxScope),
        catch: toAccountStoreError,
      }),
    getStoredAttachment: (messageId: string, attachmentId: string, mailboxScope: MailboxScope) =>
      Effect.try({
        try: () => getStoredAttachment(storage, messageId, attachmentId, mailboxScope),
        catch: toAccountStoreError,
      }),
    getMessageSource: (messageId: string, mailboxScope: MailboxScope) =>
      Effect.try({
        try: () => getMessageSource(storage, messageId, mailboxScope),
        catch: toAccountStoreError,
      }),
    markThreadRead: (handle: string, isRead: boolean, mailboxScope: MailboxScope, nowIso: string) =>
      Effect.try({
        try: () => markThreadRead(storage, handle, isRead, mailboxScope, nowIso),
        catch: toAccountStoreError,
      }),
    softDeleteThread: (handle: string, mailboxScope: MailboxScope, deletedAt: string) =>
      Effect.try({
        try: () => softDeleteThread(storage, handle, mailboxScope, deletedAt),
        catch: toAccountStoreError,
      }),
    listAddresses: () =>
      Effect.try({
        try: () => listAddresses(storage),
        catch: toAccountStoreError,
      }),
    getAddress: (id: string) =>
      Effect.try({
        try: () => getAddress(storage, id),
        catch: toAccountStoreError,
      }),
    getAddressByMailbox: (address: string) =>
      Effect.try({
        try: () => getAddressByMailbox(storage, address),
        catch: toAccountStoreError,
      }),
    createAddress: (
      localPart: string,
      mailDomain: MailDomain,
      displayName: string | undefined,
      nowIso: string,
    ) =>
      Effect.try({
        try: () =>
          createAddress(
            storage,
            localPart,
            Schema.decodeSync(MailDomain)(mailDomain),
            displayName,
            nowIso,
          ),
        catch: toAccountStoreError,
      }),
    patchAddress: (id: string, payload: PatchAddressInput, nowIso: string) =>
      Effect.try({
        try: () => patchAddress(storage, id, Schema.decodeSync(PatchAddressInput)(payload), nowIso),
        catch: toAccountStoreError,
      }),
    listSendingIdentities: (mailDomain: MailDomain, mailboxScope: MailboxScope) =>
      Effect.try({
        try: () =>
          listSendingIdentities(storage, Schema.decodeSync(MailDomain)(mailDomain), mailboxScope),
        catch: toAccountStoreError,
      }),
    resolveSendingIdentity: (id: string, mailDomain: MailDomain) =>
      Effect.try({
        try: () => resolveSendingIdentity(storage, id, Schema.decodeSync(MailDomain)(mailDomain)),
        catch: toAccountStoreError,
      }),
    listDestinations: () =>
      Effect.try({
        try: () => listDestinations(storage),
        catch: toAccountStoreError,
      }),
    getDestination: (id: string) =>
      Effect.try({
        try: () => getDestination(storage, id),
        catch: toAccountStoreError,
      }),
    insertDestination: (
      cloudflareId: string,
      email: string,
      verifiedAt: string | null,
      nowIso: string,
    ) =>
      Effect.try({
        try: () => insertDestination(storage, cloudflareId, email, verifiedAt, nowIso),
        catch: toAccountStoreError,
      }),
    setAddressForwarding: (addressId: string, destinationId: string | null, nowIso: string) =>
      Effect.try({
        try: () => setAddressForwarding(storage, addressId, destinationId, nowIso),
        catch: toAccountStoreError,
      }),
    updateDestinationStatus: (id: string, verifiedAt: string | null, nowIso: string) =>
      Effect.try({
        try: () => updateDestinationStatus(storage, id, verifiedAt, nowIso),
        catch: toAccountStoreError,
      }),
    deleteDestination: (id: string, nowIso: string) =>
      Effect.try({
        try: () => deleteDestination(storage, id, nowIso),
        catch: toAccountStoreError,
      }),
    getMcpOAuthPolicy: (clientId: string) =>
      Effect.try({
        try: () => getMcpOAuthPolicy(storage, clientId),
        catch: toAccountStoreError,
      }),
    listMcpOAuthPolicies: () =>
      Effect.try({
        try: () => listMcpOAuthPolicies(storage),
        catch: toAccountStoreError,
      }),
    ensureMcpOAuthPolicy: (input: EnsureMcpOAuthPolicyInput) =>
      Effect.try({
        try: () =>
          ensureMcpOAuthPolicy(storage, Schema.decodeSync(EnsureMcpOAuthPolicyInput)(input)),
        catch: toAccountStoreError,
      }),
    updateMcpOAuthPolicy: (input: UpdateMcpOAuthPolicyInput) =>
      Effect.try({
        try: () =>
          updateMcpOAuthPolicy(storage, Schema.decodeSync(UpdateMcpOAuthPolicyInput)(input)),
        catch: toAccountStoreError,
      }),
    setMcpOAuthPolicyState: (input: SetMcpOAuthPolicyStateInput) =>
      Effect.try({
        try: () =>
          setMcpOAuthPolicyState(storage, Schema.decodeSync(SetMcpOAuthPolicyStateInput)(input)),
        catch: toAccountStoreError,
      }),
    revokeMcpOAuthPolicy: (clientId: string, updatedAt: string) =>
      Effect.try({
        try: () => revokeMcpOAuthPolicy(storage, clientId, updatedAt),
        catch: toAccountStoreError,
      }),
    submitOutbound: (input: SubmitOutboundInput) =>
      Effect.try({
        try: () => submitOutbound(storage, Schema.decodeSync(SubmitOutboundInput)(input)),
        catch: toAccountStoreError,
      }),
    lookupApprovalByTokenHash: (tokenHash: ApprovalTokenHash) =>
      Effect.try({
        try: () =>
          lookupApprovalByTokenHash(storage, Schema.decodeSync(ApprovalTokenHash)(tokenHash)),
        catch: toAccountStoreError,
      }),
    decideApproval: (input: DecideApprovalInput) =>
      Effect.try({
        try: () => decideApproval(storage, Schema.decodeSync(DecideApprovalInput)(input)),
        catch: toAccountStoreError,
      }),
    expirePendingApproval: (input: ExpireApprovalInput) =>
      Effect.try({
        try: () => expirePendingApproval(storage, Schema.decodeSync(ExpireApprovalInput)(input)),
        catch: toAccountStoreError,
      }),
    claimDispatch: (input: ClaimDispatchInput) =>
      Effect.try({
        try: () => claimDispatch(storage, Schema.decodeSync(ClaimDispatchInput)(input)),
        catch: toAccountStoreError,
      }),
    completeAttempt: (input: CompleteAttemptInput) =>
      Effect.try({
        try: () => completeAttempt(storage, Schema.decodeSync(CompleteAttemptInput)(input)),
        catch: toAccountStoreError,
      }),
    settleExpiredInFlight: (input: SettleExpiredInFlightInput) =>
      Effect.try({
        try: () =>
          settleExpiredInFlight(storage, Schema.decodeSync(SettleExpiredInFlightInput)(input)),
        catch: toAccountStoreError,
      }),
    rejectReadyDispatch: (input: RejectReadyDispatchInput) =>
      Effect.try({
        try: () => rejectReadyDispatch(storage, Schema.decodeSync(RejectReadyDispatchInput)(input)),
        catch: toAccountStoreError,
      }),
    getOutboundDispatch: (jobId: string) =>
      Effect.try({
        try: () => getOutboundDispatch(storage, jobId),
        catch: toAccountStoreError,
      }),
    getOutboundJob: (jobId: string, viewer: JobViewer) =>
      Effect.try({
        try: () => getOutboundJob(storage, jobId, Schema.decodeSync(JobViewer)(viewer)),
        catch: toAccountStoreError,
      }),
    listOutboundJobs: (input: ListOutboundJobsQuery) =>
      Effect.try({
        try: () => listOutboundJobs(storage, Schema.decodeSync(ListOutboundJobsQuery)(input)),
        catch: toAccountStoreError,
      }),
    listSendWork: (input: ListSendWorkInput) =>
      Effect.try({
        try: () => listSendWork(storage, Schema.decodeSync(ListSendWorkInput)(input)),
        catch: toAccountStoreError,
      }),
    listDuePendingApprovals: (input: ListDueApprovalsInput) =>
      Effect.try({
        try: () =>
          listDuePendingApprovals(storage, Schema.decodeSync(ListDueApprovalsInput)(input)),
        catch: toAccountStoreError,
      }),
    listPurgeableNotifications: (input: ListPurgeableNotificationsInput) =>
      Effect.try({
        try: () =>
          listPurgeableNotifications(
            storage,
            Schema.decodeSync(ListPurgeableNotificationsInput)(input),
          ),
        catch: toAccountStoreError,
      }),
    purgeNotificationCiphertext: (input: PurgeNotificationCiphertextInput) =>
      Effect.try({
        try: () =>
          purgeNotificationCiphertext(
            storage,
            Schema.decodeSync(PurgeNotificationCiphertextInput)(input),
          ),
        catch: toAccountStoreError,
      }),
  } satisfies AccountStoreRpc;
}

export class AccountStore extends Cloudflare.DurableObject<AccountStore, AccountStoreRpc>()(
  "AccountStore",
) {}

export const AccountStoreLive = AccountStore.make<never>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const storage = state.raw.storage;
      const accountId = state.raw.id.name;
      if (accountId === undefined) {
        throw new AccountIdentityError({
          message: "AccountStore must be addressed by a stable account ID",
        });
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      applyAccountSchema(storage, {
        accountId,
        nowIso,
      });
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
  input: { readonly mailDomain: MailDomain; readonly localParts: ReadonlyArray<string>; readonly nowIso: string },
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
