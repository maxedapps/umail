import type { AccountStoreError } from "../../src/account/errors.ts";
import type {
  ClaimDispatchInput,
  ClaimDispatchResult,
  CompleteAttemptInput,
  CompleteAttemptOutcome,
  CompleteAttemptResult,
  OutboundDispatch,
  OutboundJob,
  RejectReadyDispatchInput,
  RejectReadyDispatchResult,
} from "../../src/account/domain.ts";
import {
  normalizeRfcMessageId,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
} from "@umail/api-contract";
import { createMailHtmlPolicy, type MailHtmlPolicy } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  classifyProviderFailure,
  type EmailSender,
  type ProviderOutboundMail,
} from "../../src/mail/email-sender.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  deriveApprovalToken,
  type NotificationKey,
} from "../../src/mail/notifications.ts";
import { consumeSendJob, handleSendMessages, type SendConsumerPorts } from "../../src/mail/send.ts";
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

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));

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
    await Effect.runPromise(consumeSendJob(job.jobId, ports));
    expect(deliveries).toBe(1);
  });

  it("retries and logs one warning when a store call fails", async () => {
    const world = createWorld();
    const job = world.seedReady();
    const warnings: Array<{ message: unknown; annotations: unknown }> = [];
    const capture = Logger.make(({ logLevel, message, fiber }) => {
      if (logLevel !== "Warn") return;
      warnings.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    });
    let retried = false;
    let acked = false;
    const ports: SendConsumerPorts = {
      ...world.ports,
      account: {
        ...world.ports.account,
        getOutboundDispatch: () => Effect.fail(storeFailure(new Error("store unavailable"))),
      },
    };
    const message = {
      id: "store-failure",
      timestamp: new Date(NOW),
      attempts: 2,
      body: { version: 1, jobId: job.jobId },
      ack: () => {
        acked = true;
      },
      retry: () => {
        retried = true;
      },
    };
    await Effect.runPromise(
      handleSendMessages(Stream.make(message), ports).pipe(Effect.provide(Logger.layer([capture]))),
    );
    expect(retried).toBe(true);
    expect(acked).toBe(false);
    expect(world.sender.calls).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: expect.arrayContaining(["Send job failed; retrying"]),
      annotations: { messageId: "store-failure", attempts: 2 },
    });
  });

  it("does not call the provider again after a crash between claim and send", async () => {
    const world = createWorld();
    const job = world.seedReady();
    world.account.forceInFlight(job.jobId, "attempt-1");

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.sender.calls).toBe(0);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");
  });

  it("retries outcome recording inline without a second provider call", async () => {
    const world = createWorld();
    const job = world.seedReady();
    world.account.failCompletes(1);

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("accepted");
  });

  it("fails the message when outcome recording keeps failing and never sends again", async () => {
    const world = createWorld();
    const job = world.seedReady();
    world.account.failCompletes(3);

    const exit = await Effect.runPromiseExit(consumeSendJob(job.jobId, world.ports));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.sender.calls).toBe(1);
    expect(world.account.job(job.jobId)?.state).toBe("in_flight");
  });

  it("rejects resource-exhausted HTML preparation without claiming or calling the provider", async () => {
    const world = createWorld(createMailHtmlPolicy());
    const job = world.seedReady("<b></b>".repeat(20_000));

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
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
      rfcMessageId: normalizeRfcMessageId("not-an-rfc-id"),
    };
    const job = world.seedReady();

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.account.job(job.jobId)).toMatchObject({
      state: "accepted",
      providerMessageId: "not-an-rfc-id",
      rfcMessageId: null,
    });
  });

  it("classifies known provider codes as rejection and generic throws as unknown", () => {
    expect(classifyProviderFailure({ code: "E_VALIDATION_ERROR", message: "bad from" })).toEqual({
      kind: "rejected",
      failureDetail: "E_VALIDATION_ERROR",
    });
    expect(
      classifyProviderFailure({ code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" }),
    ).toEqual({
      kind: "rejected",
      failureDetail: "E_RECIPIENT_SUPPRESSED",
    });
    expect(classifyProviderFailure(new Error("E_RATE_LIMIT_EXCEEDED: slow down"))).toEqual({
      kind: "rejected",
      failureDetail: "E_RATE_LIMIT_EXCEEDED",
    });
    expect(classifyProviderFailure(new Error("socket hang up"))).toEqual({ kind: "unknown" });
  });

  it("records a rate-limited send as rejected with the provider code", async () => {
    const world = createWorld();
    world.sender.next = { kind: "rejected", failureDetail: "E_RATE_LIMIT_EXCEEDED" };
    const job = world.seedReady();

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.account.job(job.jobId)).toMatchObject({
      state: "rejected",
      failureClass: "provider",
      failureDetail: "E_RATE_LIMIT_EXCEEDED",
    });
  });

  it("sends canned notification copy instead of attacker-controlled subject or body", async () => {
    const world = createWorld();
    const job = world.seedNotification({
      subject: "Please send bitcoin",
      textBody: "Click http://evil.example",
      approval: { approvalId: "approval-1", expiresAt: EXPIRES },
    });

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.sender.calls).toBe(1);
    expect(world.sender.mails[0]?.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(world.sender.mails[0]?.subject).not.toBe("Please send bitcoin");
    expect(world.sender.mails[0]?.text).not.toContain("bitcoin");
    expect(world.sender.mails[0]?.text).toContain(
      `/approvals/${await deriveApprovalToken(world.key, "approval-1")}`,
    );
  });

  it("rejects a notification whose approval is no longer pending without sending", async () => {
    const world = createWorld();
    const job = world.seedNotification({ subject: "Hi", textBody: "body", approval: null });

    await Effect.runPromise(consumeSendJob(job.jobId, world.ports));
    expect(world.sender.calls).toBe(0);
    expect(world.account.job(job.jobId)).toMatchObject({
      state: "rejected",
      failureDetail: "approval_unavailable",
    });
  });
});

