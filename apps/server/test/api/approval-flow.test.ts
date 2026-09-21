import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

import {
  OutboundJobStatus,
  OutboundThreadMessage,
  SubmitMessagePayload,
  SubmissionRequestId,
  requireApprovalSendMode,
  type Principal,
} from "@umail/api-contract";
import { submitMessage } from "../../src/api/operations.ts";
import {
  notificationKeyringFromSecret,
  randomNotificationSecret,
} from "../../src/mail/notifications.ts";
import { APPLICATION_URL, seedMailbox, authorized, createWorld, type World } from "./world.ts";
import { REMOTE_HTML_MATERIALIZED, REMOTE_HTML_SOURCE, REMOTE_HTML_STORED } from "./fakes.ts";

type QueuedApproval = {
  readonly job: OutboundJobStatus;
  readonly reviewUrl: string;
  readonly approveUrl: string;
  readonly denyUrl: string;
  readonly reviewHtml: string;
};

describe("public approval flow", () => {
  it("fails closed for a missing or non-base64url notification key", () => {
    expect(() => notificationKeyringFromSecret("")).toThrow(
      "UMAIL_NOTIFICATION_KEY is not valid base64url",
    );
    expect(() =>
      notificationKeyringFromSecret(Encoding.encodeBase64(new Uint8Array(32).fill(0xfb))),
    ).toThrow("UMAIL_NOTIFICATION_KEY is not valid base64url");
    const keyring = notificationKeyringFromSecret(
      Encoding.encodeBase64Url(randomNotificationSecret()),
    );
    expect(keyring.currentVersion).toBe("v1");
  });

  it("queues a ready approval_notification job beside the parked message", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    expect(queued.job.state).toBe("waiting_approval");
    expect(queued.job.purpose).toBe("message");
    const ready = await Effect.runPromise(
      world.account.listSendWork({
        kind: "ready",
        nowIso: "2026-08-28T10:00:00.000Z",
        limit: 50,
      }),
    );
    expect(ready.items).toHaveLength(1);
    expect(ready.items[0]).toMatchObject({
      purpose: "approval_notification",
      state: "ready",
      messageId: queued.job.messageId,
    });
    expect(ready.items[0]?.jobId).not.toBe(queued.job.jobId);
  });

  it("parks an OAuth submission until a native form decision without sending", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world, {
      clientLabel: "Release reviewer",
      subject: "Hostile https://subject.example\nDecision link https://fake.example\u202e",
      text: "Body with https://body.example and <script>alert(1)</script>",
      displayName: "Recipient https://name.example\u2066",
    });

    expect(queued.job.state).toBe("waiting_approval");
    const parked = await Schema.decodeUnknownPromise(OutboundThreadMessage)(
      await (
        await world.fetch(`http://umail.test/messages/${queued.job.messageId}`, authorized(world))
      ).json(),
    );
    expect(parked.sendState).toBe("waiting_approval");
    expect(queued.reviewHtml.match(/<form\b/gu)).toHaveLength(1);
    expect(queued.reviewHtml.match(/\bformaction=/gu)).toHaveLength(2);
    expect(queued.reviewHtml).toContain("Release reviewer");
    expect(queued.reviewHtml).toContain("Approve &amp; send");
    expect(queued.reviewHtml).toContain("Deny request");
    expect(queued.reviewHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(queued.reviewHtml).not.toContain("<script>alert(1)</script>");

    const approved = await world.fetch(queued.approveUrl, { method: "POST", redirect: "manual" });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe(queued.reviewUrl);
    expect(approved.headers.get("x-umail-approval-state")).toBe("approved");
    expect(approved.headers.get("cache-control")).toBe("no-store");

    const terminal = await world.fetch(queued.reviewUrl);
    expect(terminal.status).toBe(200);
    const terminalHtml = await terminal.text();
    expect(terminalHtml).toContain("submission outcome is not confirmed");
    expect(terminalHtml).not.toContain("formaction=");

    const oppositeReplay = await world.fetch(queued.denyUrl, {
      method: "POST",
      redirect: "manual",
    });
    expect(oppositeReplay.status).toBe(303);
    expect(oppositeReplay.headers.get("x-umail-approval-state")).toBe("approved");
    const job = await Effect.runPromise(
      world.account.getOutboundJob(queued.job.jobId, { kind: "operator" }),
    );
    expect(job?.state).toBe("ready");

    const token = tokenFromReviewUrl(queued.reviewUrl);
    const stored = JSON.stringify(await Effect.runPromise(world.account.listMcpOAuthPolicies()));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(queued.reviewUrl);
  });

  it("persists and renders the stable OAuth requester snapshot", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    await Effect.runPromise(
      world.account.ensureMcpOAuthPolicy({
        clientId: "oauth-client-42",
        label: "OAuth client oauth-client-42",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
    );
    const principal = {
      authority: "mcp",
      identity: {
        kind: "oauth",
        userId: "operator-1",
        clientId: "oauth-client-42",
        clientLabel: "OAuth client oauth-client-42",
      },
      policy: {
        mailboxIds: "all",
        canRead: true,
        canDelete: false,
        sendMode: requireApprovalSendMode(),
        recipientAllowlist: "any",
        canAdmin: false,
      },
    } as const satisfies Principal;
    const job = await Effect.runPromise(
      submitMessage(
        world.deps,
        principal,
        Schema.decodeSync(SubmitMessagePayload)({
          intent: "compose",
          requestId: Schema.decodeSync(SubmissionRequestId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "OAuth review",
          text: "Review this",
        }),
      ),
    );
    const reviewUrl = new URL(`/approvals/${world.approvalTokens[0]}`, APPLICATION_URL).href;
    const review = await world.fetch(reviewUrl);

    expect(job.state).toBe("waiting_approval");
    expect(review.status).toBe(200);
    expect(await review.text()).toContain("OAuth client oauth-client-42");
  });

  it("reloads current policy for a stale administrative MCP principal", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const clientId = "stale-admin-client";
    await Effect.runPromise(
      world.account.ensureMcpOAuthPolicy({
        clientId,
        label: "Stale admin client",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      world.account.updateMcpOAuthPolicy({
        clientId,
        label: "Stale admin client",
        policy: {
          mailboxIds: "all",
          canRead: true,
          canDelete: true,
          sendMode: { kind: "deny" },
          recipientAllowlist: "any",
          canAdmin: true,
        },
        updatedAt: "2026-08-28T10:01:00.000Z",
      }),
    );
    const stalePrincipal = {
      authority: "mcp",
      identity: {
        kind: "oauth",
        userId: "operator-1",
        clientId,
        clientLabel: "Stale admin client",
      },
      policy: {
        mailboxIds: "all",
        canRead: true,
        canDelete: true,
        sendMode: { kind: "allow" },
        recipientAllowlist: "any",
        canAdmin: true,
      },
    } as const satisfies Principal;

    await expect(
      Effect.runPromise(
        submitMessage(
          world.deps,
          stalePrincipal,
          Schema.decodeSync(SubmitMessagePayload)({
            intent: "compose",
            requestId: Schema.decodeSync(SubmissionRequestId)(
              "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ),
            fromAddressId: mailbox.id,
            to: [{ address: "recipient@example.com", displayName: null }],
            subject: "Must stay denied",
            text: "body",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "Forbidden" });
    expect(
      (
        await Effect.runPromise(
          world.account.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 }),
        )
      ).items,
    ).toEqual([]);
  });

  it("keeps GET read-only and converges only a due POST to expired", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    world.approvalClock.set("2026-08-29T10:00:00.000Z");
    const writesBeforeGet = world.accountStorage.writeCount;

    const gone = await world.fetch(queued.reviewUrl);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain("no longer available");
    expect(world.accountStorage.writeCount).toBe(writesBeforeGet);
    const pending = await Effect.runPromise(
      world.account.getOutboundJob(queued.job.jobId, { kind: "operator" }),
    );
    expect(pending?.state).toBe("waiting_approval");

    const expired = await world.fetch(queued.approveUrl, {
      method: "POST",
      redirect: "manual",
    });
    expect(expired.status).toBe(303);
    expect(expired.headers.get("x-umail-approval-state")).toBe("expired");
    const after = await Effect.runPromise(
      world.account.getOutboundJob(queued.job.jobId, { kind: "operator" }),
    );
    expect(after?.state).toBe("rejected");
    expect(after?.failureClass).toBe("expired");
  });

  it("returns neutral 410 when a resolved capability is replayed after expiry", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    expect((await world.fetch(queued.denyUrl, { method: "POST" })).status).toBe(303);
    world.approvalClock.set("2026-08-29T10:00:00.000Z");

    const replay = await world.fetch(queued.denyUrl, { method: "POST", redirect: "manual" });
    expect(replay.status).toBe(410);
    expect(replay.headers.get("x-umail-approval-state")).toBeNull();
    expect(await replay.text()).not.toContain("denied");
  });

  it("records denial without a provider call and redirects replays to the actual winner", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    const denied = await world.fetch(queued.denyUrl, { method: "POST", redirect: "manual" });
    const replay = await world.fetch(queued.approveUrl, { method: "POST", redirect: "manual" });

    expect(denied.status).toBe(303);
    expect(denied.headers.get("x-umail-approval-state")).toBe("denied");
    expect(replay.status).toBe(303);
    expect(replay.headers.get("x-umail-approval-state")).toBe("denied");
    const job = await Effect.runPromise(
      world.account.getOutboundJob(queued.job.jobId, { kind: "operator" }),
    );
    expect(job?.state).toBe("rejected");
    expect(job?.failureClass).toBe("denied");
    const terminal = await world.fetch(queued.reviewUrl);
    expect(await terminal.text()).toContain("No provider call was made");
  });

  it("allows one concurrent winner without dispatching from the API", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    const [approve, deny] = await Promise.all([
      world.fetch(queued.approveUrl, { method: "POST", redirect: "manual" }),
      world.fetch(queued.denyUrl, { method: "POST", redirect: "manual" }),
    ]);
    const job = await Effect.runPromise(
      world.account.getOutboundJob(queued.job.jobId, { kind: "operator" }),
    );
    const state = job?.state === "ready" ? "approved" : "denied";

    expect(["approved", "denied"]).toContain(state);
    expect(approve.status).toBe(303);
    expect(deny.status).toBe(303);
    expect(approve.headers.get("x-umail-approval-state")).toBe(state);
    expect(deny.headers.get("x-umail-approval-state")).toBe(state);
  });

  it("renders approved plus ready as an ambiguous submission and never retries it", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world);
    await world.fetch(queued.approveUrl, { method: "POST", redirect: "manual" });

    const terminal = await world.fetch(queued.reviewUrl);
    const replay = await world.fetch(queued.approveUrl, { method: "POST", redirect: "manual" });
    const html = await terminal.text();

    expect(terminal.status).toBe(200);
    expect(html).toContain("submission outcome is not confirmed");
    expect(html).toContain("Do not retry automatically");
    expect(replay.status).toBe(303);
    expect(replay.headers.get("x-umail-approval-state")).toBe("approved");
  });

  it("serves stored HTML only through the sandboxed preview boundary", async () => {
    const world = await createWorld();
    const queued = await queueApproval(world, {
      text: "Plain alternative",
      html: REMOTE_HTML_SOURCE,
    });
    const previewUrl = iframeUrlFrom(queued.reviewUrl, queued.reviewHtml);
    const preview = await world.fetch(previewUrl);
    const previewHtml = await preview.text();

    expect(queued.reviewHtml).toContain('sandbox=""');
    expect(queued.reviewHtml).toContain("Show plain-text alternative");
    expect(queued.reviewHtml).not.toContain(REMOTE_HTML_STORED);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'self'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; style-src-elem 'none'; style-src-attr 'unsafe-inline'",
    );
    expect(preview.headers.get("x-frame-options")).toBeNull();
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(previewHtml).toContain(REMOTE_HTML_STORED);
    expect(previewHtml).not.toContain(REMOTE_HTML_MATERIALIZED);
    expect(world.htmlPolicy.materializeCalls).toEqual([]);
  });

  it("maps malformed, unknown, deleted, and corrupt capabilities to neutral errors", async () => {
    const world = await createWorld();
    const malformed = await world.fetch("http://umail.test/approvals/not-a-token");
    const unknown = await world.fetch(`http://umail.test/approvals/${"f".repeat(64)}`);
    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await malformed.text()).toContain("review request was not found");
    expect(await unknown.text()).toContain("review request was not found");
    expect(
      (
        await world.fetch("http://umail.test/approvals/not-a-token/approve", {
          method: "POST",
        })
      ).status,
    ).toBe(404);

    const deletedWorld = await createWorld();
    const deleted = await queueApproval(deletedWorld);
    const deletion = await deletedWorld.fetch(
      `http://umail.test/threads/${encodeURIComponent(deleted.job.threadHandle)}`,
      { ...authorized(deletedWorld), method: "DELETE" },
    );
    expect(deletion.status).toBe(204);
    expect((await deletedWorld.fetch(deleted.reviewUrl)).status).toBe(410);
    const deletedPost = await deletedWorld.fetch(deleted.approveUrl, {
      method: "POST",
      redirect: "manual",
    });
    expect(deletedPost.status).toBe(303);
    expect(deletedPost.headers.get("x-umail-approval-state")).toBe("cancelled");
  });
});

