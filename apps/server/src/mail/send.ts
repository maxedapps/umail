import type { Message } from "@cloudflare/workers-types";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {
  parseExternalMailAddress,
  type ExternalMailAddress,
  type MailDomain,
} from "@umail/api-contract";
import { createMailHtmlPolicy, type MailHtmlPolicy } from "@umail/mail-content";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AccountStore, type AccountStoreRpc } from "../account/worker.ts";
import type { AccountStoreError } from "../account/errors.ts";
import type { CompleteAttemptOutcome, OutboundDispatch } from "../account/domain.ts";
import { Api } from "../api/worker.ts";
import { sendClaimUntilIso, SEND_CONSUMER_CONCURRENCY } from "./policy.ts";
import { ProvisionedOperator } from "../auth/auth-control.ts";
import { layoutForStage, rootDomain } from "../site.ts";
import {
  cloudflareEmailSender,
  materializeProviderMail,
  type EmailSender,
  type OutboundMail,
  type ProviderSendOutcome,
} from "./email-sender.ts";
import {
  NotificationJobIdentity,
  approvalNotificationMail,
  approvalReviewUrl,
  decryptNotificationPayload,
  notificationKeyringFromSecret,
  type NotificationKeyring,
} from "./notifications.ts";

export const MailSendDlq = Cloudflare.Queues.Queue("MailSendDlq");
export const MailSend = Cloudflare.Queues.Queue("MailSend");

export const SendJobWork = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
});
export type SendJobWork = typeof SendJobWork.Type;

const sendWorkerProps = Effect.gen(function* () {
  const props = { main: import.meta.url, workersDev: false };
  if (globalThis.__ALCHEMY_RUNTIME__) return props;
  const provisioned = yield* ProvisionedOperator;
  return { ...props, env: { AUTH_OPERATOR_ID: provisioned.operatorId } };
});

export class SendConsumer extends Cloudflare.Worker<SendConsumer, {}>()("SendConsumer") {}

export type SendConsumerAccount = Pick<
  AccountStoreRpc,
  "getOutboundDispatch" | "claimDispatch" | "completeAttempt" | "rejectReadyDispatch"
>;

export type SendOutcomeBuffer = {
  remember(attemptId: string, outcome: CompleteAttemptOutcome): void;
  recall(attemptId: string): CompleteAttemptOutcome | undefined;
};

export type SendNotificationConfig = {
  readonly keyring: NotificationKeyring;
  readonly applicationUrl: URL;
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
  readonly outcomes: SendOutcomeBuffer;
  readonly notification: SendNotificationConfig;
};

export function createSendOutcomeBuffer(): SendOutcomeBuffer {
  const remembered = new Map<string, CompleteAttemptOutcome>();
  return {
    remember(attemptId, outcome) {
      remembered.set(attemptId, outcome);
    },
    recall(attemptId) {
      return remembered.get(attemptId);
    },
  };
}

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
    Effect.matchCause({
      onFailure: () => {
        message.retry();
      },
      onSuccess: (decision) => {
        if (decision === "retry") {
          message.retry();
          return;
        }
        message.ack();
      },
    }),
  );
}

export function consumeSendJob(
  jobId: string,
  ports: SendConsumerPorts,
): Effect.Effect<"ack" | "retry", AccountStoreError> {
  return Effect.gen(function* () {
    const dispatch = yield* ports.account.getOutboundDispatch(jobId);
    if (dispatch === null) {
      return "ack";
    }
    if (
      dispatch.job.state === "accepted" ||
      dispatch.job.state === "rejected" ||
      dispatch.job.state === "unknown"
    ) {
      return "ack";
    }
    if (dispatch.job.state === "in_flight") {
      return yield* completeRememberedOutcome(dispatch, ports);
    }
    if (dispatch.job.state !== "ready") {
      return "ack";
    }

    const prepared = yield* prepareDispatchMail(dispatch, ports);
    if (prepared.kind === "retry") {
      return "retry";
    }
    if (prepared.kind === "reject") {
      yield* ports.account.rejectReadyDispatch({
        jobId: dispatch.job.jobId,
        nowIso: ports.nowIso,
        failureDetail: prepared.detail,
      });
      return "ack";
    }

    const claimed = yield* ports.account.claimDispatch({
      jobId: dispatch.job.jobId,
      nowIso: ports.nowIso,
      claimExpiresAt: ports.claimExpiresAt,
    });
    if (claimed.kind !== "claimed") {
      return "ack";
    }

    const sent = yield* ports.sender.send(prepared.mail);
    const outcome = completeOutcomeFromSend(sent);
    ports.outcomes.remember(claimed.attemptId, outcome);
    return yield* persistAttemptOutcome(dispatch.job.jobId, claimed.attemptId, outcome, ports);
  });
}

function completeRememberedOutcome(
  dispatch: OutboundDispatch,
  ports: SendConsumerPorts,
): Effect.Effect<"ack" | "retry"> {
  const attemptId = dispatch.job.attemptId;
  if (attemptId === null) return Effect.succeed("ack");
  const remembered = ports.outcomes.recall(attemptId);
  if (remembered === undefined) return Effect.succeed("ack");
  return persistAttemptOutcome(dispatch.job.jobId, attemptId, remembered, ports);
}

function persistAttemptOutcome(
  jobId: string,
  attemptId: string,
  outcome: CompleteAttemptOutcome,
  ports: SendConsumerPorts,
): Effect.Effect<"ack" | "retry"> {
  return ports.account
    .completeAttempt({ jobId, attemptId, nowIso: ports.nowIso, outcome })
    .pipe(Effect.match({ onFailure: () => "retry" as const, onSuccess: () => "ack" as const }));
}

