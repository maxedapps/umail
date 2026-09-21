import type { Message } from "@cloudflare/workers-types";
import { createMailHtmlPolicy } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { IndexReceiptWork } from "./index-payload.ts";
import {
  consumeIndexReceipt,
  IndexFailure,
  type ArchiveStore,
  type IndexConsumerAccount,
  ArchiveError,
} from "./process-index.ts";

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { AccountStore } from "../account/worker.ts";
import { Api } from "../api/worker.ts";
import { MailArchive } from "./archive.ts";
import { receiptClaimUntilIso } from "./policy.ts";
import { ProvisionedOperator } from "../auth/auth-control.ts";

export const MailIndexDlq = Cloudflare.Queues.Queue("MailIndexDlq");
export const MailIndex = Cloudflare.Queues.Queue("MailIndex");

const indexWorkerProps = Effect.gen(function* () {
  const props = { main: import.meta.url, workersDev: false };
  if (globalThis.__ALCHEMY_RUNTIME__) return props;
  const provisioned = yield* ProvisionedOperator;
  return { ...props, env: { AUTH_OPERATOR_ID: provisioned.operatorId } };
});

export class IndexConsumer extends Cloudflare.Worker<IndexConsumer, {}>()("IndexConsumer") {}

export type IndexConsumerPorts<R = never> = {
  readonly archive: ArchiveStore<R>;
  readonly account: IndexConsumerAccount;
  readonly nowIso: string;
  readonly claimUntilIso: string;
};

const MessageConflictTag = Schema.Struct({
  _tag: Schema.Literal("MessageConflictError"),
});

export const handleIndexMessages = <R = never>(
  messages: Stream.Stream<Message>,
  ports: IndexConsumerPorts<R>,
  htmlPolicy = createMailHtmlPolicy(),
): Effect.Effect<void, never, R> =>
  messages.pipe(Stream.runForEach((message) => settleIndexMessage(message, ports, htmlPolicy)));

function settleIndexMessage<R>(
  message: Message,
  ports: IndexConsumerPorts<R>,
  htmlPolicy: ReturnType<typeof createMailHtmlPolicy>,
): Effect.Effect<void, never, R> {
  return Schema.decodeUnknownEffect(IndexReceiptWork)(message.body).pipe(
    Effect.flatMap((work) =>
      consumeIndexReceipt(
        work.receiptId,
        ports.archive,
        htmlPolicy,
        ports.account,
        ports.nowIso,
        ports.claimUntilIso,
      ),
    ),
    Effect.match({
      onFailure: () => {
        message.retry();
      },
      onSuccess: () => {
        message.ack();
      },
    }),
  );
}

export function indexFailureFromCause(cause: unknown): IndexFailure {
  const tagged = Schema.decodeUnknownResult(MessageConflictTag)(cause);
  if (Result.isSuccess(tagged)) {
    return new IndexFailure({ reason: "duplicate" });
  }
  return new IndexFailure({ reason: "sql_failed" });
}

export default IndexConsumer.make(
  indexWorkerProps,
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const index = yield* MailIndex;
    const dlq = yield* MailIndexDlq;
    const htmlPolicy = createMailHtmlPolicy();

    const indexMessages = (messages: Stream.Stream<Cloudflare.Queues.Message>) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const accountId = yield* Config.string("AUTH_OPERATOR_ID");
        const account = accounts.getByName(accountId);
        const indexAccount = {
          getInboundReceipt: (receiptId) =>
            account.getInboundReceipt(receiptId).pipe(Effect.mapError(indexFailureFromCause)),
          getAddressByMailbox: (address) =>
            account.getAddressByMailbox(address).pipe(Effect.mapError(indexFailureFromCause)),
          claimInboundReceipt: (input) =>
            account.claimInboundReceipt(input).pipe(Effect.mapError(indexFailureFromCause)),
          acceptInbound: (input) =>
            account.acceptInbound(input).pipe(Effect.mapError(indexFailureFromCause)),
          completeInboundReceipt: (receiptId) =>
            account.completeInboundReceipt(receiptId).pipe(Effect.mapError(indexFailureFromCause)),
          failInboundReceiptPolicy: (input) =>
            account.failInboundReceiptPolicy(input).pipe(Effect.mapError(indexFailureFromCause)),
        } satisfies IndexConsumerAccount;
        yield* handleIndexMessages(
          messages,
          {
            archive: {
              get: (key) =>
                archive.get(key).pipe(
                  Effect.flatMap((object) => {
                    if (object === null) return Effect.succeed(null);
                    return object.arrayBuffer();
                  }),
                  Effect.mapError(() => new ArchiveError({ reason: "read_failed" })),
                ),
              put: (key, bytes) =>
                archive.put(key, bytes).pipe(
                  Effect.asVoid,
                  Effect.mapError(() => new ArchiveError({ reason: "write_failed" })),
                ),
            },
            account: indexAccount,
            nowIso: DateTime.formatIso(now),
            claimUntilIso: receiptClaimUntilIso(nowMs),
          },
          htmlPolicy,
        );
      });

    const consumerOptions = {
      batchSize: 1,
      maxConcurrency: 1,
      maxRetries: 4,
      deadLetterQueue: dlq.queueName,
    };
    // beta.77 types this field as string although queue names are deferred outputs.
    yield* Cloudflare.Queues.consumeQueueMessages(
      index,
      consumerOptions as Cloudflare.Queues.MessagesProps & typeof consumerOptions,
      indexMessages,
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Queues.EventSourceLive, Cloudflare.R2.ReadWriteBucketBinding),
    ),
  ),
);
