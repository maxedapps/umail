import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";

import type { ApprovalTokenHash, MailDomain } from "@umail/api-contract";

import { THREADING_ANCESTRY_WORK_BUDGET, cryptoThreadingIds } from "../../src/account/threading.ts";
import {
  acceptInbound,
  acceptOutbound,
  applyAccountSchema,
  claimInboundReceipt,
  completeInboundReceipt,
  failInboundReceiptPolicy,
  getInboundReceipt,
  getRecoveryScan,
  inspectRfcLookup,
  listAppliedMigrations,
  listInboundReceiptWork,
  listItemsByIds,
  listSchemaTables,
  observeInboundForward,
  putRecoveryScan,
  recordInboundReceiptRedrive,
  recordItemGroup,
  registerInboundReceipt,
  resolveConversation,
  schemaStatus,
} from "../../src/account/commands.ts";
import { accountMigrations, type AccountMigration } from "../../src/account/migrations.ts";
import {
  cancelApprovalAfterNotificationFailure,
  claimDispatch,
  completeAttempt,
  decideApproval,
  expirePendingApproval,
  getOutboundDispatch,
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
} from "../../src/account/jobs.ts";
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
} from "../../src/account/administration.ts";
import {
  getMessageBody,
  getMessageSource,
  getStoredAttachment,
  listMessageSummaries,
  listThreadMessageSummaries,
  listThreadSummaries,
  markThreadRead,
  softDeleteThread,
} from "../../src/account/queries.ts";
import { toAccountStoreError } from "../../src/account/errors.ts";
import {
  type AcceptInboundInput,
  type AcceptOutboundInput,
  type CancelApprovalNotificationInput,
  type ClaimDispatchInput,
  type ClaimInboundReceiptInput,
  type CompleteAttemptInput,
  type DecideApprovalInput,
  type EnsureMcpOAuthPolicyInput,
  type ExpireApprovalInput,
  type FailInboundReceiptPolicyInput,
  type JobViewer,
  type ListDueApprovalsInput,
  type ListInboundReceiptWorkInput,
  type ListMessageSummariesQuery,
  type ListOutboundJobsQuery,
  type ListPurgeableNotificationsInput,
  type ListSendWorkInput,
  type ListThreadMessageSummariesQuery,
  type ListThreadSummariesQuery,
  type MailboxScope,
  type ObserveInboundForwardInput,
  type PatchAddressInput,
  type PurgeNotificationCiphertextInput,
  type PutRecoveryScanInput,
  type RecordInboundReceiptRedriveInput,
  type RejectReadyDispatchInput,
  type RecordItemGroupInput,
  type RegisterInboundReceiptInput,
  type SetMcpOAuthPolicyStateInput,
  type SettleExpiredInFlightInput,
  type SubmitOutboundInput,
  type UpdateMcpOAuthPolicyInput,
} from "../../src/account/domain.ts";

const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";

const AccountSchemaColumnRow = Schema.Struct({
  name: Schema.String,
});

const FAILING_MIGRATION = {
  version: 10,
  name: "0010_fail",
  sql: `CREATE TABLE fail_marker (
  id TEXT PRIMARY KEY NOT NULL
);
INSERT INTO fail_marker (id) VALUES ('x');
INSERT INTO fail_marker (id) VALUES ('x');
`,
} as const satisfies AccountMigration;

export class AccountStoreTestHost extends DurableObject {
  #activationError: Error | undefined;
  #ready = false;

  schemaStatus() {
    this.#ensureReady();
    return schemaStatus(this.ctx.storage);
  }

  recordItemGroup(input: RecordItemGroupInput) {
    this.#ensureReady();
    recordItemGroup(this.ctx.storage, input);
  }

  listItemsByIds(ids: ReadonlyArray<string>) {
    this.#ensureReady();
    return listItemsByIds(this.ctx.storage, ids);
  }

  acceptInbound(input: AcceptInboundInput, ancestryWorkBudget?: number) {
    this.#ensureReady();
    return acceptInbound(this.ctx.storage, input, persistOptions(ancestryWorkBudget));
  }

