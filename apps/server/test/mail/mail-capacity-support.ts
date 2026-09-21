import type {
  AcceptInboundInput,
  AcceptMessageResult,
  AccountAddress,
  ClaimInboundReceiptResult,
  FailInboundReceiptPolicyInput,
  InboundReceipt,
} from "../../src/account/domain.ts";
import { parseMailboxAddress } from "@umail/api-contract";
import type { MailHtmlPolicy } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import PostalMime from "postal-mime";

import type { InboundPorts } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/index-payload.ts";
import { INBOUND_MIME_LIMITS } from "../../src/mail/policy.ts";
import {
  consumeIndexReceipt,
  IndexFailure,
  type IndexConsumerAccount,
} from "../../src/mail/process-index.ts";
import { MemoryAccountStore, MemoryArchive, MemoryIndex } from "./fakes.ts";
import { MAIL_CAPACITY_INBOX } from "./mail-capacity-fixtures.ts";

export const MAIL_CAPACITY_NOW_ISO = "2026-01-01T00:00:00.000Z";
export const MAIL_CAPACITY_CLAIM_UNTIL_ISO = "2026-01-01T00:15:00.000Z";
const MAIL_CAPACITY_ADDRESS_ID = "capacity-address";

export class MailCapacityAccount extends MemoryAccountStore {
  readonly accepted: AcceptInboundInput[] = [];
  readonly policyFailures: FailInboundReceiptPolicyInput[] = [];

  asIndexAccount(): IndexConsumerAccount {
    return {
      getInboundReceipt: (receiptId) =>
        Effect.tryPromise({
          try: () => this.getInboundReceipt(receiptId),
          catch: () => new IndexFailure({ reason: "sql_failed" }),
        }),
      getAddressByMailbox: (address) =>
        Effect.tryPromise({
          try: () => this.getAddressByMailbox(address),
          catch: () => new IndexFailure({ reason: "sql_failed" }),
        }),
      claimInboundReceipt: (input) =>
        Effect.try({
          try: () => this.claim(input.receiptId, input.claimUntilIso),
          catch: () => new IndexFailure({ reason: "sql_failed" }),
        }),
      acceptInbound: (input) =>
        Effect.try({
          try: () => this.accept(input),
          catch: (cause) =>
            Schema.is(IndexFailure)(cause) ? cause : new IndexFailure({ reason: "sql_failed" }),
        }),
      completeInboundReceipt: (receiptId) =>
        Effect.try({
          try: () => this.complete(receiptId),
          catch: () => new IndexFailure({ reason: "sql_failed" }),
        }),
      failInboundReceiptPolicy: (input) =>
        Effect.try({
          try: () => this.failPolicy(input),
          catch: () => new IndexFailure({ reason: "sql_failed" }),
        }),
    };
  }

  private claim(receiptId: string, claimUntilIso: string): ClaimInboundReceiptResult {
    const receipt = this.requireReceipt(receiptId);
    if (isFinished(receipt.workState)) {
      return { receipt, claimed: false };
    }
    const claimed = {
      ...receipt,
      workState: "claimed" as const,
      claimedUntil: claimUntilIso,
    } satisfies InboundReceipt;
    this.receipts.set(receiptId, claimed);
    return { receipt: claimed, claimed: true };
  }

  private accept(input: AcceptInboundInput): AcceptMessageResult {
    const existing = this.accepted.find((item) => item.messageId === input.messageId);
    if (existing !== undefined) {
      throw new IndexFailure({ reason: "duplicate" });
    }
    this.accepted.push(input);
    return {
      messageId: input.messageId,
      nodeId: input.messageId,
      threadHandle: `node:${input.messageId}`,
      componentRootId: input.messageId,
      claimedRfcMessageId: input.rfcMessageId,
      parentNodeId: null,
      diagnostics: [],
    };
  }

  private complete(receiptId: string): InboundReceipt {
    const receipt = this.requireReceipt(receiptId);
    const indexed = {
      ...receipt,
      workState: "indexed" as const,
      claimedUntil: null,
    } satisfies InboundReceipt;
    this.receipts.set(receiptId, indexed);
    return indexed;
  }

  private failPolicy(input: FailInboundReceiptPolicyInput): InboundReceipt {
    const receipt = this.requireReceipt(input.receiptId);
    const failed = {
      ...receipt,
      workState: "policy_failed" as const,
      policyError: input.reason,
      claimedUntil: null,
      lastError: input.reason,
    } satisfies InboundReceipt;
    this.receipts.set(input.receiptId, failed);
    this.policyFailures.push(input);
    return failed;
  }

  private requireReceipt(receiptId: string): InboundReceipt {
    const receipt = this.receipts.get(receiptId);
    if (receipt === undefined) {
      throw new Error(`missing receipt ${receiptId}`);
    }
    return receipt;
  }
}

export type MailCapacityWorld<Policy extends MailHtmlPolicy> = {
  readonly archive: MemoryArchive;
  readonly index: MemoryIndex;
  readonly account: MailCapacityAccount;
  readonly htmlPolicy: Policy;
  readonly ports: InboundPorts;
};

export function createMailCapacityWorld<Policy extends MailHtmlPolicy>(
  htmlPolicy: Policy,
): MailCapacityWorld<Policy> {
  const archive = new MemoryArchive();
  const index = new MemoryIndex();
  const account = new MailCapacityAccount();
  const ports = {
    ARCHIVE: archive,
    INDEX: index,
    ACCOUNT: account,
    nowIso: () => MAIL_CAPACITY_NOW_ISO,
  } satisfies InboundPorts;
  return { archive, index, account, htmlPolicy, ports };
}

export function seedMailCapacityInbox(account: MailCapacityAccount): AccountAddress {
  const parsed = parseMailboxAddress(MAIL_CAPACITY_INBOX);
  if (parsed.kind === "invalid") {
    throw new Error("capacity inbox fixture is invalid");
  }
  const address = {
    id: MAIL_CAPACITY_ADDRESS_ID,
    localPart: parsed.localPart,
    address: parsed.address,
    displayName: "Capacity Inbox",
    active: true,
    forwardingDestinationId: null,
    createdAt: MAIL_CAPACITY_NOW_ISO,
    updatedAt: MAIL_CAPACITY_NOW_ISO,
  } satisfies AccountAddress;
  account.seedAddress(address);
  return address;
}

export async function consumeMailCapacityWork<Policy extends MailHtmlPolicy>(
  world: MailCapacityWorld<Policy>,
  work: IndexReceiptWork,
): Promise<void> {
  await Effect.runPromise(
    consumeIndexReceipt(
      work.receiptId,
      world.archive.asStore(),
      world.htmlPolicy,
      world.account.asIndexAccount(),
      MAIL_CAPACITY_NOW_ISO,
      MAIL_CAPACITY_CLAIM_UNTIL_ISO,
    ),
  );
}

export async function consumeNextMailCapacityWork<Policy extends MailHtmlPolicy>(
  world: MailCapacityWorld<Policy>,
): Promise<IndexReceiptWork> {
  const work = world.index.payloads.shift();
  if (work === undefined) {
    throw new Error("expected queued mail capacity work");
  }
  await consumeMailCapacityWork(world, work);
  return work;
}

export async function parseMailCapacityMime(raw: Uint8Array) {
  return PostalMime.parse(raw.slice().buffer, {
    attachmentEncoding: "arraybuffer",
    ...INBOUND_MIME_LIMITS,
  });
}

function isFinished(state: InboundReceipt["workState"]): boolean {
  return (
    state === "indexed" ||
    state === "policy_failed" ||
    state === "terminal" ||
    state === "operator_reprocess"
  );
}
