import type { Message } from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import { type ExternalMailAddress, type MailDomain } from "@umail/api-contract";
import { createMailHtmlPolicy, type MailHtmlPolicy } from "@umail/mail-content";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AccountStore, OPERATOR_ACCOUNT, type AccountStoreRpc } from "../account/worker.ts";
import type { AccountStoreError } from "../account/errors.ts";
import type { OutboundDispatch } from "../account/domain.ts";
import { Api } from "../api/worker.ts";
import { sendClaimUntilIso, SEND_CONSUMER_CONCURRENCY } from "./policy.ts";
import { currentSite, operatorEmail } from "../site.ts";
import {
  cloudflareEmailSender,
  materializeProviderMail,
  type EmailSender,
  type OutboundMail,
  type ProviderOutboundMail,
} from "./email-sender.ts";
import {
  approvalNotificationMail,
  approvalReviewUrl,
  deriveApprovalToken,
  notificationKeyFromSecret,
  type NotificationKey,
} from "./notifications.ts";

export const MailSend = Cloudflare.Queues.Queue("MailSend");

export const SendJobWork = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
});
export type SendJobWork = typeof SendJobWork.Type;

export class SendConsumer extends Cloudflare.Worker<SendConsumer, {}>()("SendConsumer") {}

export type SendConsumerAccount = Pick<
  AccountStoreRpc,
  "getOutboundDispatch" | "claimDispatch" | "completeAttempt" | "rejectReadyDispatch"
>;

export type SendNotificationConfig = {
  readonly key: NotificationKey;
  readonly mailDomain: MailDomain;
  readonly approvalAdminEmail: ExternalMailAddress;
};

export type SendConsumerPorts = {
  readonly account: SendConsumerAccount;
  readonly sender: EmailSender;
  readonly htmlPolicy: MailHtmlPolicy;
  readonly applicationUrl: URL;
  readonly nowIso: string;
  readonly claimExpiresAt: string;
  readonly notification: SendNotificationConfig;
};

export const handleSendMessages = (
  messages: Stream.Stream<Message>,
  ports: SendConsumerPorts,
): Effect.Effect<void> =>
  messages.pipe(
    Stream.mapEffect((message) => settleSendMessage(message, ports), {
      concurrency: SEND_CONSUMER_CONCURRENCY,
      unordered: true,
    }),
    Stream.runDrain,
  );

function settleSendMessage(message: Message, ports: SendConsumerPorts): Effect.Effect<void> {
  return Schema.decodeUnknownEffect(SendJobWork)(message.body).pipe(
    Effect.flatMap((work) => consumeSendJob(work.jobId, ports)),
    Effect.tapCause((cause) =>
      Effect.logWarning("Send job failed; retrying", cause).pipe(
        Effect.annotateLogs({ messageId: message.id, attempts: message.attempts }),
      ),
    ),
    Effect.matchCause({
      onFailure: () => message.retry(),
      onSuccess: () => message.ack(),
    }),
  );
}

// At-most-once: the provider is called only after `claimDispatch` moves the job out of `ready`.
// A job found `in_flight` is never sent again; Recovery settles it `unknown` once the claim expires.
export function consumeSendJob(
  jobId: string,
  ports: SendConsumerPorts,
): Effect.Effect<void, AccountStoreError> {
  return Effect.gen(function* () {
    const dispatch = yield* ports.account.getOutboundDispatch(jobId);
    if (dispatch === null || dispatch.job.state !== "ready") {
      return;
    }
    const prepared = yield* prepareDispatchMail(dispatch, ports);
    if (prepared.kind === "reject") {
      yield* ports.account.rejectReadyDispatch({
        jobId,
        nowIso: ports.nowIso,
        failureDetail: prepared.detail,
      });
      return;
    }
    const claimed = yield* ports.account.claimDispatch({
      jobId,
      nowIso: ports.nowIso,
      claimExpiresAt: ports.claimExpiresAt,
    });
    if (claimed.kind !== "claimed") {
      return;
    }
    const outcome = yield* ports.sender.send(prepared.mail);
    yield* ports.account
      .completeAttempt({ jobId, attemptId: claimed.attemptId, nowIso: ports.nowIso, outcome })
      .pipe(Effect.retry({ times: 2 }));
  });
}