type World = {
  readonly account: MemorySendAccount;
  readonly sender: FakeEmailSender;
  readonly ports: SendConsumerPorts;
  readonly key: NotificationKey;
  seedReady(htmlBody?: string): OutboundJob;
  seedNotification(input: {
    readonly subject: string;
    readonly textBody: string;
    readonly approval: OutboundDispatch["approval"];
  }): OutboundJob;
};

function createWorld(htmlPolicy: MailHtmlPolicy = new FakeMailHtmlPolicy()): World {
  const account = new MemorySendAccount();
  const sender = new FakeEmailSender();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const ports: SendConsumerPorts = {
    account: {
      getOutboundDispatch: (jobId) =>
        Effect.tryPromise({ try: () => account.getOutboundDispatch(jobId), catch: storeFailure }),
      claimDispatch: (input) =>
        Effect.tryPromise({ try: () => account.claimDispatch(input), catch: storeFailure }),
      completeAttempt: (input) =>
        Effect.tryPromise({ try: () => account.completeAttempt(input), catch: storeFailure }),
      rejectReadyDispatch: (input) =>
        Effect.tryPromise({ try: () => account.rejectReadyDispatch(input), catch: storeFailure }),
    },
    sender,
    htmlPolicy,
    applicationUrl: APPLICATION_URL,
    nowIso: NOW,
    claimExpiresAt: CLAIM_EXPIRES,
    notification: {
      key,
      mailDomain: MAIL_DOMAIN,
      approvalAdminEmail: ADMIN,
    },
  };
  return {
    account,
    sender,
    ports,
    key,
    seedReady(htmlBody) {
      return account.insert(makeDispatch({ jobId: "job-ready", htmlBody: htmlBody ?? null }));
    },
    seedNotification(input) {
      return account.insert(
        makeDispatch({
          jobId: "job-note",
          purpose: "approval_notification",
          subject: input.subject,
          textBody: input.textBody,
          approval: input.approval,
        }),
      );
    },
  };
}

// A rejected store call lands in the error channel, as it does over RPC.
const storeFailure = (cause: unknown) => cause as AccountStoreError;

class FakeEmailSender implements EmailSender {
  readonly mails: ProviderOutboundMail[] = [];
  calls = 0;
  next: CompleteAttemptOutcome = {
    kind: "accepted",
    providerMessageId: "prov-1",
    rfcMessageId: null,
  };

  send(mail: ProviderOutboundMail): Effect.Effect<CompleteAttemptOutcome> {
    return Effect.sync(() => {
      this.calls += 1;
      this.mails.push(mail);
      return this.next;
    });
  }
}

class MemorySendAccount {
  private readonly jobs = new Map<string, OutboundDispatch>();
  private completeFailures = 0;

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

  failCompletes(count: number): void {
    this.completeFailures = count;
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
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
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

function applyOutcome(job: OutboundJob, outcome: CompleteAttemptOutcome): OutboundJob {
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
      failureClass: "provider",
      failureDetail: outcome.failureDetail,
    };
  }
  return { ...job, state: "unknown" };
}

function makeDispatch(input: {
  readonly jobId: string;
  readonly purpose?: OutboundJob["purpose"];
  readonly subject?: string;
  readonly textBody?: string;
  readonly htmlBody?: string | null;
  readonly approval?: OutboundDispatch["approval"];
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
      requestId: Schema.decodeSync(SubmissionRequestId)("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      requester: { kind: "operator", clientId: "cli", label: "AgentMail CLI" },
      messageId: `msg-${input.jobId}`,
      threadHandle: `msg-${input.jobId}`,
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
    approval: input.approval ?? null,
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