  acceptInboundWithReceipt(input: AcceptInboundInput, ancestryWorkBudget?: number) {
    this.#ensureReady();
    registerInboundReceipt(this.ctx.storage, {
      receiptId: input.messageId,
      digest: `digest-${input.messageId}`,
      envelopeFrom: "sender@example.com",
      envelopeTo: "inbox@umail.example.com",
      rawKey: `raw/${input.messageId}`,
      manifestKey: `receipts/${input.messageId}.json`,
      advertisedRawSize: 1,
      consumedBytes: 1,
      receivedAt: input.occurredAt,
    });
    return acceptInbound(this.ctx.storage, input, persistOptions(ancestryWorkBudget));
  }

  acceptOutbound(input: AcceptOutboundInput, ancestryWorkBudget?: number) {
    this.#ensureReady();
    return acceptOutbound(this.ctx.storage, input, persistOptions(ancestryWorkBudget));
  }

  resolveConversation(handle: string) {
    this.#ensureReady();
    return resolveConversation(this.ctx.storage, handle);
  }

  inspectRfcLookup(rfcMessageId: string) {
    this.#ensureReady();
    return inspectRfcLookup(this.ctx.storage, rfcMessageId);
  }

  registerInboundReceipt(input: RegisterInboundReceiptInput) {
    this.#ensureReady();
    return registerInboundReceipt(this.ctx.storage, input);
  }

  observeInboundForward(input: ObserveInboundForwardInput) {
    this.#ensureReady();
    return observeInboundForward(this.ctx.storage, input);
  }

  getInboundReceipt(receiptId: string) {
    this.#ensureReady();
    return getInboundReceipt(this.ctx.storage, receiptId);
  }

  removeInboundReceiptForIntegrityTest(receiptId: string) {
    this.#ensureReady();
    this.ctx.storage.sql.exec("DELETE FROM inbound_receipts WHERE id = ?", receiptId);
  }

  failInboundReceiptPolicy(input: FailInboundReceiptPolicyInput) {
    this.#ensureReady();
    return failInboundReceiptPolicy(this.ctx.storage, input);
  }

  claimInboundReceipt(input: ClaimInboundReceiptInput) {
    this.#ensureReady();
    return claimInboundReceipt(this.ctx.storage, input);
  }

  completeInboundReceipt(receiptId: string) {
    this.#ensureReady();
    return completeInboundReceipt(this.ctx.storage, receiptId);
  }

  recordInboundReceiptRedrive(input: RecordInboundReceiptRedriveInput) {
    this.#ensureReady();
    return recordInboundReceiptRedrive(this.ctx.storage, input);
  }

  listInboundReceiptWork(input: ListInboundReceiptWorkInput) {
    this.#ensureReady();
    return listInboundReceiptWork(this.ctx.storage, input);
  }

  getRecoveryScan(scanId: string) {
    this.#ensureReady();
    return getRecoveryScan(this.ctx.storage, scanId);
  }

  putRecoveryScan(input: PutRecoveryScanInput) {
    this.#ensureReady();
    return putRecoveryScan(this.ctx.storage, input);
  }

  listMessageSummaries(input: ListMessageSummariesQuery) {
    this.#ensureReady();
    return listMessageSummaries(this.ctx.storage, input);
  }

  listThreadSummaries(input: ListThreadSummariesQuery) {
    this.#ensureReady();
    return listThreadSummaries(this.ctx.storage, input);
  }

  listThreadMessageSummaries(handle: string, input: ListThreadMessageSummariesQuery) {
    this.#ensureReady();
    return listThreadMessageSummaries(this.ctx.storage, handle, input);
  }

  getMessageBody(messageId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getMessageBody(this.ctx.storage, messageId, mailboxScope);
  }

  getStoredAttachment(messageId: string, attachmentId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getStoredAttachment(this.ctx.storage, messageId, attachmentId, mailboxScope);
  }

  getMessageSource(messageId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getMessageSource(this.ctx.storage, messageId, mailboxScope);
  }

  markThreadRead(handle: string, isRead: boolean, mailboxScope: MailboxScope, nowIso: string) {
    this.#ensureReady();
    markThreadRead(this.ctx.storage, handle, isRead, mailboxScope, nowIso);
  }

  softDeleteThread(handle: string, mailboxScope: MailboxScope, deletedAt: string) {
    this.#ensureReady();
    softDeleteThread(this.ctx.storage, handle, mailboxScope, deletedAt);
  }

