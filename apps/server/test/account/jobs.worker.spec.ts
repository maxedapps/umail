/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  NormalizedRfcMessageId,
  OPERATOR_POLICY,
  parseExternalMailAddress,
  type PrincipalPolicy,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { accountStore, approvalMaterial, testPolicy } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const CLAIM_EXPIRES = "2026-01-01T00:15:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "ccccccca-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_B = "dddddddb-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_C = "eeeeeeec-eeee-4eee-8eee-eeeeeeeeeeee";
const PROVIDER_ID = Schema.decodeSync(NormalizedRfcMessageId)("<provider-1@cf.example>");

describe("account-store job execution", () => {
  it("treats mixed To/CC exemptions as requiring approval and rechecks policy at claim", async () => {
    const store = accountStore("jobs-mixed-exempt");
    const mailbox = await requireAddress(store, "inbox");
    const policy = testPolicy(
      { kind: "requireApproval", preapprovedRecipients: [requireExternal("exempt@example.com")] },
      {
        recipientAllowlist: [
          requireExternal("allowed@example.com"),
          requireExternal("exempt@example.com"),
        ],
      },
    );
    const mixed = await store.submitOutbound(
      mcpSubmit(mailbox.id, REQUEST_A, "agent", policy, {
        to: ["exempt@example.com"],
        cc: ["allowed@example.com"],
      }),
    );
    expect(mixed.job.state).toBe("waiting_approval");
    const exemptOnly = await store.submitOutbound(
      mcpSubmit(mailbox.id, REQUEST_B, "agent", policy, {
        to: ["exempt@example.com"],
      }),
    );
    expect(exemptOnly.job.state).toBe("ready");

    // The exemption was withdrawn after the submit.
    const narrowed = testPolicy(undefined, { recipientAllowlist: policy.recipientAllowlist });
    expect(
      await store.claimJob({
        jobId: exemptOnly.job.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
        policy: narrowed,
      }),
    ).toMatchObject({
      kind: "rejected",
      job: { state: "rejected", failureClass: "policy", failureDetail: "approval_required" },
    });
  });

  it("rejects a ready job once its requester has no access and never manufactures authority", async () => {
    const store = accountStore("jobs-revoke");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(
      mcpSubmit(mailbox.id, REQUEST_A, "agent", testPolicy({ kind: "allow" }), {
        to: ["recipient@example.com"],
      }),
    );
    expect(submitted.job.state).toBe("ready");
    expect(
      await store.claimJob({
        jobId: submitted.job.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
        policy: null,
      }),
    ).toMatchObject({
      kind: "rejected",
      job: { state: "rejected", failureClass: "policy", failureDetail: "client_inactive" },
    });
  });

  it("keeps pre-dispatch preparation retryable and matches attempt ids on completion", async () => {
    const store = accountStore("jobs-attempts");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A));
    expect(submitted.job.state).toBe("ready");
    expect(await store.getOutboundJob(submitted.job.jobId, { kind: "operator" })).toMatchObject({
      state: "ready",
      attemptId: null,
    });
    const claimed = await store.claimJob({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
      policy: OPERATOR_POLICY,
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") {
      throw new Error("expected claim");
    }
    expect(
      await store.claimJob({
        jobId: submitted.job.jobId,
        nowIso: NOW,
        claimExpiresAt: CLAIM_EXPIRES,
        policy: OPERATOR_POLICY,
      }),
    ).toMatchObject({ kind: "not_claimable", job: { state: "in_flight" } });
    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: "00000000-0000-4000-8000-000000000000",
        nowIso: NOW,
        outcome: { kind: "accepted", providerMessageId: "stale", rfcMessageId: null },
      }),
    ).toMatchObject({ kind: "stale", job: { state: "in_flight" } });
    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: claimed.attemptId,
        nowIso: NOW,
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: null },
      }),
    ).toMatchObject({
      kind: "applied",
      job: { state: "accepted", providerMessageId: "prov-1" },
    });
    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: claimed.attemptId,
        nowIso: LATER,
        outcome: { kind: "unknown" },
      }),
    ).toMatchObject({ kind: "applied", job: { state: "accepted", providerMessageId: "prov-1" } });
  });

  it("settles expired in-flight work as unknown and never returns it to ready", async () => {
    const store = accountStore("jobs-unknown");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A));
    const claimed = await store.claimJob({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
      policy: OPERATOR_POLICY,
    });
    expect(claimed.kind).toBe("claimed");

    await store.settleAbandonedClaims(NOW);
    expect(await store.getOutboundJob(submitted.job.jobId, { kind: "operator" })).toMatchObject({
      state: "in_flight",
    });
    await store.settleAbandonedClaims(LATER);
    expect(
      await store.claimJob({
        jobId: submitted.job.jobId,
        nowIso: LATER,
        claimExpiresAt: CLAIM_EXPIRES,
        policy: OPERATOR_POLICY,
      }),
    ).toMatchObject({ kind: "not_claimable", job: { state: "unknown" } });
    expect(await store.getOutboundJob(submitted.job.jobId, { kind: "operator" })).toMatchObject({
      state: "unknown",
    });
  });

  it("bounds job status to the operator or originating client and hides notification secrets", async () => {
    const store = accountStore("jobs-status");
    const mailbox = await requireAddress(store, "inbox");
    const pendingInput = mcpSubmit(mailbox.id, REQUEST_A, "agent", testPolicy(), {
      to: ["recipient@example.com"],
    });
    const pending = await store.submitOutbound(pendingInput);
    const other = await store.submitOutbound(
      mcpSubmit(mailbox.id, REQUEST_C, "other", testPolicy({ kind: "allow" }), {
        to: ["recipient@example.com"],
      }),
    );
    expect(pending.job.state).toBe("waiting_approval");
    const visible = await store.getOutboundJob(pending.job.jobId, {
      kind: "mcp",
      clientId: "agent",
    });
    expect(visible?.jobId).toBe(pending.job.jobId);
    expect(JSON.stringify(visible)).not.toContain(pendingInput.approval.tokenHash);
    expect(JSON.stringify(visible)).not.toContain(pendingInput.approval.approvalId);
    expect(
      await store.getOutboundJob(pending.job.jobId, { kind: "mcp", clientId: "other" }),
    ).toBeNull();
    const listed = await store.listOutboundJobs({
      viewer: { kind: "mcp", clientId: "agent" },
      limit: 50,
    });
    const listedIds = listed.items.map((item) => item.jobId);
    expect(listedIds).toContain(pending.job.jobId);
    expect(listedIds).not.toContain(other.job.jobId);
    expect(listed.items.some((item) => item.purpose === "approval_notification")).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(pendingInput.approval.tokenHash);
    const operatorPage = await store.listOutboundJobs({
      viewer: { kind: "operator" },
      limit: 1,
    });
    expect(operatorPage.items).toHaveLength(1);
    expect(operatorPage.nextCursor).not.toBeNull();
    const operatorAll = await store.listOutboundJobs({
      viewer: { kind: "operator" },
      limit: 50,
    });
    expect(operatorAll.items.map((item) => item.purpose).sort()).toEqual(
      ["approval_notification", "message", "message"].sort(),
    );
    expect(operatorAll.items.map((item) => item.jobId)).toContain(pending.job.jobId);
    expect(operatorAll.items.map((item) => item.jobId)).toContain(other.job.jobId);
  });

  it("records the accepted Message-ID so a later reply threads onto the sent message", async () => {
    const store = accountStore("jobs-rfc-claim");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A));
    const claimed = await store.claimJob({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
      policy: OPERATOR_POLICY,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected claim");
    }
    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: claimed.attemptId,
        nowIso: NOW,
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
      }),
    ).toMatchObject({ kind: "applied", job: { state: "accepted", rfcMessageId: PROVIDER_ID } });

    await store.acceptInboundWithReceipt({
      messageId: "inbound-reply",
      mailboxId: mailbox.id,
      rfcMessageId: "<reply@example.com>",
      inReplyToHeader: PROVIDER_ID,
      referencesHeader: PROVIDER_ID,
      occurredAt: LATER,
      nowIso: LATER,
      parsedDate: null,
    });
    const page = await store.listThreadMessageSummaries(submitted.job.threadId, {
      mailboxScope: "all",
    });
    expect(page.items.map((item) => item.id).sort()).toEqual(
      ["inbound-reply", submitted.job.messageId].sort(),
    );
    expect(page.items.find((item) => item.id === "inbound-reply")?.parentMessageId).toBe(
      submitted.job.messageId,
    );
    expect(page.items.find((item) => item.id === submitted.job.messageId)?.rfcMessageId).toBe(
      PROVIDER_ID,
    );

    const repeat = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_B));
    const repeatClaim = await store.claimJob({
      jobId: repeat.job.jobId,
      nowIso: LATER,
      claimExpiresAt: CLAIM_EXPIRES,
      policy: OPERATOR_POLICY,
    });
    if (repeatClaim.kind !== "claimed") {
      throw new Error("expected claim");
    }
    await store.completeAttempt({
      jobId: repeat.job.jobId,
      attemptId: repeatClaim.attemptId,
      nowIso: LATER,
      outcome: { kind: "accepted", providerMessageId: "prov-2", rfcMessageId: PROVIDER_ID },
    });
    // Messages that share a Message-ID share a thread.
    expect(
      (await store.listThreadMessageSummaries(repeat.job.threadId, { mailboxScope: "all" })).items
        .map((item) => item.id)
        .sort(),
    ).toEqual(["inbound-reply", submitted.job.messageId, repeat.job.messageId].sort());
  });
});

function operatorSubmit(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    policy: OPERATOR_POLICY,
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

function mcpSubmit(
  mailboxId: string,
  requestId: string,
  clientId: string,
  policy: PrincipalPolicy,
  options: {
    readonly to?: ReadonlyArray<string>;
    readonly cc?: ReadonlyArray<string>;
  },
) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "mcp" as const, clientId, label: `Client ${clientId}` },
    policy,
    mailboxId,
    subject: "Hello",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: (options.to ?? ["recipient@example.com"]).map(contact),
    cc: (options.cc ?? []).map(contact),
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: approvalMaterial(EXPIRES),
  };
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
