import {
  OPERATOR_POLICY,
  SubmissionRequestId,
  normalizeRfcMessageId,
  parseExternalMailAddress,
  parseMailDomain,
  requireApprovalSendMode,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { createMailHtmlPolicy, type MailHtmlPolicy } from "../../src/mail/html-policy.ts";
import type { CompleteAttemptOutcome, OutboundRequester } from "../../src/account/domain.ts";
import { FAILED_STEP_RETRY_MS, runDueWork, type DueWorkPorts } from "../../src/account/due-work.ts";
import { claimJob } from "../../src/account/jobs.ts";
import { WebCrypto, randomId } from "../../src/crypto.ts";
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
  // Submitting arms the alarm from the real clock, so these tests run live.
  it.live("arms the alarm on submit and sends a ready job exactly once", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const before = yield* Clock.currentTimeMillis;
      const job = yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
      expect(job.state).toBe("ready");
      expect(world.storage.alarm).toBeGreaterThanOrEqual(before);
      expect(world.storage.alarm).toBeLessThanOrEqual(yield* Clock.currentTimeMillis);

      yield* world.runAt(NOW_MS);
      yield* world.runAt(NOW_MS + SECOND);
      expect(world.sender.mails).toHaveLength(1);
      expect(world.sender.mails[0]?.subject).toBe("Hello");
      expect(yield* world.job(job.jobId)).toMatchObject({
        state: "accepted",
        providerMessageId: "prov-1",
      });
      expect(world.storage.alarm).toBeNull();
    }),
  );

  it.live("notifies the operator, then sends the message once it is approved", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const job = yield* world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
      expect(job.state).toBe("waiting_approval");

      yield* world.runAt(NOW_MS);
      const notice = world.sender.mails[0];
      expect(world.sender.mails).toHaveLength(1);
      expect(notice).toMatchObject({
        to: [OPERATOR_EMAIL],
        subject: APPROVAL_NOTIFICATION_SUBJECT,
      });
      // Canned copy: the requester's subject and body never reach the operator's inbox.
      expect(notice?.text).not.toContain("Hello");
      const token = yield* deriveApprovalToken(world.key, world.lastApprovalId);
      expect(notice?.text).toContain(`https://umail.example.com/approvals/${token}`);
      // The pending approval's deadline keeps the alarm set.
      expect(world.storage.alarm).toBe(Date.parse(world.lastExpiresAt));

      const decision = yield* world.account.decideApproval({
        tokenHash: world.lastTokenHash,
        decision: "approved",
        nowIso: NOW,
      });
      expect(decision).toMatchObject({ kind: "claimed", job: { state: "ready" } });
      expect(world.storage.alarm).toBeLessThanOrEqual(yield* Clock.currentTimeMillis);

      yield* world.runAt(NOW_MS + MINUTE);
      expect(world.sender.mails.map((mail) => mail.subject)).toEqual([
        APPROVAL_NOTIFICATION_SUBJECT,
        "Hello",
      ]);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "accepted" });
    }),
  );

  it.effect("expires a due approval and rejects both of its unsent jobs", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const job = yield* world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });

      yield* world.runAt(Date.parse(world.lastExpiresAt));
      expect(world.sender.mails).toHaveLength(0);
      const jobs = yield* world.jobs();
      expect(jobs.map((item) => [item.purpose, item.state, item.failureClass])).toEqual([
        ["approval_notification", "rejected", "expired"],
        ["message", "rejected", "expired"],
      ]);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "rejected" });
      expect(world.storage.alarm).toBeNull();
    }),
  );

  it.effect("never sends a claimed job again and settles it unknown once the claim expires", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const job = yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
      // A pass that crashed between its claim and the provider call.
      claimJob(world.storage, {
        jobId: job.jobId,
        attemptId: "crashed-attempt",
        nowIso: NOW,
        claimExpiresAt: iso(NOW_MS + 15 * MINUTE),
        policy: OPERATOR_POLICY,
      });

      yield* world.runAt(NOW_MS + MINUTE);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "in_flight" });
      expect(world.storage.alarm).toBe(NOW_MS + 15 * MINUTE);

      yield* world.runAt(NOW_MS + 15 * MINUTE);
      expect(world.sender.mails).toHaveLength(0);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "unknown" });
    }),
  );

  it.effect("keeps sending when redrive fails, and re-arms for the next redrive", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      world.failIndex = true;
      yield* world.registerReceipt("receipt-1");
      const job = yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });

      // The receipt is due five minutes after it arrived; its next redrive backs off by its age.
      yield* world.runAt(NOW_MS + 5 * MINUTE);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "accepted" });
      expect(world.indexed).toEqual([]);
      expect(world.storage.alarm).toBe(NOW_MS + 10 * MINUTE);

      world.failIndex = false;
      yield* world.runAt(NOW_MS + 10 * MINUTE);
      expect(world.indexed).toEqual(["receipt-1"]);
    }),
  );

  it.effect("retries a failing send step after a minute instead of spinning", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const job = yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
      world.policyFor = () => Effect.die(new Error("policy lookup failed"));

      yield* world.runAt(NOW_MS);
      expect(yield* world.job(job.jobId)).toMatchObject({ state: "ready" });
      expect(world.storage.alarm).toBe(NOW_MS + FAILED_STEP_RETRY_MS);
    }),
  );

  it.effect("sends at most ten jobs per pass and re-arms at once while work remains", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      for (let index = 0; index < 11; index += 1) {
        yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
      }

      yield* world.runAt(NOW_MS);
      expect(world.sender.mails).toHaveLength(10);
      expect(world.storage.alarm).toBe(NOW_MS);

      yield* world.runAt(NOW_MS + SECOND);
      expect(world.sender.mails).toHaveLength(11);
      expect(world.storage.alarm).toBeNull();
    }),
  );

  it.effect(
    "records HTML that cannot be prepared as a policy rejection without a provider call",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld(createMailHtmlPolicy());
        const job = yield* world.submit({
          requester: OPERATOR,
          policy: OPERATOR_POLICY,
          htmlBody: "<b></b>".repeat(20_000),
        });

        yield* world.runAt(NOW_MS);
        expect(world.sender.mails).toHaveLength(0);
        expect(yield* world.job(job.jobId)).toMatchObject({
          state: "rejected",
          attemptId: null,
          failureClass: "policy",
          failureDetail: "resource_exhausted",
        });
      }),
  );

  it.effect(
    "rejects both jobs as policy when the notification's requester may no longer send",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        yield* world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
        world.policyFor = () => Effect.succeed(policyWith({ kind: "deny" }));

        yield* world.runAt(NOW_MS);
        expect(world.sender.mails).toHaveLength(0);
        expect((yield* world.jobs()).map((item) => [item.state, item.failureClass])).toEqual([
          ["rejected", "policy"],
          ["rejected", "policy"],
        ]);
        expect(yield* world.account.lookupApprovalByTokenHash(world.lastTokenHash)).toMatchObject({
          approval: { state: "cancelled" },
        });
      }),
  );

  it.effect("gives up on the message when Cloudflare rejects its notification", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const job = yield* world.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
      world.sender.next = { kind: "rejected", failureDetail: "E_RATE_LIMIT_EXCEEDED" };

      yield* world.runAt(NOW_MS);
      expect((yield* world.jobs()).map((item) => [item.state, item.failureClass])).toEqual([
        ["rejected", "provider"],
        ["rejected", "notification_failed"],
      ]);
      expect(yield* world.job(job.jobId)).toMatchObject({ failureDetail: "E_RATE_LIMIT_EXCEEDED" });
    }),
  );

  it.effect("keeps the provider id when it is not a valid Message-ID", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      world.sender.next = {
        kind: "accepted",
        providerMessageId: "not-an-rfc-id",
        rfcMessageId: normalizeRfcMessageId("not-an-rfc-id"),
      };
      const job = yield* world.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });

      yield* world.runAt(NOW_MS);
      expect(yield* world.job(job.jobId)).toMatchObject({
        state: "accepted",
        providerMessageId: "not-an-rfc-id",
        rfcMessageId: null,
      });
    }),
  );

  it.effect("sets the alarm for the earliest of every kind of due work", () =>
    Effect.gen(function* () {
      const approvals = yield* createWorld();
      yield* approvals.submit({ requester: AGENT, policy: NEEDS_APPROVAL });
      yield* approvals.runAt(NOW_MS);
      expect(approvals.storage.alarm).toBe(Date.parse(approvals.lastExpiresAt));

      const receipts = yield* createWorld();
      yield* receipts.registerReceipt("receipt-1");
      yield* receipts.runAt(NOW_MS);
      expect(receipts.storage.alarm).toBe(NOW_MS + 5 * MINUTE);

      const claims = yield* createWorld();
      const job = yield* claims.submit({ requester: OPERATOR, policy: OPERATOR_POLICY });
      claimJob(claims.storage, {
        jobId: job.jobId,
        attemptId: "crashed-attempt",
        nowIso: NOW,
        claimExpiresAt: iso(NOW_MS + 15 * MINUTE),
        policy: OPERATOR_POLICY,
      });
      yield* claims.runAt(NOW_MS);
      expect(claims.storage.alarm).toBe(NOW_MS + 15 * MINUTE);
    }),
  );
});

