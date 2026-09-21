/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  approvalNotificationIdempotencyKey,
  generateApprovalToken,
  hashApprovalToken,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { accountStore, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";

describe("account-store outbound submissions", () => {
  it("replays an identical principal-scoped key and conflicts on a changed payload", async () => {
    const store = accountStore("submit-replay");
    const mailbox = await requireAddress(store, "inbox");
    const first = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        subject: "Hello",
        to: ["recipient@example.com"],
      }),
    );
    expect(first.created).toBe(true);
    expect(first.job.state).toBe("ready");
    expect(first.job.state).not.toBe("accepted");

    const replay = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        subject: "Hello",
        to: ["recipient@example.com"],
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.job.jobId).toBe(first.job.jobId);
    expect(replay.job.state).toBe("ready");

    let conflict: unknown;
    try {
      await store.submitOutbound(
        await composeInput(store, mailbox.id, REQUEST_A, {
          subject: "Changed",
          to: ["recipient@example.com"],
        }),
      );
    } catch (cause) {
      conflict = cause;
    }
    expect(taggedName(conflict)).toBe("SubmissionConflictError");
    expect(await store.getOutboundJob(first.job.jobId, { kind: "operator" })).toMatchObject({
      jobId: first.job.jobId,
      state: "ready",
    });
  });

  it("scopes keys per requester so two clients may reuse the same request id", async () => {
    const store = accountStore("submit-scoped-key");
    const mailbox = await requireAddress(store, "inbox");
    await seedOauthPolicy(store, "client-a", { kind: "allow" });
    await seedOauthPolicy(store, "client-b", { kind: "allow" });
    const first = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: mcpRequester("client-a"),
        to: ["recipient@example.com"],
      }),
    );
    const second = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: mcpRequester("client-b"),
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
    await seedOauthPolicy(store, clientId, { kind: "allow" });

    const operator = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: { kind: "operator", clientId, label: "AgentMail CLI" },
      }),
    );
    const mcp = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: mcpRequester(clientId),
      }),
    );
    const replay = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: mcpRequester(clientId),
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
    await seedOauthPolicy(store, "agent", {
      kind: "requireApproval",
      allowlist: ["allowed@example.com", "exempt@example.com"],
      preapproved: ["exempt@example.com"],
    });

    let denied: unknown;
    try {
      await store.submitOutbound(
        await composeInput(store, mailbox.id, REQUEST_A, {
          requester: mcpRequester("agent"),
          to: ["exempt@example.com"],
          cc: ["blocked@example.com"],
        }),
      );
    } catch (cause) {
      denied = cause;
    }
    expect(taggedName(denied)).toBe("JobAuthorizationError");

    const waiting = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_B, {
        requester: mcpRequester("agent"),
        to: ["allowed@example.com"],
        cc: ["exempt@example.com"],
      }),
    );
    expect(waiting.created).toBe(true);
    expect(waiting.job.state).toBe("waiting_approval");
    expect(waiting.approval?.state).toBe("pending");
    expect(waiting.job.state).not.toBe("accepted");

    const ready = await store.listSendWork({ kind: "ready", nowIso: NOW, limit: 50 });
    expect(ready.items).toHaveLength(1);
    expect(ready.items[0]).toMatchObject({
      purpose: "approval_notification",
      state: "ready",
      requestId: approvalNotificationIdempotencyKey(
        Schema.decodeSync(SubmissionRequestId)(REQUEST_B),
      ),
      messageId: waiting.job.messageId,
    });
    expect(ready.items[0]?.jobId).not.toBe(waiting.job.jobId);
    const claimed = await store.claimDispatch({
      jobId: ready.items[0]?.jobId ?? "",
      nowIso: NOW,
      claimExpiresAt: "2026-01-01T00:15:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    expect(await store.getOutboundJob(waiting.job.jobId, { kind: "operator" })).toMatchObject({
      state: "waiting_approval",
    });
  });

  it("rejects an identical replay after requester revocation without changing the original job", async () => {
    const store = accountStore("submit-retry-after-revoke");
    const mailbox = await requireAddress(store, "inbox");
    await seedOauthPolicy(store, "agent", { kind: "allow" });
    const first = await store.submitOutbound(
      await composeInput(store, mailbox.id, REQUEST_A, {
        requester: mcpRequester("agent"),
        to: ["recipient@example.com"],
      }),
    );
    expect(first.created).toBe(true);
    expect(first.job.state).toBe("ready");

    await store.revokeMcpOAuthPolicy("agent", NOW);

    let denied: unknown;
    try {
      await store.submitOutbound(
        await composeInput(store, mailbox.id, REQUEST_A, {
          requester: mcpRequester("agent"),
          to: ["recipient@example.com"],
        }),
      );
    } catch (cause) {
      denied = cause;
    }
    expect(taggedName(denied)).toBe("JobAuthorizationError");
    expect(await store.getOutboundJob(first.job.jobId, { kind: "operator" })).toMatchObject({
      jobId: first.job.jobId,
      state: "ready",
    });
  });

  it("fails closed for unknown, disabled, or revoked clients and deny send mode", async () => {
    const store = accountStore("submit-closed");
    const mailbox = await requireAddress(store, "inbox");
    let missing: unknown;
    try {
      await store.submitOutbound(
        await composeInput(store, mailbox.id, REQUEST_A, {
          requester: mcpRequester("missing"),
        }),
      );
    } catch (cause) {
      missing = cause;
    }
    expect(taggedName(missing)).toBe("JobAuthorizationError");

    await seedOauthPolicy(store, "denied", { kind: "deny" });
    let sendDenied: unknown;
    try {
      await store.submitOutbound(
        await composeInput(store, mailbox.id, REQUEST_B, {
          requester: mcpRequester("denied"),
        }),
      );
    } catch (cause) {
      sendDenied = cause;
    }
    expect(taggedName(sendDenied)).toBe("JobAuthorizationError");
  });
});

