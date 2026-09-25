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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import type { ClaimJobResult, CompleteAttemptResult } from "../../src/account/domain.ts";
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
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("account-store job execution", () => {
  it.effect(
    "treats mixed To/CC exemptions as requiring approval and rechecks policy at claim",
    () =>
      Effect.gen(function* () {
        const store = accountStore("jobs-mixed-exempt");
        const mailbox = yield* requireAddress(store, "inbox");
        const policy = testPolicy(
          {
            kind: "requireApproval",
            preapprovedRecipients: [requireExternal("exempt@example.com")],
          },
          {
            recipientAllowlist: [
              requireExternal("allowed@example.com"),
              requireExternal("exempt@example.com"),
            ],
          },
        );
        const mixed = yield* Effect.promise(() =>
          store.submitOutbound(
            mcpSubmit(mailbox.id, REQUEST_A, "agent", policy, {
              to: ["exempt@example.com"],
              cc: ["allowed@example.com"],
            }),
          ),
        );
        expect(mixed.job.state).toBe("waiting_approval");
        const exemptOnly = yield* Effect.promise(() =>
          store.submitOutbound(
            mcpSubmit(mailbox.id, REQUEST_B, "agent", policy, {
              to: ["exempt@example.com"],
            }),
          ),
        );
        expect(exemptOnly.job.state).toBe("ready");

        // The exemption was withdrawn after the submit.
        const narrowed = testPolicy(undefined, { recipientAllowlist: policy.recipientAllowlist });
        expect(
          yield* Effect.promise<ClaimJobResult>(() =>
            store.claimJob({
              jobId: exemptOnly.job.jobId,
              nowIso: LATER,
              claimExpiresAt: CLAIM_EXPIRES,
              policy: narrowed,
            }),
          ),
        ).toMatchObject({
          kind: "rejected",
          job: { state: "rejected", failureClass: "policy", failureDetail: "approval_required" },
        });
      }),
  );

  it.effect(
    "rejects a ready job once its requester has no access and never manufactures authority",
    () =>
      Effect.gen(function* () {
        const store = accountStore("jobs-revoke");
        const mailbox = yield* requireAddress(store, "inbox");
        const submitted = yield* Effect.promise(() =>
          store.submitOutbound(
            mcpSubmit(mailbox.id, REQUEST_A, "agent", testPolicy({ kind: "allow" }), {
              to: ["recipient@example.com"],
            }),
          ),
        );
        expect(submitted.job.state).toBe("ready");
        expect(
          yield* Effect.promise<ClaimJobResult>(() =>
            store.claimJob({
              jobId: submitted.job.jobId,
              nowIso: LATER,
              claimExpiresAt: CLAIM_EXPIRES,
              policy: null,
            }),
          ),
        ).toMatchObject({
          kind: "rejected",
          job: { state: "rejected", failureClass: "policy", failureDetail: "client_inactive" },
        });
      }),
  );

  it.effect("keeps pre-dispatch preparation retryable and matches attempt ids on completion", () =>
    Effect.gen(function* () {
      const store = accountStore("jobs-attempts");
      const mailbox = yield* requireAddress(store, "inbox");
      const submitted = yield* Effect.promise(() =>
        store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A)),
      );
      expect(submitted.job.state).toBe("ready");
      expect(
        yield* Effect.promise(() =>
          store.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
        ),
      ).toMatchObject({
        state: "ready",
        attemptId: null,
      });
      const claimed = yield* Effect.promise<ClaimJobResult>(() =>
        store.claimJob({
          jobId: submitted.job.jobId,
          nowIso: NOW,
          claimExpiresAt: CLAIM_EXPIRES,
          policy: OPERATOR_POLICY,
        }),
      );
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") {
        throw new Error("expected claim");
      }
      expect(
        yield* Effect.promise<ClaimJobResult>(() =>
          store.claimJob({
            jobId: submitted.job.jobId,
            nowIso: NOW,
            claimExpiresAt: CLAIM_EXPIRES,
            policy: OPERATOR_POLICY,
          }),
        ),
      ).toMatchObject({ kind: "not_claimable", job: { state: "in_flight" } });
      expect(
        yield* Effect.promise<CompleteAttemptResult>(() =>
          store.completeAttempt({
            jobId: submitted.job.jobId,
            attemptId: "00000000-0000-4000-8000-000000000000",
            nowIso: NOW,
            outcome: { kind: "accepted", providerMessageId: "stale", rfcMessageId: null },
          }),
        ),
      ).toMatchObject({ kind: "stale", job: { state: "in_flight" } });
      expect(
        yield* Effect.promise<CompleteAttemptResult>(() =>
          store.completeAttempt({
            jobId: submitted.job.jobId,
            attemptId: claimed.attemptId,
            nowIso: NOW,
            outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: null },
          }),
        ),
      ).toMatchObject({
        kind: "applied",
        job: { state: "accepted", providerMessageId: "prov-1" },
      });
      expect(
        yield* Effect.promise<CompleteAttemptResult>(() =>
          store.completeAttempt({
            jobId: submitted.job.jobId,
            attemptId: claimed.attemptId,
            nowIso: LATER,
            outcome: { kind: "unknown" },
          }),
        ),
      ).toMatchObject({ kind: "applied", job: { state: "accepted", providerMessageId: "prov-1" } });
    }),
  );

  it.effect("settles expired in-flight work as unknown and never returns it to ready", () =>
    Effect.gen(function* () {
      const store = accountStore("jobs-unknown");
      const mailbox = yield* requireAddress(store, "inbox");
      const submitted = yield* Effect.promise(() =>
        store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A)),
      );
      const claimed = yield* Effect.promise<ClaimJobResult>(() =>
        store.claimJob({
          jobId: submitted.job.jobId,
          nowIso: NOW,
          claimExpiresAt: CLAIM_EXPIRES,
          policy: OPERATOR_POLICY,
        }),
      );
      expect(claimed.kind).toBe("claimed");

      yield* Effect.promise(() => store.settleAbandonedClaims(NOW));
      expect(
        yield* Effect.promise(() =>
          store.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
        ),
      ).toMatchObject({
        state: "in_flight",
      });
      yield* Effect.promise(() => store.settleAbandonedClaims(LATER));
      expect(
        yield* Effect.promise<ClaimJobResult>(() =>
          store.claimJob({
            jobId: submitted.job.jobId,
            nowIso: LATER,
            claimExpiresAt: CLAIM_EXPIRES,
            policy: OPERATOR_POLICY,
          }),
        ),
      ).toMatchObject({ kind: "not_claimable", job: { state: "unknown" } });
      expect(
        yield* Effect.promise(() =>
          store.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
        ),
      ).toMatchObject({
        state: "unknown",
      });
    }),
  );

  it.effect(
    "bounds job status to the operator or originating client and hides notification secrets",
    () =>
      Effect.gen(function* () {
        const store = accountStore("jobs-status");
        const mailbox = yield* requireAddress(store, "inbox");
        const pendingInput = mcpSubmit(mailbox.id, REQUEST_A, "agent", testPolicy(), {
          to: ["recipient@example.com"],
        });
        const pending = yield* Effect.promise(() => store.submitOutbound(pendingInput));
        const other = yield* Effect.promise(() =>
          store.submitOutbound(
            mcpSubmit(mailbox.id, REQUEST_C, "other", testPolicy({ kind: "allow" }), {
              to: ["recipient@example.com"],
            }),
          ),
        );
        expect(pending.job.state).toBe("waiting_approval");
        const visible = yield* Effect.promise(() =>
          store.getOutboundJob(pending.job.jobId, {
            kind: "mcp",
            clientId: "agent",
          }),
        );
        expect(visible?.jobId).toBe(pending.job.jobId);
        expect(toJson(visible)).not.toContain(pendingInput.approval.tokenHash);
        expect(toJson(visible)).not.toContain(pendingInput.approval.approvalId);
        expect(
          yield* Effect.promise(() =>
            store.getOutboundJob(pending.job.jobId, { kind: "mcp", clientId: "other" }),
          ),
        ).toBeNull();
        const listed = yield* Effect.promise(() =>
          store.listOutboundJobs({
            viewer: { kind: "mcp", clientId: "agent" },
            limit: 50,
          }),
        );
        const listedIds = listed.items.map((item) => item.jobId);
        expect(listedIds).toContain(pending.job.jobId);
        expect(listedIds).not.toContain(other.job.jobId);
        expect(listed.items.some((item) => item.purpose === "approval_notification")).toBe(true);
        expect(toJson(listed)).not.toContain(pendingInput.approval.tokenHash);
        const operatorPage = yield* Effect.promise(() =>
          store.listOutboundJobs({
            viewer: { kind: "operator" },
            limit: 1,
          }),
        );
        expect(operatorPage.items).toHaveLength(1);
        expect(operatorPage.nextCursor).not.toBeNull();
        const operatorAll = yield* Effect.promise(() =>
          store.listOutboundJobs({
            viewer: { kind: "operator" },
            limit: 50,
          }),
        );
        expect(operatorAll.items.map((item) => item.purpose).sort()).toEqual(
          ["approval_notification", "message", "message"].sort(),
        );
        expect(operatorAll.items.map((item) => item.jobId)).toContain(pending.job.jobId);
        expect(operatorAll.items.map((item) => item.jobId)).toContain(other.job.jobId);
      }),
  );

  it.effect("records the accepted Message-ID so a later reply threads onto the sent message", () =>
    Effect.gen(function* () {
      const store = accountStore("jobs-rfc-claim");
      const mailbox = yield* requireAddress(store, "inbox");
      const submitted = yield* Effect.promise(() =>
        store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A)),
      );
      const claimed = yield* Effect.promise<ClaimJobResult>(() =>
        store.claimJob({
          jobId: submitted.job.jobId,
          nowIso: NOW,
          claimExpiresAt: CLAIM_EXPIRES,
          policy: OPERATOR_POLICY,
        }),
      );
      if (claimed.kind !== "claimed") {
        throw new Error("expected claim");
      }
      expect(
        yield* Effect.promise<CompleteAttemptResult>(() =>
          store.completeAttempt({
            jobId: submitted.job.jobId,
            attemptId: claimed.attemptId,
            nowIso: NOW,
            outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
          }),
        ),
      ).toMatchObject({ kind: "applied", job: { state: "accepted", rfcMessageId: PROVIDER_ID } });

      yield* Effect.promise(() =>
        store.acceptInboundWithReceipt({
          messageId: "inbound-reply",
          mailboxId: mailbox.id,
          rfcMessageId: "<reply@example.com>",
          inReplyToHeader: PROVIDER_ID,
          referencesHeader: PROVIDER_ID,
          occurredAt: LATER,
          nowIso: LATER,
          parsedDate: null,
        }),
      );
      const page = yield* Effect.promise(() =>
        store.listThreadMessageSummaries(submitted.job.threadId, {
          mailboxScope: "all",
        }),
      );
      expect(page.items.map((item) => item.id).sort()).toEqual(
        ["inbound-reply", submitted.job.messageId].sort(),
      );
      expect(page.items.find((item) => item.id === "inbound-reply")?.parentMessageId).toBe(
        submitted.job.messageId,
      );
      expect(page.items.find((item) => item.id === submitted.job.messageId)?.rfcMessageId).toBe(
        PROVIDER_ID,
      );

      const repeat = yield* Effect.promise(() =>
        store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_B)),
      );
      const repeatClaim = yield* Effect.promise<ClaimJobResult>(() =>
        store.claimJob({
          jobId: repeat.job.jobId,
          nowIso: LATER,
          claimExpiresAt: CLAIM_EXPIRES,
          policy: OPERATOR_POLICY,
        }),
      );
      if (repeatClaim.kind !== "claimed") {
        throw new Error("expected claim");
      }
      yield* Effect.promise<CompleteAttemptResult>(() =>
        store.completeAttempt({
          jobId: repeat.job.jobId,
          attemptId: repeatClaim.attemptId,
          nowIso: LATER,
          outcome: { kind: "accepted", providerMessageId: "prov-2", rfcMessageId: PROVIDER_ID },
        }),
      );
      // Messages that share a Message-ID share a thread.
      expect(
        (yield* Effect.promise(() =>
          store.listThreadMessageSummaries(repeat.job.threadId, { mailboxScope: "all" }),
        )).items
          .map((item) => item.id)
          .sort(),
      ).toEqual(["inbound-reply", submitted.job.messageId, repeat.job.messageId].sort());
    }),
  );
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

const requireAddress = Effect.fn("requireAddress")(function* (
  store: DurableObjectStub<AccountStoreTestHost>,
  localPart: string,
) {
  const created = yield* Effect.promise(() =>
    store.createAddress(localPart, DOMAIN, localPart, NOW),
  );
  if (created === null) {
    throw new Error(`expected address ${localPart}`);
  }
  return created;
});

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
