/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  OPERATOR_POLICY,
  approvalNotificationIdempotencyKey,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { SubmitOutboundInput } from "../../src/account/domain.ts";
import { accountStore, approvalMaterial, failureOf, taggedName, testPolicy } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const ALLOW = testPolicy({ kind: "allow" });

describe("account-store outbound submissions", () => {
  it("replays an identical principal-scoped key and conflicts on a changed payload", async () => {
    const store = accountStore("submit-replay");
    const mailbox = await requireAddress(store, "inbox");
    const first = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        subject: "Hello",
        to: ["recipient@example.com"],
      }),
    );
    expect(first.created).toBe(true);
    expect(first.job.state).toBe("ready");
    expect(first.job.state).not.toBe("accepted");

    const replay = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        subject: "Hello",
        to: ["recipient@example.com"],
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.job.jobId).toBe(first.job.jobId);
    expect(replay.job.state).toBe("ready");

    const conflictInput = composeInput(mailbox.id, REQUEST_A, {
      subject: "Changed",
      to: ["recipient@example.com"],
    });
    const conflict = await failureOf(store, (host) => host.submitOutbound(conflictInput));
    expect(taggedName(conflict)).toBe("SubmissionConflictError");
    expect(await store.getOutboundJob(first.job.jobId, { kind: "operator" })).toMatchObject({
      jobId: first.job.jobId,
      state: "ready",
    });
  });

  it("scopes keys per requester so two clients may reuse the same request id", async () => {
    const store = accountStore("submit-scoped-key");
    const mailbox = await requireAddress(store, "inbox");
    const first = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester("client-a"),
        policy: ALLOW,
        to: ["recipient@example.com"],
      }),
    );
    const second = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester("client-b"),
        policy: ALLOW,
        to: ["recipient@example.com"],
      }),
    );
    expect(first.job.jobId).not.toBe(second.job.jobId);
    expect(first.job.requestId).toBe(second.job.requestId);
  });

  it("isolates the same client and request id across operator and MCP authority", async () => {
    const store = accountStore("submit-cross-authority-key");
    const mailbox = await requireAddress(store, "inbox");
    const clientId = "shared-client";

    const operator = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: { kind: "operator", clientId, label: "AgentMail CLI" },
      }),
    );
    const mcp = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester(clientId),
        policy: ALLOW,
      }),
    );
    const replay = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester(clientId),
        policy: ALLOW,
      }),
    );

    expect(operator.created).toBe(true);
    expect(mcp.created).toBe(true);
    expect(mcp.job.jobId).not.toBe(operator.job.jobId);
    expect(replay).toMatchObject({ created: false, job: { jobId: mcp.job.jobId } });
    expect(await store.getOutboundJob(operator.job.jobId, { kind: "mcp", clientId })).toBeNull();
    expect(
      (
        await store.listOutboundJobs({
          viewer: { kind: "mcp", clientId },
          limit: 50,
        })
      ).items.map((job) => job.jobId),
    ).toEqual([mcp.job.jobId]);
  });

  it("validates the allowlist before preapproval and never returns accepted on create", async () => {
    const store = accountStore("submit-allowlist");
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

    const deniedInput = composeInput(mailbox.id, REQUEST_A, {
      requester: mcpRequester("agent"),
      policy,
      to: ["exempt@example.com"],
      cc: ["blocked@example.com"],
    });
    const denied = await failureOf(store, (host) => host.submitOutbound(deniedInput));
    expect(taggedName(denied)).toBe("JobAuthorizationError");

    const waiting = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_B, {
        requester: mcpRequester("agent"),
        policy,
        to: ["allowed@example.com"],
        cc: ["exempt@example.com"],
      }),
    );
    expect(waiting.created).toBe(true);
    expect(waiting.job.state).toBe("waiting_approval");
    expect(waiting.approval?.state).toBe("pending");
    expect(waiting.job.state).not.toBe("accepted");

    const jobs = await store.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 });
    const ready = jobs.items.filter((job) => job.state === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      purpose: "approval_notification",
      state: "ready",
      requestId: approvalNotificationIdempotencyKey(
        Schema.decodeSync(SubmissionRequestId)(REQUEST_B),
      ),
      messageId: waiting.job.messageId,
    });
    expect(ready[0]?.jobId).not.toBe(waiting.job.jobId);
    const claimed = await store.claimJob({
      jobId: ready[0]?.jobId ?? "",
      nowIso: NOW,
      claimExpiresAt: "2026-01-01T00:15:00.000Z",
      policy,
    });
    expect(claimed.kind).toBe("claimed");
    expect(await store.getOutboundJob(waiting.job.jobId, { kind: "operator" })).toMatchObject({
      state: "waiting_approval",
    });
  });

  it("rejects an identical replay once the requester may no longer send, keeping the original job", async () => {
    const store = accountStore("submit-retry-after-revoke");
    const mailbox = await requireAddress(store, "inbox");
    const first = await store.submitOutbound(
      composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester("agent"),
        policy: ALLOW,
        to: ["recipient@example.com"],
      }),
    );
    expect(first.created).toBe(true);
    expect(first.job.state).toBe("ready");

    const deniedInput = composeInput(mailbox.id, REQUEST_A, {
      requester: mcpRequester("agent"),
      policy: testPolicy({ kind: "deny" }),
      to: ["recipient@example.com"],
    });
    const denied = await failureOf(store, (host) => host.submitOutbound(deniedInput));
    expect(taggedName(denied)).toBe("JobAuthorizationError");
    expect(await store.getOutboundJob(first.job.jobId, { kind: "operator" })).toMatchObject({
      jobId: first.job.jobId,
      state: "ready",
    });
  });

  it("fails closed on deny send mode and on mailboxes outside the policy", async () => {
    const store = accountStore("submit-closed");
    const mailbox = await requireAddress(store, "inbox");
    for (const policy of [
      testPolicy({ kind: "deny" }),
      testPolicy({ kind: "allow" }, { mailboxIds: ["another-mailbox"] }),
    ]) {
      const input = composeInput(mailbox.id, REQUEST_A, {
        requester: mcpRequester("agent"),
        policy,
      });
      const failure = await failureOf(store, (host) => host.submitOutbound(input));
      expect(taggedName(failure)).toBe("JobAuthorizationError");
    }
  });
});

function composeInput(
  mailboxId: string,
  requestId: string,
  options: {
    readonly requester?: { kind: "operator" | "mcp"; clientId: string; label: string };
    readonly policy?: PrincipalPolicy;
    readonly subject?: string;
    readonly to?: readonly [string, ...string[]];
    readonly cc?: ReadonlyArray<string>;
  },
): SubmitOutboundInput {
  const [firstTo, ...restTo] = options.to ?? ["recipient@example.com"];
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: options.requester ?? operatorRequester(),
    policy: options.policy ?? OPERATOR_POLICY,
    mailboxId,
    subject: options.subject ?? "Hello",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [contact(firstTo), ...restTo.map(contact)],
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

function operatorRequester() {
  return { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" };
}

function mcpRequester(clientId: string) {
  return { kind: "mcp" as const, clientId, label: `Client ${clientId}` };
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
