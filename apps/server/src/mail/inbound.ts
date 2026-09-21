import type { InboundReceipt } from "../account/domain.ts";
import { parseMailboxAddress } from "@umail/api-contract";
import * as Cloudflare from "alchemy/Cloudflare";
import type { RpcAsync } from "alchemy/Cloudflare/Bridge";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccountStore, type AccountStoreRpc } from "../account/worker.ts";
import { Api } from "../api/worker.ts";
import { ProvisionedOperator } from "../auth/auth-control.ts";
import { MailArchive } from "./archive.ts";
import { MailIndex } from "./indexing.ts";

import { type Envelope, type IndexReceiptWork } from "./index-payload.ts";
import { defaultInboundPolicy, isOversize, type InboundPolicy } from "./policy.ts";
import { archiveInboundReceipt, type ReceiptArchive } from "./archive.ts";

export type InboundMessage = {
  readonly to: string;
  readonly from: string;
  readonly rawSize: number;
  readRaw(): Promise<Uint8Array>;
  setReject(reason: string): void;
  forward(rcptTo: string): Promise<unknown>;
};

export type InboundArchive = ReceiptArchive;

export interface InboundIndex {
  send(payload: IndexReceiptWork): Promise<void>;
}

export type InboundAccount = Pick<
  RpcAsync<AccountStoreRpc>,
  | "registerInboundReceipt"
  | "observeInboundForward"
  | "getInboundReceipt"
  | "getAddressByMailbox"
  | "getDestination"
>;

export interface InboundPorts {
  readonly ARCHIVE: InboundArchive;
  readonly INDEX: InboundIndex;
  readonly ACCOUNT: InboundAccount;
  readonly nowIso: () => string;
}

export type InboundDisposition =
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "accepted"; readonly digest: string; readonly key: string };

export async function processInbound(
  message: InboundMessage,
  ports: InboundPorts,
  policy: InboundPolicy = defaultInboundPolicy,
): Promise<InboundDisposition> {
  if (isOversize(message.rawSize, policy.maxRawBytes)) {
    return reject(message, "message too large");
  }

  const normalized = parseMailboxAddress(message.to);
  if (normalized.kind === "invalid") {
    return reject(message, "unknown recipient");
  }

  const active = await lookupActiveAddress(ports.ACCOUNT, normalized.address);
  if (active === null) {
    return reject(message, "unknown recipient");
  }

  const bytes = await message.readRaw();
  if (isOversize(bytes.byteLength, policy.maxRawBytes)) {
    return reject(message, "message too large");
  }

  const envelope = {
    from: message.from,
    to: normalized.address,
  } satisfies Envelope;
  const archived = await archiveInboundReceipt(ports.ARCHIVE, {
    envelope,
    advertisedRawSize: message.rawSize,
    bytes,
    receivedAt: ports.nowIso(),
  });
  const registered = await ports.ACCOUNT.registerInboundReceipt({
    receiptId: archived.receiptId,
    digest: archived.digest,
    envelopeFrom: archived.envelope.from,
    envelopeTo: archived.envelope.to,
    rawKey: archived.rawKey,
    manifestKey: archived.manifestKey,
    advertisedRawSize: archived.advertisedRawSize,
    consumedBytes: archived.consumedBytes,
    receivedAt: archived.receivedAt,
  });
  await observeNativeForward(message, ports.ACCOUNT, registered.receipt, active.destination);
  await ports.INDEX.send({
    version: 1,
    receiptId: archived.receiptId,
  });

  return { kind: "accepted", digest: archived.digest, key: archived.rawKey };
}

export class Inbound extends Cloudflare.Worker<Inbound, {}>()("Inbound") {}

export default Inbound.make(
  Effect.gen(function* () {
    const props = { main: import.meta.url, workersDev: false };
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const provisioned = yield* ProvisionedOperator;
    return { ...props, env: { AUTH_OPERATOR_ID: provisioned.operatorId } };
  }),
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    // Routing stays in the stack so its existing resource identities and stage policy are preserved.
    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        const accountId = yield* Config.string("AUTH_OPERATOR_ID");
        const account = accounts.getByName(accountId);
        const rawArchive = yield* archive.raw;
        const rawIndex = yield* index.raw;
        // The ingestion algorithm is async; preserve the event context at its RPC boundary.
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        yield* Effect.promise(() =>
          processInbound(
            {
              to: message.to,
              from: message.from,
              rawSize: message.bodySize,
              async readRaw() {
                return new Uint8Array(await new Response(message.raw.raw).arrayBuffer());
              },
              setReject: (reason) => message.raw.setReject(reason),
              forward: (recipient) => message.raw.forward(recipient),
            },
            {
              ARCHIVE: {
                async put(key, bytes) {
                  await rawArchive.put(key, bytes);
                },
                async get(key) {
                  const object = await rawArchive.get(key);
                  return object === null ? null : new Uint8Array(await object.arrayBuffer());
                },
              },
              INDEX: {
                async send(payload) {
                  await rawIndex.send(payload);
                },
              },
              ACCOUNT: {
                registerInboundReceipt: (input) => run(account.registerInboundReceipt(input)),
                observeInboundForward: (input) => run(account.observeInboundForward(input)),
                getInboundReceipt: (id) => run(account.getInboundReceipt(id)),
                getAddressByMailbox: (address) => run(account.getAddressByMailbox(address)),
                getDestination: (id) => run(account.getDestination(id)),
              },
              nowIso: () => new Date().toISOString(),
            },
          ),
        );
      }).pipe(Effect.asVoid),
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

function reject(message: InboundMessage, reason: string): InboundDisposition {
  message.setReject(reason);
  return { kind: "rejected", reason };
}

async function lookupActiveAddress(
  account: InboundAccount,
  address: string,
): Promise<ActiveAddress | null> {
  const mailbox = await account.getAddressByMailbox(address);
  if (mailbox === null || mailbox.active !== true) {
    return null;
  }
  if (mailbox.forwardingDestinationId === null) {
    return { destination: null };
  }
  const destination = await account.getDestination(mailbox.forwardingDestinationId);
  if (destination === null || destination.verificationStatus !== "verified") {
    return { destination: null };
  }
  return { destination: destination.email };
}

type ActiveAddress = {
  readonly destination: string | null;
};

async function observeNativeForward(
  message: InboundMessage,
  account: InboundAccount,
  receipt: InboundReceipt,
  destination: string | null,
): Promise<void> {
  if (destination === null || receipt.forward.kind !== "none") {
    return;
  }
  await account.observeInboundForward({
    receiptId: receipt.receiptId,
    observation: { kind: "unknown", destination },
  });
  try {
    await message.forward(destination);
  } catch {
    await account.observeInboundForward({
      receiptId: receipt.receiptId,
      observation: { kind: "failure", destination, error: "forward_failed" },
    });
    return;
  }
  await account.observeInboundForward({
    receiptId: receipt.receiptId,
    observation: { kind: "success", destination },
  });
}
