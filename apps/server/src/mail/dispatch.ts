import type { ExternalMailAddress, MailDomain, PrincipalPolicy } from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { MailHtmlPolicy } from "./html-policy.ts";
import type { OutboundDispatch, OutboundRequester } from "../account/domain.ts";
import { claimJob, completeAttempt, readDispatch, rejectUndispatched } from "../account/jobs.ts";
import type { AccountSqliteStorage } from "../account/sqlite.ts";
import {
  materializeProviderMail,
  type EmailSender,
  type OutboundMail,
  type ProviderOutboundMail,
} from "./email-sender.ts";
import {
  approvalNotificationMail,
  approvalReviewUrl,
  deriveApprovalToken,
  type NotificationKey,
} from "./notifications.ts";
import { sendClaimUntilIso } from "./policy.ts";

export type DispatchPorts = {
  readonly sender: EmailSender;
  readonly htmlPolicy: MailHtmlPolicy;
  readonly applicationUrl: URL;
  readonly notification: {
    readonly key: NotificationKey;
    readonly mailDomain: MailDomain;
    readonly approvalAdminEmail: ExternalMailAddress;
  };
  // The requester's current policy, or null once it has no access.
  readonly policyFor: (requester: OutboundRequester) => Effect.Effect<PrincipalPolicy | null>;
};

// Sends one ready job. At-most-once: the provider is called only after `claimJob` moves the job out
// of `ready`; a job interrupted after its claim settles `unknown` and is never sent again.
export function dispatchJob(
  storage: AccountSqliteStorage,
  jobId: string,
  ports: DispatchPorts,
  nowMs: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const dispatch = yield* Effect.sync(() => readDispatch(storage, jobId));
    if (dispatch === null || dispatch.job.state !== "ready") {
      return;
    }
    const prepared = yield* prepareDispatchMail(dispatch, ports);
    if (prepared.kind === "reject") {
      yield* Effect.sync(() =>
        rejectUndispatched(
          storage,
          [dispatch.job.messageId],
          { failureClass: "policy", failureDetail: prepared.detail },
          nowIso,
        ),
      );
      return;
    }
    const policy = yield* ports.policyFor(dispatch.job.requester);
    const claimed = yield* Effect.sync(() =>
      claimJob(storage, { jobId, nowIso, claimExpiresAt: sendClaimUntilIso(nowMs), policy }),
    );
    if (claimed.kind !== "claimed") {
      return;
    }
    const outcome = yield* ports.sender.send(prepared.mail);
    yield* Effect.sync(() =>
      completeAttempt(storage, { jobId, attemptId: claimed.attemptId, nowIso, outcome }),
    );
  });
}

type PreparedMail =
  | { readonly kind: "ready"; readonly mail: ProviderOutboundMail }
  | { readonly kind: "reject"; readonly detail: string };

// Builds the exact provider mail before the claim, so mail that can never be sent is rejected
// without an attempt.
function prepareDispatchMail(
  dispatch: OutboundDispatch,
  ports: DispatchPorts,
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
  ports: DispatchPorts,
): Effect.Effect<PreparedMail> {
  return materializeProviderMail(ports.htmlPolicy, ports.applicationUrl, mail).pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "reject", detail: error.reason }) as const,
      onSuccess: (providerMail) => ({ kind: "ready", mail: providerMail }) as const,
    }),
  );
}

function messageMailFromDispatch(dispatch: OutboundDispatch): OutboundMail | null {
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