  listAddresses() {
    this.#ensureReady();
    return listAddresses(this.ctx.storage);
  }

  getAddress(id: string) {
    this.#ensureReady();
    return getAddress(this.ctx.storage, id);
  }

  getAddressByMailbox(address: string) {
    this.#ensureReady();
    return getAddressByMailbox(this.ctx.storage, address);
  }

  createAddress(
    localPart: string,
    mailDomain: MailDomain,
    displayName: string | undefined,
    nowIso: string,
  ) {
    this.#ensureReady();
    return createAddress(this.ctx.storage, localPart, mailDomain, displayName, nowIso);
  }

  patchAddress(id: string, payload: PatchAddressInput, nowIso: string) {
    this.#ensureReady();
    return patchAddress(this.ctx.storage, id, payload, nowIso);
  }

  listSendingIdentities(mailDomain: MailDomain, mailboxScope: MailboxScope = "all") {
    this.#ensureReady();
    return listSendingIdentities(this.ctx.storage, mailDomain, mailboxScope);
  }

  resolveSendingIdentity(id: string, mailDomain: MailDomain) {
    this.#ensureReady();
    return resolveSendingIdentity(this.ctx.storage, id, mailDomain);
  }

  listDestinations() {
    this.#ensureReady();
    return listDestinations(this.ctx.storage);
  }

  getDestination(id: string) {
    this.#ensureReady();
    return getDestination(this.ctx.storage, id);
  }

  insertDestination(
    cloudflareId: string,
    email: string,
    verifiedAt: string | null,
    nowIso: string,
  ) {
    this.#ensureReady();
    return insertDestination(this.ctx.storage, cloudflareId, email, verifiedAt, nowIso);
  }

  setAddressForwarding(addressId: string, destinationId: string | null, nowIso: string) {
    this.#ensureReady();
    return setAddressForwarding(this.ctx.storage, addressId, destinationId, nowIso);
  }

  updateDestinationStatus(id: string, verifiedAt: string | null, nowIso: string) {
    this.#ensureReady();
    return updateDestinationStatus(this.ctx.storage, id, verifiedAt, nowIso);
  }

  deleteDestination(id: string, nowIso: string) {
    this.#ensureReady();
    deleteDestination(this.ctx.storage, id, nowIso);
  }

  getMcpOAuthPolicy(clientId: string) {
    this.#ensureReady();
    return getMcpOAuthPolicy(this.ctx.storage, clientId);
  }

  listMcpOAuthPolicies() {
    this.#ensureReady();
    return listMcpOAuthPolicies(this.ctx.storage);
  }

  ensureMcpOAuthPolicy(input: EnsureMcpOAuthPolicyInput) {
    this.#ensureReady();
    return ensureMcpOAuthPolicy(this.ctx.storage, input);
  }

  updateMcpOAuthPolicy(input: UpdateMcpOAuthPolicyInput) {
    this.#ensureReady();
    return updateMcpOAuthPolicy(this.ctx.storage, input);
  }

  setMcpOAuthPolicyState(input: SetMcpOAuthPolicyStateInput) {
    this.#ensureReady();
    return setMcpOAuthPolicyState(this.ctx.storage, input);
  }

  revokeMcpOAuthPolicy(clientId: string, updatedAt: string) {
    this.#ensureReady();
    return revokeMcpOAuthPolicy(this.ctx.storage, clientId, updatedAt);
  }

  submitOutbound(input: SubmitOutboundInput) {
    this.#ensureReady();
    return submitOutbound(this.ctx.storage, input);
  }

  lookupApprovalByTokenHash(tokenHash: ApprovalTokenHash) {
    this.#ensureReady();
    return lookupApprovalByTokenHash(this.ctx.storage, tokenHash);
  }

  decideApproval(input: DecideApprovalInput) {
    this.#ensureReady();
    return decideApproval(this.ctx.storage, input);
  }

  expirePendingApproval(input: ExpireApprovalInput) {
    this.#ensureReady();
    return expirePendingApproval(this.ctx.storage, input);
  }

  cancelApprovalAfterNotificationFailure(input: CancelApprovalNotificationInput) {
    this.#ensureReady();
    return cancelApprovalAfterNotificationFailure(this.ctx.storage, input);
  }

  claimDispatch(input: ClaimDispatchInput) {
    this.#ensureReady();
    return claimDispatch(this.ctx.storage, input);
  }

