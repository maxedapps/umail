/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  ApprovalToken,
  hashApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
  parseMailboxAddress,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { beforeEach, describe, expect, it } from "vitest";

import type { AccountStoreError } from "../../src/account/errors.ts";
import { sendClaimUntilIso } from "../../src/mail/policy.ts";
import type { CompleteAttemptOutcome } from "../../src/account/domain.ts";
import type { EmailSender, ProviderOutboundMail } from "../../src/mail/email-sender.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  newApprovalCapability,
  type NotificationKey,
} from "../../src/mail/notifications.ts";
import { handleSendMessages, type SendConsumerPorts } from "../../src/mail/send.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";
import type { AccountStoreTestHost } from "../account/worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as TestEnv;

const INBOX = "inbox@umail.example.com";
const NOW = "2026-01-01T00:00:00.000Z";
const PAST_CLAIM = "2025-12-31T23:59:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const APPLICATION_URL = new URL("https://umail.example.com");
const ADMIN = requireExternal("operator@umail.example.com");
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const REQUEST_C = "33333333-3333-4333-8333-333333333333";

describe("send consumer worker composition", () => {
  beforeEach(async () => {
    await reset();
  });

  it("sends a ready job once through real AccountStore claims", async () => {
    const world = await createWorld("send-once");
    const submitted = await world.stub.submitOutbound(
      await operatorSubmit(world, world.mailboxId, REQUEST_A),
    );
    const first = new FakeQueueMessage("send-1", {
      version: 1,
      jobId: submitted.job.jobId,
    });
    const duplicate = new FakeQueueMessage("send-2", {
      version: 1,
      jobId: submitted.job.jobId,
    });

    await runSendHandler(world, [first]);
    await runSendHandler(world, [duplicate]);

    expect(first.acked).toBe(true);
    expect(duplicate.acked).toBe(true);
    expect(world.sender.calls).toBe(1);
    expect(
      await world.stub.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
    ).toMatchObject({
      state: "accepted",
      providerMessageId: "prov-1",
      rfcMessageId: null,
    });
  });

  it("settles an abandoned in-flight claim as unknown without calling the provider", async () => {
    const world = await createWorld("send-abandoned");
    const submitted = await world.stub.submitOutbound(
      await operatorSubmit(world, world.mailboxId, REQUEST_A),
    );
    const claimed = await world.stub.claimDispatch({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: PAST_CLAIM,
    });
    expect(claimed.kind).toBe("claimed");

    expect(await world.stub.recoverOutbound({ nowIso: NOW, limit: 50 })).toEqual([]);
    await runSendHandler(world, [
      new FakeQueueMessage("send-late", { version: 1, jobId: submitted.job.jobId }),
    ]);

    expect(world.sender.calls).toBe(0);
    expect(
      await world.stub.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
    ).toMatchObject({
      state: "unknown",
    });
  });

  it("returns bounded ready pages without parked jobs and expires due approvals", async () => {
    const world = await createWorld("send-cron");
    const first = await world.stub.submitOutbound(
      await operatorSubmit(world, world.mailboxId, REQUEST_A),
    );
    const second = await world.stub.submitOutbound(
      await operatorSubmit(world, world.mailboxId, REQUEST_B),
    );
    await seedOauthPolicy(world.stub, "agent");
    const pending = await world.stub.submitOutbound(
      await approvalSubmit(world, world.mailboxId, REQUEST_C, "agent"),
    );
    expect(pending.job.state).toBe("waiting_approval");
    const notification = await requireNotificationJob(world.stub);

    expect(await world.stub.recoverOutbound({ nowIso: NOW, limit: 1 })).toHaveLength(1);
    expect(new Set(await world.stub.recoverOutbound({ nowIso: NOW, limit: 50 }))).toEqual(
      new Set([first.job.jobId, second.job.jobId, notification.jobId]),
    );

    await world.stub.recoverOutbound({ nowIso: "2026-01-03T00:00:00.000Z", limit: 50 });
    expect(await world.stub.getOutboundJob(pending.job.jobId, { kind: "operator" })).toMatchObject({
      state: "rejected",
      failureClass: "expired",
    });
  });

  it("sends canned approval notification mail once with a link that resolves", async () => {
    const world = await createWorld("send-approval-mail");
    await seedOauthPolicy(world.stub, "agent");
    const submitted = await world.stub.submitOutbound(
      await approvalSubmit(world, world.mailboxId, REQUEST_A, "agent"),
    );
    expect(submitted.job.state).toBe("waiting_approval");
    const notification = await requireNotificationJob(world.stub);
    const first = new FakeQueueMessage("notify-1", { version: 1, jobId: notification.jobId });
    const duplicate = new FakeQueueMessage("notify-2", { version: 1, jobId: notification.jobId });

    await runSendHandler(world, [first]);
    await runSendHandler(world, [duplicate]);

    expect(first.acked).toBe(true);
    expect(duplicate.acked).toBe(true);
    expect(world.sender.calls).toBe(1);
    const mail = world.sender.mails[0];
    expect(mail?.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(mail?.text).not.toContain("bitcoin");
    const token = /\/approvals\/([0-9a-f]{64})/u.exec(mail?.text ?? "")?.[1] ?? "";
    const tokenHash = await hashApprovalToken(Schema.decodeSync(ApprovalToken)(token));
    expect(await world.stub.lookupApprovalByTokenHash(tokenHash)).toMatchObject({
      kind: "found",
      approval: { state: "pending" },
      job: { jobId: submitted.job.jobId, state: "waiting_approval" },
    });
  });
});

type World = {
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
  readonly mailboxId: string;
  readonly sender: FakeEmailSender;
  readonly key: NotificationKey;
  readonly sendPorts: SendConsumerPorts;
};

// The test host rethrows the store's failure; it lands in the error channel, as it does over RPC.
const storeFailure = (cause: unknown) => cause as AccountStoreError;

async function createWorld(accountName: string): Promise<World> {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const mailbox = parsedInbox();
  const created = await stub.createAddress(mailbox.localPart, mailbox.domain, "Inbox", NOW);
  expect(created).not.toBeNull();
  if (created === null) {
    throw new Error("expected mailbox");
  }
  const sender = new FakeEmailSender();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const htmlPolicy = new FakeMailHtmlPolicy();
  const sendPorts: SendConsumerPorts = {
    account: {
      getOutboundDispatch: (jobId) =>
        Effect.tryPromise({
          try: async () => await stub.getOutboundDispatch(jobId),
          catch: storeFailure,
        }),
      claimDispatch: (input) =>
        Effect.tryPromise({
          try: async () => await stub.claimDispatch(input),
          catch: storeFailure,
        }),
      completeAttempt: (input) =>
        Effect.tryPromise({
          try: async () => await stub.completeAttempt(input),
          catch: storeFailure,
        }),
      rejectReadyDispatch: (input) =>
        Effect.tryPromise({
          try: async () => await stub.rejectReadyDispatch(input),
          catch: storeFailure,
        }),
    },
    sender,
    htmlPolicy,
    applicationUrl: APPLICATION_URL,
    nowIso: NOW,
    claimExpiresAt: sendClaimUntilIso(Date.parse(NOW)),
    notification: {
      key,
      mailDomain: DOMAIN,
      approvalAdminEmail: ADMIN,
    },
  };
  return {
    stub,
    mailboxId: created.id,
    sender,
    key,
    sendPorts,
  };
}

async function runSendHandler(world: World, messages: FakeQueueMessage[]): Promise<void> {
  await Effect.runPromise(handleSendMessages(Stream.fromIterable(messages), world.sendPorts));
}

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

class FakeQueueMessage {
  readonly timestamp = new Date(NOW);
  readonly attempts = 1;
  acked = false;
  retried = false;

  readonly id: string;
  readonly body: unknown;

  constructor(id: string, body: unknown) {
    this.id = id;
    this.body = body;
  }

  ack(): void {
    if (this.acked || this.retried) return;
    this.acked = true;
  }

  retry(): void {
    if (this.acked || this.retried) return;
    this.retried = true;
  }
}

async function operatorSubmit(world: World, mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    mailboxId,
    subject: "Direct",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: await newApprovalCapability(world.key, NOW),
  };
}

