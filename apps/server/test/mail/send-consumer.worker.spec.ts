import { toAccountStoreError } from "../../src/account/errors.ts";
/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  approvalNotificationIdempotencyKey,
  generateApprovalToken,
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

import { sendClaimUntilIso } from "../../src/mail/policy.ts";
import type {
  EmailSender,
  OutboundMail,
  ProviderSendOutcome,
} from "../../src/mail/email-sender.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  createNotificationKeyring,
  decryptNotificationPayload,
  encryptNotificationPayload,
  randomNotificationSecret,
} from "../../src/mail/notifications.ts";
import { handleRecoveryScheduled, type RecoveryPorts } from "../../src/mail/recovery.ts";
import {
  createSendOutcomeBuffer,
  handleSendMessages,
  type SendConsumerPorts,
} from "../../src/mail/send.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
  readonly ACCOUNT_ID: string;
};

const testEnv = env as TestEnv;

const INBOX = "inbox@umail.example.com";
const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
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
    const submitted = await world.stub.submitOutbound(operatorSubmit(world.mailboxId, REQUEST_A));
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
    const submitted = await world.stub.submitOutbound(operatorSubmit(world.mailboxId, REQUEST_A));
    const claimed = await world.stub.claimDispatch({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: PAST_CLAIM,
    });
    expect(claimed.kind).toBe("claimed");

    await handleRecoveryScheduled({ scheduledTime: Date.parse(NOW) }, world.recovery);

    expect(world.sender.calls).toBe(0);
    expect(
      await world.stub.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
    ).toMatchObject({
      state: "unknown",
    });
    expect(world.publishedSend).toEqual([]);
  });

  it("publishes bounded ready-send pages and expires due approvals", async () => {
    const world = await createWorld("send-cron", 1);
    const first = await world.stub.submitOutbound(operatorSubmit(world.mailboxId, REQUEST_A));
    const second = await world.stub.submitOutbound(operatorSubmit(world.mailboxId, REQUEST_B));
    await seedOauthPolicy(world.stub, "agent");
    const pending = await world.stub.submitOutbound(
      await approvalSubmit(world.stub, world.mailboxId, REQUEST_C, "agent"),
    );
    expect(pending.job.state).toBe("waiting_approval");
    const ready = await world.stub.listSendWork({ kind: "ready", nowIso: NOW, limit: 50 });
    expect(ready.items).toHaveLength(3);
    const notification = ready.items.find((job) => job.purpose === "approval_notification");
    expect(notification).toBeDefined();

    await handleRecoveryScheduled({ scheduledTime: Date.parse(NOW) }, world.recovery);
    expect(world.publishedSend).toHaveLength(1);
    const firstPage = new Set(world.publishedSend.map((item) => item.jobId));
    expect(firstPage.size).toBe(1);

    await handleRecoveryScheduled({ scheduledTime: Date.parse(NOW) }, world.recovery);
    await handleRecoveryScheduled({ scheduledTime: Date.parse(NOW) }, world.recovery);
    expect(new Set(world.publishedSend.map((item) => item.jobId))).toEqual(
      new Set([first.job.jobId, second.job.jobId, notification?.jobId]),
    );
    expect(world.publishedSend.map((item) => item.jobId)).not.toContain(pending.job.jobId);

    await handleRecoveryScheduled(
      { scheduledTime: Date.parse("2026-01-03T00:00:00.000Z") },
      world.recovery,
    );
    expect(await world.stub.getOutboundJob(pending.job.jobId, { kind: "operator" })).toMatchObject({
      state: "rejected",
      failureClass: "expired",
    });
  });

  it("stores encrypted capability, detects tampering, and purges ciphertext", async () => {
    const world = await createWorld("send-notify");
    await seedOauthPolicy(world.stub, "agent");
    const token = generateApprovalToken();
    const requestId = Schema.decodeSync(SubmissionRequestId)(REQUEST_A);
    const identity = {
      requesterClientId: "agent",
      requestId: approvalNotificationIdempotencyKey(requestId),
      purpose: "approval_notification" as const,
    };
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: EXPIRES },
      identity,
      world.keyring,
    );
    const submitted = await world.stub.submitOutbound(
      await approvalSubmit(world.stub, world.mailboxId, REQUEST_A, "agent", encrypted),
    );
    const notification = await requireNotificationJob(world.stub);
    const dispatch = await world.stub.getOutboundDispatch(notification.jobId);
    expect(dispatch?.notification?.ciphertext).toBe(encrypted.ciphertext);
    expect(
      JSON.stringify(await world.stub.getOutboundJob(submitted.job.jobId, { kind: "operator" })),
    ).not.toContain(token);
    expect(JSON.stringify(dispatch?.notification)).not.toContain(token);
    const record = dispatch?.notification;
    expect(record).not.toBeNull();
    if (record === null || record === undefined) {
      throw new Error("expected stored notification");
    }
    const roundTrip = await decryptNotificationPayload(record, identity, world.keyring, NOW);
    expect(roundTrip).toEqual({
      kind: "ok",
      payload: { version: 1, token, expiresAt: EXPIRES },
    });
    const tampered = await decryptNotificationPayload(
      { ...record, ciphertext: `${record.ciphertext.slice(0, -2)}aa` },
      identity,
      world.keyring,
      NOW,
    );
    expect(tampered.kind).toBe("forged");
    expect(world.sender.calls).toBe(0);

    await handleRecoveryScheduled(
      { scheduledTime: Date.parse("2026-01-03T00:00:00.000Z") },
      world.recovery,
    );
    const afterExpiry = await world.stub.getOutboundDispatch(notification.jobId);
    expect(afterExpiry?.notification).toBeNull();
    const listed = await world.stub.listPurgeableNotifications({
      nowIso: "2026-01-03T00:00:00.000Z",
      limit: 50,
    });
    expect(listed.items).toHaveLength(0);
  });

  it("sends canned approval notification mail once for a requireApproval submit", async () => {
    const world = await createWorld("send-approval-mail");
    await seedOauthPolicy(world.stub, "agent");
    const token = generateApprovalToken();
    const requestId = Schema.decodeSync(SubmissionRequestId)(REQUEST_A);
    const identity = {
      requesterClientId: "agent",
      requestId: approvalNotificationIdempotencyKey(requestId),
      purpose: "approval_notification" as const,
    };
    const encrypted = await encryptNotificationPayload(
      { version: 1, token, expiresAt: EXPIRES },
      identity,
      world.keyring,
    );
    const submitted = await world.stub.submitOutbound(
      await approvalSubmit(world.stub, world.mailboxId, REQUEST_A, "agent", encrypted),
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
    expect(world.sender.mails[0]?.subject).toBe(APPROVAL_NOTIFICATION_SUBJECT);
    expect(world.sender.mails[0]?.text).toContain(token);
    expect(world.sender.mails[0]?.text).not.toContain("bitcoin");
    expect(
      await world.stub.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
    ).toMatchObject({
      state: "waiting_approval",
    });
  });
});

