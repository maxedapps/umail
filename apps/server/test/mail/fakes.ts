import type { RpcAsync } from "alchemy/Cloudflare/Bridge";
import type { AccountStoreRpc } from "../../src/account/worker.ts";
import { indexFailureFromCause } from "../../src/mail/indexing.ts";
import type { IndexConsumerAccount, IndexFailure } from "../../src/mail/process-index.ts";
import type {
  AccountAddress,
  AccountDestination,
  InboundReceipt,
  ObserveInboundForwardInput,
  RegisterInboundReceiptInput,
  RegisterInboundReceiptResult,
} from "../../src/account/domain.ts";
import {
  MailHtmlPolicyError,
  type MailHtmlMaterialization,
  type MailHtmlPolicy,
  type MailHtmlSanitization,
  type StoredMailHtml,
} from "@umail/mail-content";
import * as Effect from "effect/Effect";

import type { InboundAccount, InboundMessage } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/index-payload.ts";
import { ArchiveError, type ArchiveStore } from "../../src/mail/process-index.ts";
export type MailHtmlSanitizeCall = {
  readonly html: string;
  readonly sanitization: MailHtmlSanitization;
};

export class FakeMailHtmlPolicy implements MailHtmlPolicy {
  readonly calls: MailHtmlSanitizeCall[] = [];
  private output: StoredMailHtml | null = null;
  private failureReason: MailHtmlPolicyError["reason"] | null = null;
  private nextPause: MailHtmlPolicyPauseState | null = null;

  setOutput(body: string, hasRemoteImages = false): void {
    this.output = { body, hasRemoteImages };
  }

  fail(reason: MailHtmlPolicyError["reason"] = "rewrite_failed"): void {
    this.failureReason = reason;
  }

  succeed(): void {
    this.failureReason = null;
  }

  pauseNext(): MailHtmlPolicyPause {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    this.nextPause = { started: started.resolve, released: released.promise };
    return { started: started.promise, release: released.resolve };
  }

  sanitizeForStorage(
    html: string,
    sanitization: MailHtmlSanitization,
  ): Effect.Effect<StoredMailHtml, MailHtmlPolicyError> {
    this.calls.push({ html, sanitization });
    const pause = this.nextPause;
    if (pause !== null) {
      this.nextPause = null;
      pause.started();
      return Effect.promise(() => pause.released).pipe(Effect.flatMap(() => this.result(html)));
    }
    return this.result(html);
  }

  materializeRemoteImages(
    materialization: MailHtmlMaterialization,
  ): Effect.Effect<string, MailHtmlPolicyError> {
    return Effect.succeed(materialization.body);
  }

  private result(html: string): Effect.Effect<StoredMailHtml, MailHtmlPolicyError> {
    if (this.failureReason !== null) {
      return Effect.fail(new MailHtmlPolicyError({ reason: this.failureReason }));
    }
    return Effect.succeed(this.output ?? { body: html, hasRemoteImages: false });
  }
}

export type MailHtmlPolicyPause = {
  readonly started: Promise<void>;
  readonly release: () => void;
};

type MailHtmlPolicyPauseState = {
  readonly started: () => void;
  readonly released: Promise<void>;
};

export class MemoryArchive {
  readonly objects = new Map<string, Uint8Array>();
  readonly observedStorePutKeys: string[] = [];
  readonly observedPutKeys: string[] = [];
  private storePutOrdinal = 0;
  private failingStorePutOrdinal: number | null = null;
  private failingPutKey: string | null = null;

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.observedPutKeys.push(key);
    if (this.failingPutKey === key) {
      this.failingPutKey = null;
      throw new Error("archive put failed");
    }
    this.objects.set(key, bytes);
  }

  failNextPutForKey(key: string): void {
    this.failingPutKey = key;
  }

  failNextStorePut(): void {
    this.failStorePutAtOrdinal(0);
  }

  failStorePutAtOrdinal(ordinal: number): void {
    this.storePutOrdinal = 0;
    this.failingStorePutOrdinal = ordinal;
  }

  asStore(): ArchiveStore {
    return {
      get: (key) =>
        Effect.sync(() => {
          const bytes = this.objects.get(key);
          return bytes === undefined ? null : bytes.slice().buffer;
        }),
      put: (key, bytes) => {
        const ordinal = this.storePutOrdinal;
        this.storePutOrdinal += 1;
        this.observedStorePutKeys.push(key);
        if (this.failingStorePutOrdinal === ordinal) {
          this.failingStorePutOrdinal = null;
          return Effect.fail(new ArchiveError({ reason: "put_failed" }));
        }
        return Effect.sync(() => {
          this.objects.set(key, bytes);
        });
      },
    };
  }
}

export class MemoryIndex {
  readonly payloads: IndexReceiptWork[] = [];
  private failSend = false;

  async send(payload: IndexReceiptWork): Promise<void> {
    if (this.failSend) {
      this.failSend = false;
      throw new Error("index send failed");
    }
    this.payloads.push(payload);
  }

  failNextSend(): void {
    this.failSend = true;
  }
}

export class MemoryAccountStore implements InboundAccount {
  readonly receipts = new Map<string, InboundReceipt>();
  readonly addresses = new Map<string, AccountAddress>();
  readonly destinations = new Map<string, AccountDestination>();
  private failRegister = false;
  private failObserveKinds = new Set<"unknown" | "success" | "failure">();

