import { toAccountStoreError } from "../../src/account/errors.ts";
import type {
  ClaimDispatchInput,
  ClaimDispatchResult,
  CompleteAttemptInput,
  CompleteAttemptResult,
  OutboundDispatch,
  OutboundJob,
  RejectReadyDispatchInput,
  RejectReadyDispatchResult,
} from "../../src/account/domain.ts";
import {
  generateApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
} from "@umail/api-contract";
import { createMailHtmlPolicy, type MailHtmlPolicy } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  classifyProviderFailure,
  optionalRfcMessageId,
  type EmailSender,
  type OutboundMail,
  type ProviderSendOutcome,
} from "../../src/mail/email-sender.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  createNotificationKeyring,
  encryptNotificationPayload,
  notificationKeyringFromSecret,
  randomNotificationSecret,
} from "../../src/mail/notifications.ts";
import {
  consumeSendJob,
  handleSendMessages,
  createSendOutcomeBuffer,
  type SendConsumerPorts,
} from "../../src/mail/send.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const CLAIM_EXPIRES = "2026-01-01T00:15:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const APPLICATION_URL = new URL("https://umail.example.com");
const MAIL_DOMAIN = requireMailDomain("umail.example.com");
const ADMIN = requireExternal("operator@umail.example.com");

describe("send consumer", () => {
  it("dispatches once for duplicate queue delivery of a ready job", async () => {
    const world = createWorld();
    const job = world.seedReady();

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");

    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("accepted");
    expect(world.account.job(job.jobId)?.providerMessageId).toBe("prov-1");
  });

  it("retries a failed send effect and never dispatches the claimed job again", async () => {
    const world = createWorld();
    const job = world.seedReady();
    let deliveries = 0;
    let retried = false;
    let acked = false;
    const ports: SendConsumerPorts = {
      ...world.ports,
      sender: {
        send: () =>
          Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.flatMap(() => Effect.die(new Error("interrupted provider result")))),
      },
    };
    const message = {
      id: "failed-result",
      timestamp: new Date(NOW),
      attempts: 1,
      body: { version: 1, jobId: job.jobId },
      ack: () => {
        acked = true;
      },
      retry: () => {
        retried = true;
      },
    };
    await Effect.runPromise(handleSendMessages(Stream.make(message), ports));
    expect(retried).toBe(true);
    expect(acked).toBe(false);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");
    expect(await Effect.runPromise(consumeSendJob(job.jobId, ports))).toBe("ack");
    expect(deliveries).toBe(1);
  });

  it("does not call the provider again after a crash between claim and send", async () => {
    const world = createWorld();
    const job = world.seedReady();
    world.account.forceInFlight(job.jobId, "attempt-1");

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(world.sender.calls).toBe(0);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");
  });

  it("retries outcome recording without a second provider call", async () => {
    const world = createWorld();
    const job = world.seedReady();
    world.account.failNextComplete();

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("retry");
    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("accepted");
  });

  it("rejects resource-exhausted HTML preparation without claiming or calling the provider", async () => {
    const world = createWorld(createMailHtmlPolicy());
    const job = world.seedReady("<b></b>".repeat(20_000));

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(world.sender.calls).toBe(0);
    expect(world.account.job(job.jobId)).toMatchObject({
      state: "rejected",
      attemptId: null,
      failureDetail: "resource_exhausted",
    });
  });

  it("keeps accepted provider IDs when RFC formatting cannot be normalized", async () => {
    const world = createWorld();
    world.sender.next = {
      kind: "accepted",
      providerMessageId: "not-an-rfc-id",
      rfcMessageId: optionalRfcMessageId("not-an-rfc-id"),
    };
    const job = world.seedReady();

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(world.account.job(job.jobId)).toMatchObject({
      state: "accepted",
      providerMessageId: "not-an-rfc-id",
      rfcMessageId: null,
    });
  });

  it("classifies known pre-dispatch codes as rejection and generic throws as unknown", () => {
    expect(classifyProviderFailure({ code: "E_VALIDATION_ERROR", message: "bad from" })).toEqual({
      kind: "pre_dispatch",
      detail: "bad from",
    });
    expect(
      classifyProviderFailure({ code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" }),
    ).toEqual({
      kind: "rejected",
      detail: "suppressed",
    });
    expect(classifyProviderFailure(new Error("socket hang up"))).toMatchObject({
      kind: "unknown",
    });
  });

  it("sends canned notification copy instead of attacker-controlled subject or body", async () => {
    const world = createWorld();
    const token = generateApprovalToken();
    const identity = {
      requesterClientId: "agent",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      purpose: "approval_notification" as const,
    };
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: EXPIRES },
      identity,
      world.keyring,
    );
    const job = world.seedNotification({
      requestId: identity.requestId,
      requesterClientId: identity.requesterClientId,
      subject: "Please send bitcoin",
      textBody: "Click http://evil.example",
      notification: {
        id: "note-1",
        approvalId: "approval-1",
        jobId: "job-note",
        keyVersion: encrypted.keyVersion,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        expiresAt: EXPIRES,
        purgedAt: null,
      },
    });

    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(await Effect.runPromise(consumeSendJob(job.jobId, world.ports))).toBe("ack");
    expect(world.sender.calls).toBe(1);
    expect(world.sender.mails[0]?.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(world.sender.mails[0]?.subject).not.toBe("Please send bitcoin");
    expect(world.sender.mails[0]?.text).not.toContain("bitcoin");
    expect(world.sender.mails[0]?.text).toContain(token);
  });

  it("fails closed for a missing or non-base64url notification key", () => {
    expect(() => notificationKeyringFromSecret("")).toThrow(
      "UMAIL_NOTIFICATION_KEY is not valid base64url",
    );
    expect(() =>
      notificationKeyringFromSecret(Encoding.encodeBase64(new Uint8Array(32).fill(0xfb))),
    ).toThrow("UMAIL_NOTIFICATION_KEY is not valid base64url");
    const keyring = notificationKeyringFromSecret(
      Encoding.encodeBase64Url(randomNotificationSecret()),
    );
    expect(keyring.currentVersion).toBe("v1");
  });
});