type World = {
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
  readonly mailboxId: string;
  readonly sender: FakeEmailSender;
  readonly keyring: ReturnType<typeof createNotificationKeyring>;
  readonly sendPorts: SendConsumerPorts;
  readonly recovery: RecoveryPorts;
  readonly publishedSend: Array<{ version: 1; jobId: string }>;
};

async function createWorld(accountName: string, sendPageSize = 50): Promise<World> {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const mailbox = parsedInbox();
  const created = await stub.createAddress(mailbox.localPart, mailbox.domain, "Inbox", NOW);
  expect(created).not.toBeNull();
  if (created === null) {
    throw new Error("expected mailbox");
  }
  const sender = new FakeEmailSender();
  const keyring = createNotificationKeyring("v1", [
    { version: "v1", secret: randomNotificationSecret() },
  ]);
  const htmlPolicy = new FakeMailHtmlPolicy();
  const sendPorts: SendConsumerPorts = {
    account: {
      getOutboundDispatch: (jobId) =>
        Effect.tryPromise({
          try: async () => await stub.getOutboundDispatch(jobId),
          catch: toAccountStoreError,
        }),
      claimDispatch: (input) =>
        Effect.tryPromise({
          try: async () => await stub.claimDispatch(input),
          catch: toAccountStoreError,
        }),
      completeAttempt: (input) =>
        Effect.tryPromise({
          try: async () => await stub.completeAttempt(input),
          catch: toAccountStoreError,
        }),
      rejectReadyDispatch: (input) =>
        Effect.tryPromise({
          try: async () => await stub.rejectReadyDispatch(input),
          catch: toAccountStoreError,
        }),
    },
    sender,
    htmlPolicy,
    applicationUrl: APPLICATION_URL,
    nowIso: NOW,
    claimExpiresAt: sendClaimUntilIso(Date.parse(NOW)),
    outcomes: createSendOutcomeBuffer(),
    notification: {
      keyring,
      applicationUrl: APPLICATION_URL,
      mailDomain: DOMAIN,
      approvalAdminEmail: ADMIN,
    },
  };
  const publishedSend: Array<{ version: 1; jobId: string }> = [];
  const recovery: RecoveryPorts = {
    archive: {
      async get() {
        return null;
      },
      async list() {
        return { keys: [], cursor: null };
      },
    },
    index: {
      async send() {},
    },
    account: {
      registerInboundReceipt: (input) => stub.registerInboundReceipt(input),
      listInboundReceiptWork: (input) => stub.listInboundReceiptWork(input),
      recordInboundReceiptRedrive: (input) => stub.recordInboundReceiptRedrive(input),
      getRecoveryScan: (scanId) => stub.getRecoveryScan(scanId),
      putRecoveryScan: (input) => stub.putRecoveryScan(input),
      listSendWork: (input) => stub.listSendWork(input),
      listDuePendingApprovals: (input) => stub.listDuePendingApprovals(input),
      listPurgeableNotifications: (input) => stub.listPurgeableNotifications(input),
      expirePendingApproval: (input) => stub.expirePendingApproval(input),
      settleExpiredInFlight: (input) => stub.settleExpiredInFlight(input),
      purgeNotificationCiphertext: (input) => stub.purgeNotificationCiphertext(input),
    },
    receiptPageSize: 50,
    manifestPageSize: 100,
    attemptBudget: 8,
    send: {
      async send(payload) {
        publishedSend.push(payload);
      },
    },
    sendPageSize,
    approvalPageSize: 50,
    purgePageSize: 50,
  };
  return {
    stub,
    mailboxId: created.id,
    sender,
    keyring,
    sendPorts,
    recovery,
    publishedSend,
  };
}

