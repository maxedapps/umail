import { parseMailboxAddress } from "@umail/api-contract";
import * as Cloudflare from "alchemy/Cloudflare";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AccountStoreError } from "../account/errors.ts";
import { AccountStore, OPERATOR_ACCOUNT, type AccountStoreRpc } from "../account/worker.ts";
import { Api } from "../api/worker.ts";
import { inboundMessageId, MailArchive } from "./archive.ts";
import { MailIndex, type IndexReceiptWork } from "./indexing.ts";
import { DEFAULT_MAX_RAW_BYTES, rawObjectKey, sha256Hex } from "./policy.ts";

// The slice of alchemy's email message, R2 bucket and queue clients that reception uses.
export type InboundMessage = Pick<
  Cloudflare.ForwardableEmailMessage,
  "from" | "to" | "bodySize" | "setReject"
> & {
  // Anything a Response can read the raw bytes from; alchemy passes the SMTP body stream.
  readonly body: ConstructorParameters<typeof Response>[0];
  forward(rcptTo: string): Effect.Effect<void, Error>;
};

export type InboundDeps<R> = {
  readonly archive: { put(key: string, value: Uint8Array): Effect.Effect<unknown, Error, R> };
  readonly index: { send(body: IndexReceiptWork): Effect.Effect<void, Error, R> };
  readonly account: Pick<
    AccountStoreRpc,
    "getAddressByMailbox" | "getDestination" | "registerInboundReceipt" | "observeInboundForward"
  >;
  readonly nowIso: string;
};

// Any failure here fails the email handler, which Cloudflare turns into a temporary SMTP failure
// so the sender retries. Only a failed native forward is recorded and accepted.
export const receiveInbound = <R>(
  message: InboundMessage,
  deps: InboundDeps<R>,
): Effect.Effect<void, Error | AccountStoreError, R> =>
  Effect.gen(function* () {
    if (message.bodySize > DEFAULT_MAX_RAW_BYTES) {
      return yield* message.setReject("message too large");
    }
    const recipient = parseMailboxAddress(message.to);
    if (recipient.kind === "invalid") {
      return yield* message.setReject("unknown recipient");
    }
    const mailbox = yield* deps.account.getAddressByMailbox(recipient.address);
    if (mailbox === null || !mailbox.active) {
      return yield* message.setReject("unknown recipient");
    }
    const bytes = new Uint8Array(
      yield* Effect.promise(() => new Response(message.body).arrayBuffer()),
    );
    if (bytes.byteLength > DEFAULT_MAX_RAW_BYTES) {
      return yield* message.setReject("message too large");
    }

    const digest = yield* Effect.promise(() => sha256Hex(bytes));
    const envelope = { from: message.from, to: recipient.address };
    const receiptId = yield* Effect.promise(() => inboundMessageId(digest, envelope));
    const rawKey = rawObjectKey(digest);
    yield* deps.archive.put(rawKey, bytes);
    yield* deps.account.registerInboundReceipt({
      receiptId,
      envelopeFrom: envelope.from,
      envelopeTo: envelope.to,
      rawKey,
      receivedAt: deps.nowIso,
    });

    const destination =
      mailbox.forwardingDestinationId === null
        ? null
        : yield* deps.account.getDestination(mailbox.forwardingDestinationId);
    if (destination?.verificationStatus === "verified") {
      yield* forwardOnce(message, deps.account, receiptId, destination.email);
    }
    yield* deps.index.send({ version: 1, receiptId });
  });

// `none -> unknown` applies once per receipt, so a redelivered or replayed envelope never
// forwards twice. An interrupted forward stays `unknown`.
const forwardOnce = (
  message: InboundMessage,
  account: InboundDeps<never>["account"],
  receiptId: string,
  destination: string,
) =>
  Effect.gen(function* () {
    const claimed = yield* account.observeInboundForward({
      receiptId,
      observation: { kind: "unknown", destination },
    });
    if (!claimed) return;
    const observation = yield* message.forward(destination).pipe(
      Effect.as({ kind: "success", destination } as const),
      Effect.catch((error) =>
        Effect.logWarning("Inbound forward failed", error).pipe(
          Effect.annotateLogs({ receiptId, destination }),
          Effect.as({ kind: "failure", destination } as const),
        ),
      ),
    );
    yield* account.observeInboundForward({ receiptId, observation });
  });

export class Inbound extends Cloudflare.Worker<Inbound, {}>()("Inbound") {}

export default Inbound.make(
  { main: import.meta.url, workersDev: false },
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    // Routing stays in the stack so its existing resource identities and stage policy are preserved.
    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const account = accounts.getByName(OPERATOR_ACCOUNT);
        yield* receiveInbound(message, { archive, index, account, nowIso });
      }),
    );
    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.EmailEventSourceLive,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
      ),
    ),
  ),
);