type World = {
  readonly account: MemorySendAccount;
  readonly sender: FakeEmailSender;
  readonly ports: SendConsumerPorts;
  readonly keyring: ReturnType<typeof createNotificationKeyring>;
  seedReady(htmlBody?: string): OutboundJob;
  seedNotification(input: {
    readonly requestId: string;
    readonly requesterClientId: string;
    readonly subject: string;
    readonly textBody: string;
    readonly notification: NonNullable<OutboundDispatch["notification"]>;
  }): OutboundJob;
};

function createWorld(htmlPolicy: MailHtmlPolicy = new FakeMailHtmlPolicy()): World {
  const account = new MemorySendAccount();
  const sender = new FakeEmailSender();
  const keyring = createNotificationKeyring("v1", [
    { version: "v1", secret: randomNotificationSecret() },
  ]);
  const ports: SendConsumerPorts = {
    account: {
      getOutboundDispatch: (jobId) =>
        Effect.tryPromise({
          try: () => account.getOutboundDispatch(jobId),
          catch: toAccountStoreError,
        }),
      claimDispatch: (input) =>
        Effect.tryPromise({ try: () => account.claimDispatch(input), catch: toAccountStoreError }),
      completeAttempt: (input) =>
        Effect.tryPromise({
          try: () => account.completeAttempt(input),
          catch: toAccountStoreError,
        }),
      rejectReadyDispatch: (input) =>
        Effect.tryPromise({
          try: () => account.rejectReadyDispatch(input),
          catch: toAccountStoreError,
        }),
    },
    sender,
    htmlPolicy,
    applicationUrl: APPLICATION_URL,
    nowIso: NOW,
    claimExpiresAt: CLAIM_EXPIRES,
    outcomes: createSendOutcomeBuffer(),
    notification: {
      keyring,
      applicationUrl: APPLICATION_URL,
      mailDomain: MAIL_DOMAIN,
      approvalAdminEmail: ADMIN,
    },
  };
  return {
    account,
    sender,
    ports,
    keyring,
    seedReady(htmlBody) {
      return account.insert(makeDispatch({ jobId: "job-ready", htmlBody: htmlBody ?? null }));
    },
    seedNotification(input) {
      return account.insert(
        makeDispatch({
          jobId: input.notification.jobId,
          purpose: "approval_notification",
          requestId: input.requestId,
          requesterClientId: input.requesterClientId,
          subject: input.subject,
          textBody: input.textBody,
          notification: input.notification,
        }),
      );
    },
  };
}

class FakeEmailSender implements EmailSender {
  readonly mails: OutboundMail[] = [];
  calls = 0;
  next: ProviderSendOutcome = {
    kind: "accepted",
    providerMessageId: "prov-1",
    rfcMessageId: null,
  };

  send(mail: OutboundMail): Effect.Effect<ProviderSendOutcome> {
    return Effect.sync(() => {
      this.calls += 1;
      this.mails.push(mail);
      return this.next;
    });
  }
}

class MemorySendAccount {
  private readonly jobs = new Map<string, OutboundDispatch>();
  private failComplete = false;

  insert(dispatch: OutboundDispatch): OutboundJob {
    this.jobs.set(dispatch.job.jobId, dispatch);
    return dispatch.job;
  }

