import { createMailHtmlPolicy } from "@umail/mail-content";
import * as Cloudflare from "alchemy/Cloudflare";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AccountStore, OPERATOR_ACCOUNT } from "../account/worker.ts";
import { Api } from "../api/worker.ts";
import { MailArchive } from "./archive.ts";
import { indexReceipt } from "./process-index.ts";

export const MailIndex = Cloudflare.Queues.Queue("MailIndex");

export const IndexReceiptWork = Schema.Struct({
  version: Schema.Literal(1),
  receiptId: Schema.String,
});
export type IndexReceiptWork = typeof IndexReceiptWork.Type;

export class IndexConsumer extends Cloudflare.Worker<IndexConsumer, {}>()("IndexConsumer") {}

export default IndexConsumer.make(
  { main: import.meta.url, workersDev: false },
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const index = yield* MailIndex;
    const htmlPolicy = createMailHtmlPolicy();

    // One receipt per batch: alchemy acks it on success, and on failure logs the cause and retries.
    yield* Cloudflare.Queues.consumeQueueMessages(
      index,
      { batchSize: 1, maxConcurrency: 1 },
      (messages: Stream.Stream<Cloudflare.Queues.Message>) =>
        messages.pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const work = yield* Schema.decodeUnknownEffect(IndexReceiptWork)(message.body);
              const nowIso = DateTime.formatIso(yield* DateTime.now);
              const account = accounts.getByName(OPERATOR_ACCOUNT);
              yield* indexReceipt(work.receiptId, { archive, account, htmlPolicy, nowIso });
            }),
          ),
        ),
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Queues.EventSourceLive, Cloudflare.R2.ReadWriteBucketBinding),
    ),
  ),
);