const createWorld = Effect.fn("createWorld")(function* (
  htmlPolicy: MailHtmlPolicy = new FakeMailHtmlPolicy(),
) {
  const { storage, account } = createMemoryAccount();
  const address = yield* account.createAddress("inbox", MAIL_DOMAIN, "Inbox", NOW);
  if (address === null) return yield* Effect.die("expected mailbox");
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
    submit: Effect.fn("submit")(function* (input: {
      readonly requester: OutboundRequester;
      readonly policy: PrincipalPolicy;
      readonly htmlBody?: string;
    }) {
      const approval = yield* newApprovalCapability(key, NOW);
      world.lastApprovalId = approval.approvalId;
      world.lastTokenHash = approval.tokenHash;
      world.lastExpiresAt = approval.expiresAt;
      const requestId = yield* Schema.decodeEffect(SubmissionRequestId)(yield* randomId);
      const submitted = yield* account.submitOutbound({
        requestId,
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
      });
      return submitted.job;
    }, Effect.provide(WebCrypto)),
    registerReceipt(receiptId: string) {
      return account.registerInboundReceipt({
        receiptId,
        envelopeFrom: "sender@example.com",
        envelopeTo: "inbox@umail.example.com",
        rawKey: `raw/${receiptId}`,
        receivedAt: NOW,
      });
    },
    job(jobId: string) {
      return account.getOutboundJob(jobId, { kind: "operator" });
    },
    jobs() {
      return account
        .listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 })
        .pipe(
          Effect.map((page) =>
            [...page.items].sort((left, right) => left.purpose.localeCompare(right.purpose)),
          ),
        );
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
              ? Effect.fail(new QueueUnavailable())
              : Effect.sync(() => {
                  world.indexed.push(body.receiptId);
                }),
        },
      };
      return runDueWork(storage, ports, nowMs).pipe(Effect.provide(WorkerServices));
    },
  };
  return world;
});

class QueueUnavailable extends Data.TaggedError("QueueUnavailable") {}

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
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
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