async function composeInput(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  requestId: string,
  options: {
    readonly requester?: { kind: "operator" | "mcp"; clientId: string; label: string };
    readonly subject?: string;
    readonly to?: ReadonlyArray<string>;
    readonly cc?: ReadonlyArray<string>;
  },
) {
  const requester = options.requester ?? operatorRequester();
  const needsApproval =
    requester.kind === "mcp" && (await mcpNeedsApproval(store, requester.clientId, options));
  const input = {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester,
    mailboxId,
    mailDomain: DOMAIN,
    subject: options.subject ?? "Hello",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: (options.to ?? ["recipient@example.com"]).map(contact),
    cc: (options.cc ?? []).map(contact),
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
  };
  if (!needsApproval) {
    return input;
  }
  return {
    ...input,
    approval: await approvalMaterials(),
  };
}

async function mcpNeedsApproval(
  store: DurableObjectStub<AccountStoreTestHost>,
  clientId: string,
  options: {
    readonly to?: ReadonlyArray<string>;
    readonly cc?: ReadonlyArray<string>;
  },
): Promise<boolean> {
  const policy = await store.getMcpOAuthPolicy(clientId);
  if (policy === null || policy.policy.sendMode.kind !== "requireApproval") {
    return false;
  }
  const preapproved = new Set(policy.policy.sendMode.preapprovedRecipients);
  const recipients = [...(options.to ?? ["recipient@example.com"]), ...(options.cc ?? [])];
  return recipients.some((address) => !preapproved.has(requireExternal(address)));
}

async function approvalMaterials() {
  return {
    tokenHash: await hashApprovalToken(generateApprovalToken()),
    expiresAt: EXPIRES,
    notification: {
      keyVersion: "v1",
      nonce: "n1",
      ciphertext: "secret-capability-ciphertext",
    },
  };
}

async function seedOauthPolicy(
  store: DurableObjectStub<AccountStoreTestHost>,
  clientId: string,
  options: {
    readonly kind: "allow" | "deny" | "requireApproval";
    readonly allowlist?: ReadonlyArray<string> | "any";
    readonly preapproved?: ReadonlyArray<string>;
  },
) {
  await store.ensureMcpOAuthPolicy({
    clientId,
    label: `Client ${clientId}`,
    createdAt: NOW,
  });
  const sendMode =
    options.kind === "requireApproval"
      ? {
          kind: "requireApproval" as const,
          preapprovedRecipients: (options.preapproved ?? []).map(requireExternal),
        }
      : { kind: options.kind };
  const recipientAllowlist =
    options.allowlist === undefined || options.allowlist === "any"
      ? "any"
      : options.allowlist.map((address) => requireExternal(address));
  await store.updateMcpOAuthPolicy({
    clientId,
    label: `Client ${clientId}`,
    policy: {
      mailboxIds: "all",
      canRead: true,
      canDelete: false,
      sendMode,
      recipientAllowlist,
      canAdmin: false,
    },
    updatedAt: NOW,
  });
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