async function runSendHandler(world: World, messages: FakeQueueMessage[]): Promise<void> {
  await Effect.runPromise(handleSendMessages(Stream.fromIterable(messages), world.sendPorts));
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

function operatorSubmit(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    mailboxId,
    mailDomain: DOMAIN,
    subject: "Direct",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
  };
}

async function requireNotificationJob(store: DurableObjectStub<AccountStoreTestHost>) {
  const ready = await store.listSendWork({ kind: "ready", nowIso: NOW, limit: 50 });
  const notification = ready.items.find((job) => job.purpose === "approval_notification");
  if (notification === undefined) {
    throw new Error("expected a ready approval_notification job");
  }
  return notification;
}

async function approvalSubmit(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  requestId: string,
  clientId: string,
  notification?: {
    readonly keyVersion: string;
    readonly nonce: string;
    readonly ciphertext: string;
  },
) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "mcp" as const, clientId, label: `Client ${clientId}` },
    mailboxId,
    mailDomain: DOMAIN,
    subject: "Please send bitcoin",
    textBody: "Click http://evil.example",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: {
      tokenHash: await hashApprovalToken(generateApprovalToken()),
      expiresAt: EXPIRES,
      notification: notification ?? {
        keyVersion: "v1",
        nonce: "n1",
        ciphertext: "secret-capability-ciphertext",
      },
    },
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
