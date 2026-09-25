import type * as Crypto from "effect/Crypto";
import type { RpcAsync } from "alchemy/Cloudflare/Bridge";
import type { AccountStoreRpc } from "../../src/account/worker.ts";
import {
  MailHtmlPolicyError,
  type MailHtmlMaterialization,
  type MailHtmlPolicy,
  type MailHtmlSanitization,
  type StoredMailHtml,
} from "../../src/mail/html-policy.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { InboundMessage } from "../../src/mail/inbound.ts";
import { WebCrypto } from "../../src/crypto.ts";

// Runs an Effect that needs Crypto, as the Worker would, for Promise-based specs.
export function runWithCrypto<A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(WebCrypto)));
}

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

// The Promise-based R2 bucket of the test runtime, in the shape of alchemy's Effect bucket client.
export type PromiseBucket = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
};

export function effectBucket(bucket: PromiseBucket) {
  return {
    get: (key: string) =>
      Effect.promise(() => bucket.get(key)).pipe(
        Effect.map((object) =>
          object === null
            ? null
            : { arrayBuffer: () => Effect.promise(() => object.arrayBuffer()) },
        ),
      ),
    put: (key: string, value: Uint8Array) => Effect.promise(() => bucket.put(key, value)),
  };
}

export type MailAccount = Pick<
  AccountStoreRpc,
  | "registerInboundReceipt"
  | "observeInboundForward"
  | "getAddressByMailbox"
  | "getInboundReceipt"
  | "acceptInbound"
  | "failInboundReceiptPolicy"
>;

// The mail test host answers plain Promises over DO RPC; the pipeline calls AccountStore Effects.
export function effectAccount(stub: RpcAsync<MailAccount>): MailAccount {
  return {
    registerInboundReceipt: (input) => Effect.promise(() => stub.registerInboundReceipt(input)),
    observeInboundForward: (input) => Effect.promise(() => stub.observeInboundForward(input)),
    getAddressByMailbox: (address) => Effect.promise(() => stub.getAddressByMailbox(address)),
    getInboundReceipt: (id) => Effect.promise(() => stub.getInboundReceipt(id)),
    acceptInbound: (input) => Effect.promise(() => stub.acceptInbound(input)),
    failInboundReceiptPolicy: (input) => Effect.promise(() => stub.failInboundReceiptPolicy(input)),
  };
}

export class FakeEmail implements InboundMessage {
  readonly to: string;
  readonly from: string;
  readonly bodySize: number;
  readonly body: Uint8Array;
  rejectReason: string | null = null;
  readonly forwards: string[] = [];
  private failForward = false;

  constructor(init: {
    readonly to: string;
    readonly from: string;
    readonly raw: Uint8Array;
    readonly rawSize?: number;
  }) {
    this.to = init.to;
    this.from = init.from;
    this.bodySize = init.rawSize ?? init.raw.byteLength;
    this.body = init.raw;
  }

  failNextForward(): void {
    this.failForward = true;
  }

  setReject(reason: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.rejectReason = reason;
    });
  }

  forward(rcptTo: string): Effect.Effect<void, ForwardRejected> {
    return Effect.suspend(() => {
      this.forwards.push(rcptTo);
      if (!this.failForward) return Effect.void;
      this.failForward = false;
      return Effect.fail(new ForwardRejected());
    });
  }
}

class ForwardRejected extends Data.TaggedError("ForwardRejected") {}