type PreparedMail =
  | { readonly kind: "ready"; readonly mail: OutboundMail }
  | { readonly kind: "reject"; readonly detail: string }
  | { readonly kind: "retry" };

function prepareDispatchMail(
  dispatch: OutboundDispatch,
  ports: SendConsumerPorts,
): Effect.Effect<PreparedMail> {
  if (dispatch.job.purpose === "approval_notification") {
    return prepareNotificationMail(dispatch, ports);
  }
  const mail = messageMailFromDispatch(dispatch);
  if (mail === null) return Effect.succeed({ kind: "reject", detail: "missing_sender" });
  return materializePreparedMail(mail, ports);
}

function prepareNotificationMail(
  dispatch: OutboundDispatch,
  ports: SendConsumerPorts,
): Effect.Effect<PreparedMail> {
  return Effect.gen(function* () {
    const record = dispatch.notification;
    if (record === null) return { kind: "reject", detail: "missing_notification" };
    const identity = Schema.decodeSync(NotificationJobIdentity)({
      requesterClientId: dispatch.job.requester.clientId,
      requestId: dispatch.job.requestId,
      purpose: "approval_notification",
    });
    const decrypted = yield* Effect.tryPromise({
      try: () =>
        decryptNotificationPayload(
          { keyVersion: record.keyVersion, nonce: record.nonce, ciphertext: record.ciphertext },
          identity,
          ports.notification.keyring,
          ports.nowIso,
        ),
      catch: () => "retry" as const,
    }).pipe(Effect.result);
    if (Result.isFailure(decrypted)) return { kind: "retry" };
    if (decrypted.success.kind !== "ok") {
      return { kind: "reject", detail: decrypted.success.kind };
    }
    return yield* materializePreparedMail(
      approvalNotificationMail({
        mailDomain: ports.notification.mailDomain,
        approvalAdminEmail: ports.notification.approvalAdminEmail,
        expiresAt: decrypted.success.payload.expiresAt,
        reviewUrl: approvalReviewUrl(
          ports.notification.applicationUrl,
          decrypted.success.payload.token,
        ),
      }),
      ports,
    );
  });
}

function materializePreparedMail(
  mail: OutboundMail,
  ports: SendConsumerPorts,
): Effect.Effect<PreparedMail> {
  return materializeProviderMail(ports.htmlPolicy, ports.applicationUrl, mail).pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "reject", detail: error.reason }) as const,
      onSuccess: () => ({ kind: "ready", mail }) as const,
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

export function completeOutcomeFromSend(sent: ProviderSendOutcome): CompleteAttemptOutcome {
  if (sent.kind === "accepted") {
    return {
      kind: "accepted",
      providerMessageId: sent.providerMessageId,
      rfcMessageId: sent.rfcMessageId,
    };
  }
  if (sent.kind === "rejected" || sent.kind === "pre_dispatch") {
    return {
      kind: "rejected",
      failureClass: "provider",
      failureDetail: sent.detail,
    };
  }
  return { kind: "unknown" };
}

export default SendConsumer.make(
  sendWorkerProps,
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const sendQueue = yield* MailSend;
    const sendDlq = yield* MailSendDlq;
    const email = yield* Cloudflare.Email.Send(Cloudflare.Email.SendEmail("EMAIL"));
    const htmlPolicy = createMailHtmlPolicy();
    const stack = yield* Alchemy.Stack;
    const site = layoutForStage(yield* rootDomain, stack.stage);
    const applicationUrl = new URL(`https://${site.apiHostname}`);
    const operatorEmailRaw = yield* Config.string("UMAIL_OPERATOR_EMAIL");
    const operatorEmailParsed = parseExternalMailAddress(operatorEmailRaw);
    if (operatorEmailParsed.kind !== "ok") {
      throw new Error("UMAIL_OPERATOR_EMAIL is not a valid email address.");
    }
    const notificationSecret = yield* Config.redacted("UMAIL_NOTIFICATION_KEY");
    const notificationKeyring = notificationKeyringFromSecret(Redacted.value(notificationSecret));
    const sendOutcomes = createSendOutcomeBuffer();

    const sendMessages = (messages: Stream.Stream<Cloudflare.Queues.Message>) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const accountId = yield* Config.string("AUTH_OPERATOR_ID");
        const sender = yield* cloudflareEmailSender(email, htmlPolicy, applicationUrl);
        const account = accounts.getByName(accountId);
        yield* handleSendMessages(messages, {
          account,
          sender,
          htmlPolicy,
          applicationUrl,
          nowIso: DateTime.formatIso(now),
          claimExpiresAt: sendClaimUntilIso(nowMs),
          outcomes: sendOutcomes,
          notification: {
            keyring: notificationKeyring,
            applicationUrl,
            mailDomain: site.mailDomain,
            approvalAdminEmail: operatorEmailParsed.address,
          },
        });
      });

    const consumerOptions = { maxRetries: 4, deadLetterQueue: sendDlq.queueName };
    // beta.77 types this field as string although queue names are deferred outputs.
    yield* Cloudflare.Queues.consumeQueueMessages(
      sendQueue,
      consumerOptions as Cloudflare.Queues.MessagesProps & typeof consumerOptions,
      sendMessages,
    );

    return {};
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.Queues.EventSourceLive, Cloudflare.Email.SendBinding)),
  ),
);