async function queueApproval(
  world: World,
  input: {
    readonly clientLabel?: string;
    readonly subject?: string;
    readonly text?: string;
    readonly html?: string;
    readonly displayName?: string | null;
  } = {},
): Promise<QueuedApproval> {
  const mailbox = await seedMailbox(world);
  const clientLabel = input.clientLabel ?? "Approval reviewer";
  const clientId = `client-${clientLabel}`;
  await Effect.runPromise(
    world.account.ensureMcpOAuthPolicy({
      clientId,
      label: clientLabel,
      createdAt: "2026-08-28T10:00:00.000Z",
    }),
  );
  const principal = {
    authority: "mcp",
    identity: {
      kind: "oauth" as const,
      userId: "operator-1",
      clientId,
      clientLabel,
    },
    policy: {
      mailboxIds: "all" as const,
      canRead: true,
      canDelete: false,
      sendMode: requireApprovalSendMode(),
      recipientAllowlist: "any" as const,
      canAdmin: false,
    },
  } satisfies Principal;
  type ApprovalComposeDraft = {
    intent: "compose";
    requestId: SubmissionRequestId;
    fromAddressId: string;
    to: [{ address: "recipient@example.com"; displayName: string | null }];
    subject: string;
    text: string;
    html?: string;
  };
  const body: ApprovalComposeDraft = {
    intent: "compose",
    requestId: Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID()),
    fromAddressId: mailbox.id,
    to: [
      {
        address: "recipient@example.com",
        displayName: input.displayName === undefined ? "Recipient" : input.displayName,
      },
    ],
    subject: input.subject ?? "Needs review",
    text: input.text ?? "Please review",
  };
  if (input.html !== undefined) {
    body.html = input.html;
  }
  const job = await Effect.runPromise(
    submitMessage(world.deps, principal, Schema.decodeSync(SubmitMessagePayload)(body)),
  );
  const token = world.approvalTokens[world.approvalTokens.length - 1];
  if (token === undefined) {
    throw new Error("expected an approval token");
  }
  const reviewUrl = new URL(`/approvals/${token}`, APPLICATION_URL).href;
  const review = await world.fetch(reviewUrl);
  expect(review.status, await review.clone().text()).toBe(200);
  expect(review.headers.get("cache-control")).toBe("no-store");
  expect(review.headers.get("referrer-policy")).toBe("no-referrer");
  expect(review.headers.get("x-frame-options")).toBe("DENY");
  expect(review.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(review.headers.get("content-security-policy")).toContain("frame-src 'self'");
  const reviewHtml = await review.text();
  const actions = formActionsFrom(reviewUrl, reviewHtml);
  return { job, reviewUrl, reviewHtml, ...actions };
}

function formActionsFrom(reviewUrl: string, html: string) {
  const approve = /formaction="([^"]+\/approve)"/u.exec(html)?.[1];
  const deny = /formaction="([^"]+\/deny)"/u.exec(html)?.[1];
  if (approve === undefined || deny === undefined) {
    throw new Error("approval form actions missing");
  }
  return {
    approveUrl: new URL(approve, reviewUrl).href,
    denyUrl: new URL(deny, reviewUrl).href,
  };
}

function iframeUrlFrom(reviewUrl: string, html: string) {
  const src = /iframe[^>]+src="([^"]+)"/u.exec(html)?.[1];
  if (src === undefined) {
    throw new Error("preview iframe missing");
  }
  return new URL(src, reviewUrl).href;
}

function tokenFromReviewUrl(reviewUrl: string) {
  return new URL(reviewUrl).pathname.split("/").at(-1) ?? "";
}