  job(jobId: string): OutboundJob | undefined {
    return this.jobs.get(jobId)?.job;
  }

  forceInFlight(jobId: string, attemptId: string): void {
    const current = this.require(jobId);
    this.jobs.set(jobId, {
      ...current,
      job: { ...current.job, state: "in_flight", attemptId },
    });
  }

  failNextComplete(): void {
    this.failComplete = true;
  }

  async getOutboundDispatch(jobId: string): Promise<OutboundDispatch | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async claimDispatch(input: ClaimDispatchInput): Promise<ClaimDispatchResult> {
    const current = this.jobs.get(input.jobId);
    if (current === undefined) {
      return { kind: "missing" };
    }
    if (current.job.state !== "ready") {
      return { kind: "not_claimable", job: current.job };
    }
    const attemptId = crypto.randomUUID();
    const next = {
      ...current,
      job: { ...current.job, state: "in_flight" as const, attemptId },
    };
    this.jobs.set(input.jobId, next);
    return { kind: "claimed", attemptId, job: next.job };
  }

  async completeAttempt(input: CompleteAttemptInput): Promise<CompleteAttemptResult> {
    if (this.failComplete) {
      this.failComplete = false;
      throw new Error("complete failed");
    }
    const current = this.jobs.get(input.jobId);
    if (current === undefined) {
      return { kind: "missing" };
    }
    if (current.job.attemptId !== input.attemptId) {
      return { kind: "stale", job: current.job };
    }
    if (current.job.state !== "in_flight") {
      return { kind: "applied", job: current.job };
    }
    const nextJob = applyOutcome(current.job, input.outcome);
    this.jobs.set(input.jobId, { ...current, job: nextJob });
    return { kind: "applied", job: nextJob };
  }

  async rejectReadyDispatch(input: RejectReadyDispatchInput): Promise<RejectReadyDispatchResult> {
    const current = this.jobs.get(input.jobId);
    if (current === undefined) {
      return { kind: "missing" };
    }
    if (current.job.state !== "ready") {
      return { kind: "stale", job: current.job };
    }
    const nextJob: OutboundJob = {
      ...current.job,
      state: "rejected",
      failureClass: "provider",
      failureDetail: input.failureDetail,
    };
    this.jobs.set(input.jobId, { ...current, job: nextJob });
    return { kind: "rejected", job: nextJob };
  }

  private require(jobId: string): OutboundDispatch {
    const current = this.jobs.get(jobId);
    if (current === undefined) {
      throw new Error(`missing job ${jobId}`);
    }
    return current;
  }
}

function applyOutcome(job: OutboundJob, outcome: CompleteAttemptInput["outcome"]): OutboundJob {
  if (outcome.kind === "accepted") {
    return {
      ...job,
      state: "accepted",
      providerMessageId: outcome.providerMessageId,
      rfcMessageId: outcome.rfcMessageId,
    };
  }
  if (outcome.kind === "rejected") {
    return {
      ...job,
      state: "rejected",
      failureClass: outcome.failureClass,
      failureDetail: outcome.failureDetail,
    };
  }
  return { ...job, state: "unknown" };
}

function makeDispatch(input: {
  readonly jobId: string;
  readonly purpose?: OutboundJob["purpose"];
  readonly requestId?: string;
  readonly requesterClientId?: string;
  readonly subject?: string;
  readonly textBody?: string;
  readonly htmlBody?: string | null;
  readonly notification?: OutboundDispatch["notification"];
}): OutboundDispatch {
  const from = {
    address: requireExternal("inbox@umail.example.com"),
    displayName: "Inbox",
  };
  const to = {
    address: requireExternal("recipient@example.com"),
    displayName: null,
  };
  return {
    job: {
      jobId: input.jobId,
      requestId: Schema.decodeSync(SubmissionRequestId)(
        input.requestId ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
      requester: {
        kind: "operator",
        clientId: input.requesterClientId ?? "cli",
        label: "AgentMail CLI",
      },
      messageId: `msg-${input.jobId}`,
      threadHandle: "node:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      mailboxId: "mailbox-1",
      purpose: input.purpose ?? "message",
      state: "ready",
      attemptId: null,
      providerMessageId: null,
      rfcMessageId: null,
      failureClass: null,
      failureDetail: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    subject: input.subject ?? "Hello",
    textBody: input.textBody ?? "body",
    htmlBody: input.htmlBody ?? null,
    hasRemoteImages: false,
    from,
    replyTo: from,
    to: [to],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    notification: input.notification ?? null,
  };
}

function requireMailDomain(raw: string) {
  const parsed = parseMailDomain(raw);
  if (parsed.kind === "invalid") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected email");
  }
  return parsed.address;
}