  seedAddress(address: AccountAddress, destination: AccountDestination | null = null): void {
    this.addresses.set(address.address, address);
    if (destination !== null) {
      this.destinations.set(destination.id, destination);
    }
  }

  async registerInboundReceipt(
    input: RegisterInboundReceiptInput,
  ): Promise<RegisterInboundReceiptResult> {
    if (this.failRegister) {
      this.failRegister = false;
      throw new Error("register failed");
    }
    const existing = this.receipts.get(input.receiptId);
    if (existing !== undefined) {
      return { receipt: existing, created: false };
    }
    const receipt = {
      receiptId: input.receiptId,
      digest: input.digest,
      envelopeFrom: input.envelopeFrom,
      envelopeTo: input.envelopeTo,
      rawKey: input.rawKey,
      manifestKey: input.manifestKey,
      advertisedRawSize: input.advertisedRawSize,
      consumedBytes: input.consumedBytes,
      receivedAt: input.receivedAt,
      createdAt: input.receivedAt,
      forward: { kind: "none" as const },
      workState: "ready" as const,
      policyError: null,
      claimedUntil: null,
      retryAfter: null,
      attemptCount: 0,
      lastError: null,
    } satisfies InboundReceipt;
    this.receipts.set(input.receiptId, receipt);
    return { receipt, created: true };
  }

  async observeInboundForward(input: ObserveInboundForwardInput): Promise<InboundReceipt> {
    if (this.failObserveKinds.has(input.observation.kind)) {
      this.failObserveKinds.delete(input.observation.kind);
      throw new Error("observe failed");
    }
    const current = this.receipts.get(input.receiptId);
    if (current === undefined) {
      throw new Error(`Missing inbound receipt ${input.receiptId}`);
    }
    const next = nextForwardObservation(current.forward, input.observation);
    if (next === current.forward) {
      return current;
    }
    const updated = { ...current, forward: next } satisfies InboundReceipt;
    this.receipts.set(input.receiptId, updated);
    return updated;
  }

  async getInboundReceipt(receiptId: string): Promise<InboundReceipt | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async getAddressByMailbox(address: string): Promise<AccountAddress | null> {
    return this.addresses.get(address) ?? null;
  }

  async getDestination(id: string): Promise<AccountDestination | null> {
    return this.destinations.get(id) ?? null;
  }

  failNextRegister(): void {
    this.failRegister = true;
  }

  failNextObserve(kind: "unknown" | "success" | "failure"): void {
    this.failObserveKinds.add(kind);
  }
}

function nextForwardObservation(
  current: InboundReceipt["forward"],
  incoming: ObserveInboundForwardInput["observation"],
): InboundReceipt["forward"] {
  if (current.kind === "success" || current.kind === "failure") {
    return current;
  }
  if (current.kind === "unknown") {
    if (incoming.kind === "success" || incoming.kind === "failure") {
      return incoming;
    }
    return current;
  }
  return incoming;
}

export class FakeEmail implements InboundMessage {
  readonly to: string;
  readonly from: string;
  readonly rawSize: number;
  rejectReason: string | null = null;
  readonly forwards: string[] = [];
  private rawBytes: Uint8Array | null;
  private failForward = false;

  constructor(init: {
    readonly to: string;
    readonly from: string;
    readonly raw: Uint8Array;
    readonly rawSize?: number;
  }) {
    this.to = init.to;
    this.from = init.from;
    this.rawSize = init.rawSize ?? init.raw.byteLength;
    this.rawBytes = init.raw;
  }

  failNextForward(): void {
    this.failForward = true;
  }

  async readRaw(): Promise<Uint8Array> {
    const bytes = this.rawBytes;
    if (bytes === null) {
      throw new Error("raw already consumed");
    }
    this.rawBytes = null;
    return bytes;
  }

  setReject(reason: string): void {
    this.rejectReason = reason;
  }

  async forward(rcptTo: string): Promise<unknown> {
    this.forwards.push(rcptTo);
    if (this.failForward) {
      this.failForward = false;
      throw new Error("forward_failed");
    }
    return { messageId: "forwarded" };
  }
}

export function indexAccountFromAsync(
  account: RpcAsync<
    Pick<
      AccountStoreRpc,
      | "getInboundReceipt"
      | "getAddressByMailbox"
      | "claimInboundReceipt"
      | "acceptInbound"
      | "completeInboundReceipt"
      | "failInboundReceiptPolicy"
    >
  >,
): IndexConsumerAccount {
  return {
    getInboundReceipt: (receiptId) => effectFromAsync(() => account.getInboundReceipt(receiptId)),
    getAddressByMailbox: (address) => effectFromAsync(() => account.getAddressByMailbox(address)),
    claimInboundReceipt: (input) => effectFromAsync(() => account.claimInboundReceipt(input)),
    acceptInbound: (input) => effectFromAsync(() => account.acceptInbound(input)),
    completeInboundReceipt: (receiptId) =>
      effectFromAsync(() => account.completeInboundReceipt(receiptId)),
    failInboundReceiptPolicy: (input) =>
      effectFromAsync(() => account.failInboundReceiptPolicy(input)),
  };
}

function effectFromAsync<A>(run: () => Promise<A>): Effect.Effect<A, IndexFailure> {
  return Effect.tryPromise({
    try: () => run(),
    catch: (cause) => indexFailureFromCause(cause),
  });
}
