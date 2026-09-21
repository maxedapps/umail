import { DurableObject } from "cloudflare:workers";

import type { MailDomain } from "@umail/api-contract";
import {
  acceptInbound,
  applyAccountSchema,
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
} from "../../src/account/commands.ts";
import {
  claimDispatch,
  completeAttempt,
  decideApproval,
  expirePendingApproval,
  getOutboundDispatch,
  getOutboundJob,
  listDuePendingApprovals,
  listPurgeableNotifications,
  listSendWork,
  purgeNotificationCiphertext,
  rejectReadyDispatch,
  settleExpiredInFlight,
  submitOutbound,
} from "../../src/account/jobs.ts";
import {
  createAddress,
  ensureMcpOAuthPolicy,
  insertDestination,
  getAddressByMailbox,
  getDestination,
  patchAddress,
  setAddressForwarding,
  updateMcpOAuthPolicy,
} from "../../src/account/administration.ts";
import { getMessageBody, listMessageSummaries } from "../../src/account/queries.ts";
import { toAccountStoreError } from "../../src/account/errors.ts";
import {
  type AcceptInboundInput,
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
  type ListPurgeableNotificationsInput,
  type ListSendWorkInput,
  type MailboxScope,
  type ObserveInboundForwardInput,
  type PatchAddressInput,
  type PurgeNotificationCiphertextInput,
  type PutRecoveryScanInput,
  type RecordInboundReceiptRedriveInput,
  type RegisterInboundReceiptInput,
  type RejectReadyDispatchInput,
  type SettleExpiredInFlightInput,
  type SubmitOutboundInput,
  type UpdateMcpOAuthPolicyInput,
} from "../../src/account/domain.ts";

const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";

export class AccountStoreTestHost extends DurableObject {
  #activationError: Error | undefined;
  #ready = false;

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

  getAddressByMailbox(address: string) {
    this.#ensureReady();
    return getAddressByMailbox(this.ctx.storage, address);
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

  patchAddress(id: string, payload: PatchAddressInput, nowIso: string) {
    this.#ensureReady();
    return patchAddress(this.ctx.storage, id, payload, nowIso);
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

  acceptInbound(input: AcceptInboundInput) {
    this.#ensureReady();
    return acceptInbound(this.ctx.storage, input);
  }

  getMessageBody(messageId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getMessageBody(this.ctx.storage, messageId, mailboxScope);
  }

  listMessageSummaries(input: ListMessageSummariesQuery) {
    this.#ensureReady();
    return listMessageSummaries(this.ctx.storage, input);
  }

  submitOutbound(input: SubmitOutboundInput) {
    this.#ensureReady();
    return submitOutbound(this.ctx.storage, input);
  }

  ensureMcpOAuthPolicy(input: EnsureMcpOAuthPolicyInput) {
    this.#ensureReady();
    return ensureMcpOAuthPolicy(this.ctx.storage, input);
  }

  updateMcpOAuthPolicy(input: UpdateMcpOAuthPolicyInput) {
    this.#ensureReady();
    return updateMcpOAuthPolicy(this.ctx.storage, input);
  }

  decideApproval(input: DecideApprovalInput) {
    this.#ensureReady();
    return decideApproval(this.ctx.storage, input);
  }

  expirePendingApproval(input: ExpireApprovalInput) {
    this.#ensureReady();
    return expirePendingApproval(this.ctx.storage, input);
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
    return new Response("mail-receipt-test-host", { status: 200 });
  },
};

function requireAccountId(state: DurableObjectState): string {
  const accountId = state.id.name;
  if (accountId === undefined) {
    throw toAccountStoreError(
      new Error("AccountStore test host must be addressed by a stable account name"),
    );
  }
  return accountId;
}
