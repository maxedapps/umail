import * as Cloudflare from "alchemy/Cloudflare";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccountStore, OPERATOR_ACCOUNT, type AccountStoreRpc } from "../account/worker.ts";
import { Api } from "../api/worker.ts";
import { MailIndex, type IndexReceiptWork } from "./indexing.ts";
import { MailSend, type SendJobWork } from "./send.ts";

export const MAIL_RECOVERY_CRON = "* * * * *";
const RECOVERY_PAGE_SIZE = 50;

export type RecoveryPorts<R> = {
  readonly account: Pick<AccountStoreRpc, "redriveDueInboundReceipts" | "recoverOutbound">;
  readonly index: { send(body: IndexReceiptWork): Effect.Effect<void, Error, R> };
  readonly send: { send(body: SendJobWork): Effect.Effect<void, Error, R> };
};

// Re-publishes work a queue lost or never received: due inbound receipts to MailIndex and ready
// send jobs to MailSend. Both consumers are idempotent, so a repeated publish is harmless.
export const runMailRecovery = <R>(ports: RecoveryPorts<R>, nowIso: string) =>
  Effect.gen(function* () {
    const receiptIds = yield* ports.account.redriveDueInboundReceipts({
      nowIso,
      limit: RECOVERY_PAGE_SIZE,
    });
    for (const receiptId of receiptIds) {
      yield* ports.index.send({ version: 1, receiptId });
    }
    const jobIds = yield* ports.account.recoverOutbound({ nowIso, limit: RECOVERY_PAGE_SIZE });
    for (const jobId of jobIds) {
      yield* ports.send.send({ version: 1, jobId });
    }
  });

export class Recovery extends Cloudflare.Worker<Recovery, {}>()("Recovery") {}

export default Recovery.make(
  { main: import.meta.url, workersDev: false },
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    const send = yield* Cloudflare.Queues.WriteQueue(MailSend);
    // alchemy swallows a failed cron run, so the failure is logged here.
    yield* Cloudflare.cron(MAIL_RECOVERY_CRON, (controller) =>
      runMailRecovery(
        { account: accounts.getByName(OPERATOR_ACCOUNT), index, send },
        DateTime.formatIso(DateTime.makeUnsafe(controller.scheduledTime)),
      ).pipe(Effect.tapCause((cause) => Effect.logError("Mail recovery failed", cause))),
    );
    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.CronEventSourceLive, Cloudflare.Queues.WriteQueueBinding),
    ),
  ),
);
