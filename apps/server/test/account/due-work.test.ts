import {
  OPERATOR_POLICY,
  SubmissionRequestId,
  normalizeRfcMessageId,
  parseExternalMailAddress,
  parseMailDomain,
  requireApprovalSendMode,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { createMailHtmlPolicy, type MailHtmlPolicy } from "../../src/mail/html-policy.ts";
import type { CompleteAttemptOutcome, OutboundRequester } from "../../src/account/domain.ts";
import { FAILED_STEP_RETRY_MS, runDueWork, type DueWorkPorts } from "../../src/account/due-work.ts";
import { claimJob } from "../../src/account/jobs.ts";
import { WebCrypto } from "../../src/crypto.ts";
import type { EmailSender, ProviderOutboundMail } from "../../src/mail/email-sender.ts";
import {
  APPROVAL_NOTIFICATION_SUBJECT,
  deriveApprovalToken,
  newApprovalCapability,
} from "../../src/mail/notifications.ts";
import { createMemoryAccount } from "../api/memory-account-store.ts";
import { WorkerServices } from "../api/world.ts";
import { FakeMailHtmlPolicy } from "../mail/fakes.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const MAIL_DOMAIN = requireMailDomain("umail.example.com");
const OPERATOR_EMAIL = requireExternal("operator@example.net");
const OPERATOR: OutboundRequester = { kind: "operator", clientId: "cli", label: "AgentMail CLI" };
const AGENT: OutboundRequester = { kind: "mcp", clientId: "agent", label: "Agent" };
const NEEDS_APPROVAL = policyWith(requireApprovalSendMode());

describe("store due-work pass", () => {
  it("arms the alarm on submit and sends a ready job exactly once", async () => {
    const world = await createWorld();
    const before = Date.now();
    const job = await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
    expect(job.state).toBe("ready");
    expect(world.storage.alarm).toBeGreaterThanOrEqual(before);
    expect(world.storage.alarm).toBeLessThanOrEqual(Date.now());

    await world.runAt(NOW_MS);
    await world.runAt(NOW_MS + SECOND);
    expect(world.sender.mails).toHaveLength(1);
    expect(world.sender.mails[0]?.subject).toBe("Hello");
    expect(await world.job(job.jobId)).toMatchObject({
      state: "accepted",
      providerMessageId: "prov-1",
    });
    expect(world.storage.alarm).toBeNull();
  });

  it("notifies the operator, then sends the message once it is approved", async () => {
    const world = await createWorld();
    const job = await world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
    expect(job.state).toBe("waiting_approval");

    await world.runAt(NOW_MS);
    const notice = world.sender.mails[0];
    expect(world.sender.mails).toHaveLength(1);
    expect(notice).toMatchObject({ to: [OPERATOR_EMAIL], subject: APPROVAL_NOTIFICATION_SUBJECT });
    // Canned copy: the requester's subject and body never reach the operator's inbox.
    expect(notice?.text).not.toContain("Hello");
    const token = await Effect.runPromise(deriveApprovalToken(world.key, world.lastApprovalId));
    expect(notice?.text).toContain(`https://umail.example.com/approvals/${token}`);
    // The pending approval's deadline keeps the alarm set.
    expect(world.storage.alarm).toBe(Date.parse(world.lastExpiresAt));

    const decision = await Effect.runPromise(
      world.account.decideApproval({
        tokenHash: world.lastTokenHash,
        decision: "approved",
        nowIso: NOW,
      }),
    );
    expect(decision).toMatchObject({ kind: "claimed", job: { state: "ready" } });
    expect(world.storage.alarm).toBeLessThanOrEqual(Date.now());

    await world.runAt(NOW_MS + MINUTE);
    expect(world.sender.mails.map((mail) => mail.subject)).toEqual([
      APPROVAL_NOTIFICATION_SUBJECT,
      "Hello",
    ]);
    expect(await world.job(job.jobId)).toMatchObject({ state: "accepted" });
  });

  it("expires a due approval and rejects both of its unsent jobs", async () => {
    const world = await createWorld();
    const job = await world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });

    await world.runAt(Date.parse(world.lastExpiresAt));
    expect(world.sender.mails).toHaveLength(0);
    const jobs = await world.jobs();
    expect(jobs.map((item) => [item.purpose, item.state, item.failureClass])).toEqual([
      ["approval_notification", "rejected", "expired"],
      ["message", "rejected", "expired"],
    ]);
    expect(await world.job(job.jobId)).toMatchObject({ state: "rejected" });
    expect(world.storage.alarm).toBeNull();
  });

  it("never sends a claimed job again and settles it unknown once the claim expires", async () => {
    const world = await createWorld();
    const job = await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
    // A pass that crashed between its claim and the provider call.
    claimJob(world.storage, {
      jobId: job.jobId,
      attemptId: "crashed-attempt",
      nowIso: NOW,
      claimExpiresAt: iso(NOW_MS + 15 * MINUTE),
      policy: OPERATOR_POLICY,
    });

    await world.runAt(NOW_MS + MINUTE);
    expect(await world.job(job.jobId)).toMatchObject({ state: "in_flight" });
    expect(world.storage.alarm).toBe(NOW_MS + 15 * MINUTE);

    await world.runAt(NOW_MS + 15 * MINUTE);
    expect(world.sender.mails).toHaveLength(0);
    expect(await world.job(job.jobId)).toMatchObject({ state: "unknown" });
  });

  it("keeps sending when redrive fails, and re-arms for the next redrive", async () => {
    const world = await createWorld();
    world.failIndex = true;
    await world.registerReceipt("receipt-1");
    const job = await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });

    // The receipt is due five minutes after it arrived; its next redrive backs off by its age.
    await world.runAt(NOW_MS + 5 * MINUTE);
    expect(await world.job(job.jobId)).toMatchObject({ state: "accepted" });
    expect(world.indexed).toEqual([]);
    expect(world.storage.alarm).toBe(NOW_MS + 10 * MINUTE);

    world.failIndex = false;
    await world.runAt(NOW_MS + 10 * MINUTE);
    expect(world.indexed).toEqual(["receipt-1"]);
  });

  it("retries a failing send step after a minute instead of spinning", async () => {
    const world = await createWorld();
    const job = await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
    world.policyFor = () => Effect.die(new Error("policy lookup failed"));

    await world.runAt(NOW_MS);
    expect(await world.job(job.jobId)).toMatchObject({ state: "ready" });
    expect(world.storage.alarm).toBe(NOW_MS + FAILED_STEP_RETRY_MS);
  });

  it("sends at most ten jobs per pass and re-arms at once while work remains", async () => {
    const world = await createWorld();
    for (let index = 0; index < 11; index += 1) {
      await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
    }

    await world.runAt(NOW_MS);
    expect(world.sender.mails).toHaveLength(10);
    expect(world.storage.alarm).toBe(NOW_MS);

    await world.runAt(NOW_MS + SECOND);
    expect(world.sender.mails).toHaveLength(11);
    expect(world.storage.alarm).toBeNull();
  });

  it("records HTML that cannot be prepared as a policy rejection without a provider call", async () => {
    const world = await createWorld(createMailHtmlPolicy());
    const job = await world.submit({
      requester: OPERATOR,
      policy: OPERATOR_POLICY,
      htmlBody: "<b></b>".repeat(20_000),
    });

    await world.runAt(NOW_MS);
    expect(world.sender.mails).toHaveLength(0);
    expect(await world.job(job.jobId)).toMatchObject({
      state: "rejected",
      attemptId: null,
      failureClass: "policy",
      failureDetail: "resource_exhausted",
    });
  });

  it("rejects both jobs as policy when the notification's requester may no longer send", async () => {
    const world = await createWorld();
    await world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
    world.policyFor = () => Effect.succeed(policyWith({ kind: "deny" }));

    await world.runAt(NOW_MS);
    expect(world.sender.mails).toHaveLength(0);
    expect((await world.jobs()).map((item) => [item.state, item.failureClass])).toEqual([
      ["rejected", "policy"],
      ["rejected", "policy"],
    ]);
    expect(
      await Effect.runPromise(world.account.lookupApprovalByTokenHash(world.lastTokenHash)),
    ).toMatchObject({ approval: { state: "cancelled" } });
  });

  it("gives up on the message when Cloudflare rejects its notification", async () => {
    const world = await createWorld();
    const job = await world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
    world.sender.next = { kind: "rejected", failureDetail: "E_RATE_LIMIT_EXCEEDED" };

    await world.runAt(NOW_MS);
    expect((await world.jobs()).map((item) => [item.state, item.failureClass])).toEqual([
      ["rejected", "provider"],
      ["rejected", "notification_failed"],
    ]);
    expect(await world.job(job.jobId)).toMatchObject({ failureDetail: "E_RATE_LIMIT_EXCEEDED" });
  });

  it("keeps the provider id when it is not a valid Message-ID", async () => {
    const world = await createWorld();
    world.sender.next = {
      kind: "accepted",
      providerMessageId: "not-an-rfc-id",
      rfcMessageId: normalizeRfcMessageId("not-an-rfc-id"),
    };
    const job = await world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });

    await world.runAt(NOW_MS);
    expect(await world.job(job.jobId)).toMatchObject({
      state: "accepted",
      providerMessageId: "not-an-rfc-id",
      rfcMessageId: null,
    });
  });

  it("sets the alarm for the earliest of every kind of due work", async () => {
    const approvals = await createWorld();
    await approvals.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
    await approvals.runAt(NOW_MS);
    expect(approvals.storage.alarm).toBe(Date.parse(approvals.lastExpiresAt));

    const receipts = await createWorld();
    await receipts.registerReceipt("receipt-1");
    await receipts.runAt(NOW_MS);
    expect(receipts.storage.alarm).toBe(NOW_MS + 5 * MINUTE);

    const claims = await createWorld();
    const job = await claims.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
    claimJob(claims.storage, {
      jobId: job.jobId,
      attemptId: "crashed-attempt",
      nowIso: NOW,
      claimExpiresAt: iso(NOW_MS + 15 * MINUTE),
      policy: OPERATOR_POLICY,
    });
    await claims.runAt(NOW_MS);
    expect(claims.storage.alarm).toBe(NOW_MS + 15 * MINUTE);
  });
});

