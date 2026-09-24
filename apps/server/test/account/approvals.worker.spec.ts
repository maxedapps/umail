/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  NormalizedRfcMessageId,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { StoredApproval } from "../../src/account/domain.ts";
import { accountStore, approvalMaterial } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const EXPIRES = "2026-01-01T00:30:00.000Z";
const CLAIM_EXPIRES = "2026-01-01T00:15:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROVIDER_ID = Schema.decodeSync(NormalizedRfcMessageId)("<provider-1@cf.example>");
const NOTIFICATION_ID = Schema.decodeSync(NormalizedRfcMessageId)("<notify-1@cf.example>");

describe("account-store approval decisions", () => {
  it("keeps capability GET read-only even after the approval is due", async () => {
    const store = accountStore("approval-get-readonly");
    const seeded = await seedPending(store, REQUEST_A);
    const before = await store.lookupApprovalByTokenHash(seeded.tokenHash);
    expect(before).toMatchObject({
      kind: "found",
      approval: { state: "pending" },
      job: { state: "waiting_approval" },
    });
    const later = await store.lookupApprovalByTokenHash(seeded.tokenHash);
    expect(later).toEqual(before);
    expect(await store.getOutboundJob(seeded.jobId, { kind: "operator" })).toMatchObject({
      state: "waiting_approval",
    });
  });

  it("keeps one winner across same and opposite decision races", async () => {
    const store = accountStore("approval-races");
    const seeded = await seedPending(store, REQUEST_A);
    const first = await store.decideApproval({
      tokenHash: seeded.tokenHash,
      decision: "approved",
      nowIso: NOW,
    });
    const same = await store.decideApproval({
      tokenHash: seeded.tokenHash,
      decision: "approved",
      nowIso: LATER,
    });
    const opposite = await store.decideApproval({
      tokenHash: seeded.tokenHash,
      decision: "denied",
      nowIso: LATER,
    });
    expect(first).toMatchObject({ kind: "claimed", state: "approved", job: { state: "ready" } });
    expect(same).toMatchObject({ kind: "resolved", state: "approved", job: { state: "ready" } });
    expect(opposite).toMatchObject({
      kind: "resolved",
      state: "approved",
      job: { state: "ready" },
    });
  });

  it("denies and expires undispatched work without dispatching", async () => {
    const deniedStore = accountStore("approval-denied");
    const deniedSeed = await seedPending(deniedStore, REQUEST_A);
    expect(
      await deniedStore.decideApproval({
        tokenHash: deniedSeed.tokenHash,
        decision: "denied",
        nowIso: NOW,
      }),
    ).toMatchObject({
      kind: "claimed",
      state: "denied",
      job: { state: "rejected", failureClass: "denied" },
    });
    expect(
      await deniedStore.claimDispatch({
        jobId: deniedSeed.jobId,
        nowIso: NOW,
        claimExpiresAt: CLAIM_EXPIRES,
      }),
    ).toMatchObject({ kind: "not_claimable", job: { state: "rejected" } });

    const expiredStore = accountStore("approval-expired");
    const expiredSeed = await seedPending(expiredStore, REQUEST_A);
    expect(
      await expiredStore.decideApproval({
        tokenHash: expiredSeed.tokenHash,
        decision: "approved",
        nowIso: LATER,
      }),
    ).toMatchObject({
      kind: "resolved",
      state: "expired",
      job: { state: "rejected", failureClass: "expired" },
    });
  });

  it("cancels the approval when its notification is rejected", async () => {
    const store = accountStore("approval-notification-rejected");
    const seeded = await seedPending(store, REQUEST_A);
    const notification = await requireNotificationJob(store);
    const claimed = await store.claimDispatch({
      jobId: notification.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected notification claim");
    }
    await store.completeAttempt({
      jobId: notification.jobId,
      attemptId: claimed.attemptId,
      nowIso: LATER,
      outcome: { kind: "rejected", failureDetail: "E_VALIDATION_ERROR" },
    });
    await expectNotificationFailed(store, seeded.tokenHash);

    const unsendable = accountStore("approval-notification-unsendable");
    const unsendableSeed = await seedPending(unsendable, REQUEST_A);
    await unsendable.rejectReadyDispatch({
      jobId: (await requireNotificationJob(unsendable)).jobId,
      nowIso: LATER,
      failureDetail: "resource_exhausted",
    });
    await expectNotificationFailed(unsendable, unsendableSeed.tokenHash);
  });

  it("keeps the approval waiting when its notification settles unknown", async () => {
    const store = accountStore("approval-notification-unknown");
    const seeded = await seedPending(store, REQUEST_A);
    const notification = await requireNotificationJob(store);
    const claimed = await store.claimDispatch({
      jobId: notification.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected notification claim");
    }
    await store.completeAttempt({
      jobId: notification.jobId,
      attemptId: claimed.attemptId,
      nowIso: NOW,
      outcome: { kind: "unknown" },
    });
    expect(await store.lookupApprovalByTokenHash(seeded.tokenHash)).toMatchObject({
      kind: "found",
      approval: { state: "pending" },
      job: { state: "waiting_approval" },
    });
    expect(
      await store.decideApproval({
        tokenHash: seeded.tokenHash,
        decision: "approved",
        nowIso: NOW,
      }),
    ).toMatchObject({ kind: "claimed", state: "approved", job: { state: "ready" } });
  });

  it("makes an approved waiting job ready for a later dispatch claim", async () => {
    const store = accountStore("approval-then-claim");
    const seeded = await seedPending(store, REQUEST_A);
    expect(
      await store.decideApproval({
        tokenHash: seeded.tokenHash,
        decision: "approved",
        nowIso: NOW,
      }),
    ).toMatchObject({ kind: "claimed", state: "approved", job: { state: "ready" } });
    const claimed = await store.claimDispatch({
      jobId: seeded.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    expect(claimed.kind).toBe("claimed");
  });

  it("cancels a pending approval when its message is deleted before a claim", async () => {
    const store = accountStore("approval-delete");
    const seeded = await seedPending(store, REQUEST_A);
    const job = await store.getOutboundJob(seeded.jobId, { kind: "operator" });
    if (job === null) {
      throw new Error("expected job");
    }
    await store.softDeleteThread(job.threadId, "all", LATER);
    expect(await store.lookupApprovalByTokenHash(seeded.tokenHash)).toMatchObject({
      kind: "found",
      approval: { state: "cancelled" },
      job: { state: "rejected", failureClass: "cancelled" },
    });
    expect(
      await store.claimDispatch({
        jobId: seeded.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
      }),
    ).toMatchObject({ kind: "not_claimable", job: { state: "rejected" } });
  });

  it("does not cancel an in-flight claim when the message is later deleted", async () => {
    const store = accountStore("approval-delete-inflight");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(readyInput(mailbox.id, REQUEST_B));
    const claimed = await store.claimDispatch({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    expect(claimed.kind).toBe("claimed");
    await store.softDeleteThread(submitted.job.threadId, "all", LATER);
    expect(await store.getOutboundJob(submitted.job.jobId, { kind: "operator" })).toMatchObject({
      state: "in_flight",
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected claim");
    }
    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: claimed.attemptId,
        nowIso: LATER,
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: null },
      }),
    ).toMatchObject({ kind: "applied", job: { state: "accepted" } });
  });

  it("rejects an approval notification claim after the originating MCP client is revoked", async () => {
    const store = accountStore("approval-notification-revoked");
    const seeded = await seedPending(store, REQUEST_A);
    const notification = await requireNotificationJob(store);
    await store.revokeMcpOAuthPolicy("agent", LATER);

    expect(
      await store.claimDispatch({
        jobId: notification.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
      }),
    ).toMatchObject({
      kind: "rejected",
      job: {
        state: "rejected",
        failureClass: "policy",
        failureDetail: "client_inactive",
      },
    });
    await expectNotificationFailed(store, seeded.tokenHash);
  });

  it("rejects an approval notification claim when the originating MCP policy denies sending", async () => {
    const store = accountStore("approval-notification-denied");
    const seeded = await seedPending(store, REQUEST_A);
    const notification = await requireNotificationJob(store);
    await store.updateMcpOAuthPolicy({
      clientId: "agent",
      label: "Client agent",
      policy: {
        mailboxIds: "all",
        canRead: true,
        canDelete: false,
        sendMode: { kind: "deny" },
        recipientAllowlist: "any",
        canAdmin: false,
      },
      updatedAt: LATER,
    });

    expect(
      await store.claimDispatch({
        jobId: notification.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
      }),
    ).toMatchObject({
      kind: "rejected",
      job: { state: "rejected", failureClass: "policy", failureDetail: "send_denied" },
    });
    await expectNotificationFailed(store, seeded.tokenHash);
  });

  it("keeps the approved message's own Message-ID after the notification was sent first", async () => {
    const store = accountStore("approval-rfc-claim");
    const seeded = await seedPending(store, REQUEST_A);
    const notification = await requireNotificationJob(store);
    const notificationClaim = await store.claimDispatch({
      jobId: notification.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (notificationClaim.kind !== "claimed") {
      throw new Error("expected notification claim");
    }
    await store.completeAttempt({
      jobId: notification.jobId,
      attemptId: notificationClaim.attemptId,
      nowIso: NOW,
      outcome: {
        kind: "accepted",
        providerMessageId: "prov-notify",
        rfcMessageId: NOTIFICATION_ID,
      },
    });
    expect(await store.getOutboundJob(notification.jobId, { kind: "operator" })).toMatchObject({
      state: "accepted",
      rfcMessageId: NOTIFICATION_ID,
    });

    await store.decideApproval({
      tokenHash: seeded.tokenHash,
      decision: "approved",
      nowIso: NOW,
    });
    const claimed = await store.claimDispatch({
      jobId: seeded.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected message claim");
    }
    expect(
      await store.completeAttempt({
        jobId: seeded.jobId,
        attemptId: claimed.attemptId,
        nowIso: NOW,
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
      }),
    ).toMatchObject({ kind: "applied", job: { state: "accepted" } });

    const job = await store.getOutboundJob(seeded.jobId, { kind: "operator" });
    if (job === null) {
      throw new Error("expected job");
    }
    const page = await store.listThreadMessageSummaries(job.threadId, {
      mailboxScope: "all",
    });
    expect(page.items.find((item) => item.id === job.messageId)?.rfcMessageId).toBe(PROVIDER_ID);
  });
});

async function expectNotificationFailed(
  store: DurableObjectStub<AccountStoreTestHost>,
  tokenHash: StoredApproval["tokenHash"],
) {
  expect(await store.lookupApprovalByTokenHash(tokenHash)).toMatchObject({
    kind: "found",
    approval: { state: "cancelled" },
    job: { state: "rejected", failureClass: "notification_failed" },
  });
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

async function seedPending(store: DurableObjectStub<AccountStoreTestHost>, requestId: string) {
  const mailbox = await requireAddress(store, "inbox");
  await seedOauthPolicy(store, "agent");
  const approval = approvalMaterial(EXPIRES);
  const submitted = await store.submitOutbound({
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "mcp", clientId: "agent", label: "Client agent" },
    mailboxId: mailbox.id,
    subject: "Review me",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [contact("recipient@example.com")],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval,
  });
  if (submitted.approval === null) {
    throw new Error("expected pending approval");
  }
  return {
    jobId: submitted.job.jobId,
    tokenHash: approval.tokenHash,
  };
}

function readyInput(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    mailboxId,
    subject: "Direct",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [contact("recipient@example.com")],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: approvalMaterial(EXPIRES),
  };
}

async function seedOauthPolicy(store: DurableObjectStub<AccountStoreTestHost>, clientId: string) {
  await store.ensureMcpOAuthPolicy({
    clientId,
    label: `Client ${clientId}`,
    createdAt: NOW,
  });
}

async function requireAddress(store: DurableObjectStub<AccountStoreTestHost>, localPart: string) {
  const created = await store.createAddress(localPart, DOMAIN, localPart, NOW);
  if (created === null) {
    throw new Error(`expected address ${localPart}`);
  }
  return created;
}

function contact(address: string) {
  return { address: requireExternal(address), displayName: null };
}

function requireMailDomain(raw: string): MailDomain {
  const parsed = parseMailDomain(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected external address");
  }
  return parsed.address;
}