type PreparedMail =
  | { readonly kind: "ready"; readonly mail: ProviderOutboundMail }
  | { readonly kind: "reject"; readonly detail: string };

// Builds the exact provider mail once, before the claim, so a mail that can never be sent is
// rejected without an attempt.
function prepareDispatchMail(
  dispatch: OutboundDispatch,
  ports: SendConsumerPorts,
): Effect.Effect<PreparedMail> {
  return Effect.gen(function* () {
    if (dispatch.job.purpose === "approval_notification") {
      const approval = dispatch.approval;
      if (approval === null) return { kind: "reject", detail: "approval_unavailable" };
      const token = yield* Effect.promise(() =>
        deriveApprovalToken(ports.notification.key, approval.approvalId),
      );
      return yield* materializePreparedMail(
        approvalNotificationMail({
          mailDomain: ports.notification.mailDomain,
          approvalAdminEmail: ports.notification.approvalAdminEmail,
          expiresAt: approval.expiresAt,
          reviewUrl: approvalReviewUrl(ports.applicationUrl, token),
        }),
        ports,
      );
    }
    const mail = messageMailFromDispatch(dispatch);
    if (mail === null) return { kind: "reject", detail: "missing_sender" };
    return yield* materializePreparedMail(mail, ports);
  });
}

function materializePreparedMail(
  mail: OutboundMail,
  ports: SendConsumerPorts,
): Effect.Effect<PreparedMail> {
  return materializeProviderMail(ports.htmlPolicy, ports.applicationUrl, mail).pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "reject", detail: error.reason }) as const,
      onSuccess: (providerMail) => ({ kind: "ready", mail: providerMail }) as const,
    }),
  );
}

export function messageMailFromDispatch(dispatch: OutboundDispatch): OutboundMail | null {
  const from = dispatch.from;
  if (from === null) {
    return null;
  }
  const replyTo = dispatch.replyTo ?? from;
  const html =
    dispatch.htmlBody === null
      ? null
      : { body: dispatch.htmlBody, hasRemoteImages: dispatch.hasRemoteImages };
  return {
    from: { email: from.address, name: from.displayName },
    replyTo: { email: replyTo.address, name: replyTo.displayName },
    to: dispatch.to.map((contact) => contact.address),
    cc: dispatch.cc.map((contact) => contact.address),
    subject: dispatch.subject,
    text: dispatch.textBody,
    html,
    inReplyTo: dispatch.inReplyToHeader,
    references: dispatch.referencesHeader,
  };
}

export default SendConsumer.make(
  { main: import.meta.url, workersDev: false },
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const sendQueue = yield* MailSend;
    const email = yield* Cloudflare.Email.Send(Cloudflare.Email.SendEmail("EMAIL"));
    const htmlPolicy = createMailHtmlPolicy();
    const site = yield* currentSite;
    const applicationUrl = new URL(`https://${site.apiHostname}`);
    const approvalAdminEmail = yield* operatorEmail;
    const notificationSecret = yield* Config.redacted("UMAIL_NOTIFICATION_KEY");
    const notificationKey = notificationKeyFromSecret(Redacted.value(notificationSecret));

    const sendMessages = (messages: Stream.Stream<Cloudflare.Queues.Message>) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sender = yield* cloudflareEmailSender(email);
        yield* handleSendMessages(messages, {
          account: accounts.getByName(OPERATOR_ACCOUNT),
          sender,
          htmlPolicy,
          applicationUrl,
          nowIso: DateTime.formatIso(now),
          claimExpiresAt: sendClaimUntilIso(DateTime.toEpochMillis(now)),
          notification: {
            key: notificationKey,
            mailDomain: site.mailDomain,
            approvalAdminEmail,
          },
        });
      });

    yield* Cloudflare.Queues.consumeQueueMessages(sendQueue, { maxRetries: 4 }, sendMessages);

    return {};
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.Queues.EventSourceLive, Cloudflare.Email.SendBinding)),
  ),
);