async function createWorld(htmlPolicy: MailHtmlPolicy = new FakeMailHtmlPolicy()) {
  const { storage, account } = createMemoryAccount();
  const address = await Effect.runPromise(
    account.createAddress("inbox", MAIL_DOMAIN, "Inbox", NOW),
  );
  if (address === null) throw new Error("expected mailbox");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const sender = new FakeSender();
  const world = {
    storage,
    account,
    sender,
    key,
    indexed: [] as Array<string>,
    failIndex: false,
    policyFor: (requester: OutboundRequester): Effect.Effect<PrincipalPolicy | null> =>
      Effect.succeed(requester.kind === "operator" ? OPERATOR_POLICY : NEEDS_APPROVAL),
    lastApprovalId: "",
    lastTokenHash: "" as Parameters<typeof account.decideApproval>[0]["tokenHash"],
    lastExpiresAt: "",
    async submit(input: {
      readonly requester: OutboundRequester;
      readonly policy: PrincipalPolicy;
      readonly htmlBody?: string;
    }) {
      const approval = await Effect.runPromise(
        newApprovalCapability(key, NOW).pipe(Effect.provide(WebCrypto)),
      );
      world.lastApprovalId = approval.approvalId;
      world.lastTokenHash = approval.tokenHash;
      world.lastExpiresAt = approval.expiresAt;
      const submitted = await Effect.runPromise(
        account.submitOutbound({
          requestId: Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID()),
          requester: input.requester,
          policy: input.policy,
          mailboxId: address.id,
          subject: "Hello",
          textBody: "Hello there",
          htmlBody: input.htmlBody ?? null,
          hasRemoteImages: false,
          to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
          cc: [],
          inReplyToHeader: null,
          referencesHeader: null,
          nowIso: NOW,
          approval,
        }),
      );
      return submitted.job;
    },
    registerReceipt(receiptId: string) {
      return Effect.runPromise(
        account.registerInboundReceipt({
          receiptId,
          envelopeFrom: "sender@example.com",
          envelopeTo: "inbox@umail.example.com",
          rawKey: `raw/${receiptId}`,
          receivedAt: NOW,
        }),
      );
    },
    job(jobId: string) {
      return Effect.runPromise(account.getOutboundJob(jobId, { kind: "operator" }));
    },
    async jobs() {
      const page = await Effect.runPromise(
        account.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 }),
      );
      return [...page.items].sort((left, right) => left.purpose.localeCompare(right.purpose));
    },
    runAt(nowMs: number) {
      const ports: DueWorkPorts<never> = {
        sender,
        htmlPolicy,
        applicationUrl: new URL("https://umail.example.com"),
        notification: {
          key: Effect.succeed(key),
          mailDomain: MAIL_DOMAIN,
          approvalAdminEmail: OPERATOR_EMAIL,
        },
        policyFor: (requester) => world.policyFor(requester),
        index: {
          send: (body) =>
            world.failIndex
              ? Effect.fail(new Error("queue unavailable"))
              : Effect.sync(() => {
                  world.indexed.push(body.receiptId);
                }),
        },
      };
      return Effect.runPromise(
        runDueWork(storage, ports, nowMs).pipe(Effect.provide(WorkerServices)),
      );
    },
  };
  return world;
}

class FakeSender implements EmailSender {
  readonly mails: Array<ProviderOutboundMail> = [];
  next: CompleteAttemptOutcome = {
    kind: "accepted",
    providerMessageId: "prov-1",
    rfcMessageId: null,
  };

  send(mail: ProviderOutboundMail): Effect.Effect<CompleteAttemptOutcome> {
    return Effect.sync(() => {
      this.mails.push(mail);
      return this.next;
    });
  }
}

function policyWith(sendMode: PrincipalPolicy["sendMode"]): PrincipalPolicy {
  return {
    mailboxIds: "all",
    canRead: true,
    sendMode,
    recipientAllowlist: "any",
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function requireMailDomain(raw: string) {
  const parsed = parseMailDomain(raw);
  if (parsed.kind === "invalid") throw new Error("expected mail domain");
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") throw new Error("expected email");
  return parsed.address;
}