async function requireNotificationJob(store: DurableObjectStub<AccountStoreTestHost>) {
  const jobs = await store.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 });
  const notification = jobs.items.find(
    (job) => job.purpose === "approval_notification" && job.state === "ready",
  );
  if (notification === undefined) {
    throw new Error("expected a ready approval_notification job");
  }
  return notification;
}

async function approvalSubmit(
  world: World,
  mailboxId: string,
  requestId: string,
  clientId: string,
) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "mcp" as const, clientId, label: `Client ${clientId}` },
    mailboxId,
    subject: "Please send bitcoin",
    textBody: "Click http://evil.example",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: await newApprovalCapability(world.key, NOW),
  };
}

async function seedOauthPolicy(store: DurableObjectStub<AccountStoreTestHost>, clientId: string) {
  await store.ensureMcpOAuthPolicy({
    clientId,
    label: `Client ${clientId}`,
    createdAt: NOW,
  });
  await store.updateMcpOAuthPolicy({
    clientId,
    label: `Client ${clientId}`,
    policy: {
      mailboxIds: "all",
      canRead: true,
      canDelete: false,
      sendMode: { kind: "requireApproval", preapprovedRecipients: [] },
      recipientAllowlist: "any",
      canAdmin: false,
    },
    updatedAt: NOW,
  });
}

function parsedInbox() {
  const parsed = parseMailboxAddress(INBOX);
  if (parsed.kind === "invalid") {
    throw new Error("expected inbox address");
  }
  return parsed;
}

function requireMailDomain(raw: string): MailDomain {
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