  completeAttempt(input: CompleteAttemptInput) {
    this.#ensureReady();
    return completeAttempt(this.ctx.storage, input);
  }

  settleExpiredInFlight(input: SettleExpiredInFlightInput) {
    this.#ensureReady();
    return settleExpiredInFlight(this.ctx.storage, input);
  }

  rejectReadyDispatch(input: RejectReadyDispatchInput) {
    this.#ensureReady();
    return rejectReadyDispatch(this.ctx.storage, input);
  }

  getOutboundDispatch(jobId: string) {
    this.#ensureReady();
    return getOutboundDispatch(this.ctx.storage, jobId);
  }

  getOutboundJob(jobId: string, viewer: JobViewer) {
    this.#ensureReady();
    return getOutboundJob(this.ctx.storage, jobId, viewer);
  }

  listOutboundJobs(input: ListOutboundJobsQuery) {
    this.#ensureReady();
    return listOutboundJobs(this.ctx.storage, input);
  }

  listSendWork(input: ListSendWorkInput) {
    this.#ensureReady();
    return listSendWork(this.ctx.storage, input);
  }

  listDuePendingApprovals(input: ListDueApprovalsInput) {
    this.#ensureReady();
    return listDuePendingApprovals(this.ctx.storage, input);
  }

  listPurgeableNotifications(input: ListPurgeableNotificationsInput) {
    this.#ensureReady();
    return listPurgeableNotifications(this.ctx.storage, input);
  }

  purgeNotificationCiphertext(input: PurgeNotificationCiphertextInput) {
    this.#ensureReady();
    return purgeNotificationCiphertext(this.ctx.storage, input);
  }

  listTables() {
    this.#ensureReady();
    return listSchemaTables(this.ctx.storage);
  }

  listMigrations() {
    this.#ensureReady();
    return listAppliedMigrations(this.ctx.storage);
  }

  listMessageColumns() {
    this.#ensureReady();
    return Schema.decodeUnknownSync(Schema.Array(AccountSchemaColumnRow))(
      this.ctx.storage.sql.exec("PRAGMA table_info(messages)").toArray(),
    ).map((row) => row.name);
  }

  applyFailingMigration() {
    this.#ensureReady();
    applyAccountSchema(this.ctx.storage, {
      accountId: requireAccountId(this.ctx),
      nowIso: TEST_NOW_ISO,
      migrations: [...accountMigrations, FAILING_MIGRATION],
    });
  }

  applySchemaForAccount(accountId: string) {
    this.#ensureReady();
    applyAccountSchema(this.ctx.storage, {
      accountId,
      nowIso: TEST_NOW_ISO,
    });
  }

  installUnsupportedSchema(version: number) {
    this.#ensureReady();
    this.ctx.storage.sql.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      version,
      "future_schema",
      TEST_NOW_ISO,
    );
  }

  installOldSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY NOT NULL)");
    this.ctx.storage.sql.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      8,
      "0008_approval_notification_jobs",
      TEST_NOW_ISO,
    );
  }

  inspectUninitializedSchema() {
    return {
      tables: listSchemaTables(this.ctx.storage),
      migrations: listAppliedMigrations(this.ctx.storage),
    };
  }

  #ensureReady(): void {
    if (this.#activationError !== undefined) {
      throw this.#activationError;
    }
    if (this.#ready) return;
    try {
      applyAccountSchema(this.ctx.storage, {
        accountId: requireAccountId(this.ctx),
        nowIso: TEST_NOW_ISO,
      });
      this.#ready = true;
    } catch (cause) {
      this.#activationError = toAccountStoreError(cause);
      throw this.#activationError;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("account-store-test-host", { status: 200 });
  },
};

function persistOptions(ancestryWorkBudget: number | undefined) {
  return {
    ancestryWorkBudget:
      ancestryWorkBudget === undefined ? THREADING_ANCESTRY_WORK_BUDGET : ancestryWorkBudget,
    ids: cryptoThreadingIds(),
  };
}

function requireAccountId(state: DurableObjectState): string {
  const accountId = state.id.name;
  if (accountId === undefined) {
    throw toAccountStoreError(
      new Error("AccountStore test host must be addressed by a stable account name"),
    );
  }
  return accountId;
}
