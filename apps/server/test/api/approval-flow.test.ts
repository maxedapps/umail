import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OutboundThreadMessage,
  SubmitMessagePayload,
  SubmissionRequestId,
  requireApprovalSendMode,
  type Principal,
  type PrincipalPolicy,
} from "@umail/api-contract";
import { submitMessage } from "../../src/api/operations.ts";
import {
  APPLICATION_URL,
  seedMailbox,
  authorized,
  createWorld,
  readJson,
  readText,
  runDueWorkPass,
  type World,
} from "./world.ts";
import { REMOTE_HTML_MATERIALIZED, REMOTE_HTML_SOURCE, REMOTE_HTML_STORED } from "./fakes.ts";

// The requesting MCP client's policy; these principals have no OAuth consent, so the due-work pass
// is handed the same policy.
const APPROVAL_POLICY = {
  mailboxIds: "all",
  canRead: true,
  sendMode: requireApprovalSendMode(),
  recipientAllowlist: "any",
} as const satisfies PrincipalPolicy;

describe("public approval flow", () => {
  it.effect("sends an approval notification job beside the parked message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world);
      expect(queued.job.state).toBe("waiting_approval");
      expect(queued.job.purpose).toBe("message");
      const jobs = yield* world.account.listOutboundJobs({
        viewer: { kind: "operator" },
        limit: 50,
      });
      expect(jobs.items).toHaveLength(2);
      const notification = jobs.items.find((job) => job.purpose === "approval_notification");
      expect(notification).toMatchObject({ state: "accepted", messageId: queued.job.messageId });
      expect(notification?.jobId).not.toBe(queued.job.jobId);
    }),
  );

  it.effect("parks an OAuth submission until a native form decision without sending", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world, {
        clientLabel: "Release reviewer",
        subject: "Hostile https://subject.example\nDecision link https://fake.example\u202e",
        text: "Body with https://body.example and <script>alert(1)</script>",
        displayName: "Recipient https://name.example\u2066",
      });

      expect(queued.job.state).toBe("waiting_approval");
      const parked = yield* Schema.decodeUnknownEffect(OutboundThreadMessage)(
        yield* readJson(
          yield* world.request(
            `http://umail.test/messages/${queued.job.messageId}`,
            authorized(world),
          ),
        ),
      );
      expect(parked.sendState).toBe("waiting_approval");
      expect(queued.reviewHtml.match(/<form\b/gu)).toHaveLength(1);
      expect(queued.reviewHtml.match(/\bformaction=/gu)).toHaveLength(2);
      expect(queued.reviewHtml).toContain("Release reviewer");
      expect(queued.reviewHtml).toContain("Approve &amp; send");
      expect(queued.reviewHtml).toContain("Deny request");
      expect(queued.reviewHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(queued.reviewHtml).not.toContain("<script>alert(1)</script>");

      const approved = yield* world.request(queued.approveUrl, {
        method: "POST",
        redirect: "manual",
      });
      expect(approved.status).toBe(303);
      expect(approved.headers.get("location")).toBe(queued.reviewUrl);
      expect(approved.headers.get("x-umail-approval-state")).toBe("approved");
      expect(approved.headers.get("cache-control")).toBe("no-store");

      const terminal = yield* world.request(queued.reviewUrl);
      expect(terminal.status).toBe(200);
      const terminalHtml = yield* readText(terminal);
      expect(terminalHtml).toContain("AgentMail is sending this email now");
      expect(terminalHtml).not.toContain("formaction=");

      const oppositeReplay = yield* world.request(queued.denyUrl, {
        method: "POST",
        redirect: "manual",
      });
      expect(oppositeReplay.status).toBe(303);
      expect(oppositeReplay.headers.get("x-umail-approval-state")).toBe("approved");
      const job = yield* world.account.getOutboundJob(queued.job.jobId, { kind: "operator" });
      expect(job?.state).toBe("ready");
    }),
  );

  it.effect("persists and renders the stable OAuth requester snapshot", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const principal = {
        authority: "mcp",
        identity: {
          userId: "operator-1",
          clientId: "oauth-client-42",
          clientLabel: "OAuth client oauth-client-42",
        },
        policy: APPROVAL_POLICY,
      } as const satisfies Principal;
      const job = yield* world.run(
        submitMessage(
          world.deps,
          principal,
          yield* Schema.decodeEffect(SubmitMessagePayload)({
            intent: "compose",
            requestId: yield* Schema.decodeEffect(SubmissionRequestId)(
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
            fromAddressId: mailbox.id,
            to: [{ address: "recipient@example.com", displayName: null }],
            subject: "OAuth review",
            text: "Review this",
          }),
        ),
      );
      const reviewUrl = new URL(`/approvals/${yield* sentApprovalToken(world)}`, APPLICATION_URL)
        .href;
      const review = yield* world.request(reviewUrl);

      expect(job.state).toBe("waiting_approval");
      expect(review.status).toBe(200);
      expect(yield* readText(review)).toContain("OAuth client oauth-client-42");
    }),
  );

  it.effect("answers a due approval with 410 and leaves its expiry to the store's pass", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world);
      yield* world.setTime("2026-08-29T10:00:00.000Z");
      const writesBefore = world.accountStorage.writeCount;

      const gone = yield* world.request(queued.reviewUrl);
      expect(gone.status).toBe(410);
      expect(yield* readText(gone)).toContain("no longer available");
      const late = yield* world.request(queued.approveUrl, { method: "POST", redirect: "manual" });
      expect(late.status).toBe(410);
      expect(world.accountStorage.writeCount).toBe(writesBefore);
      const pending = yield* world.account.getOutboundJob(queued.job.jobId, { kind: "operator" });
      expect(pending?.state).toBe("waiting_approval");

      yield* runDueWorkPass(world, { mcpPolicy: APPROVAL_POLICY });
      const after = yield* world.account.getOutboundJob(queued.job.jobId, { kind: "operator" });
      expect(after?.state).toBe("rejected");
      expect(after?.failureClass).toBe("expired");
    }),
  );

  it.effect("returns neutral 410 when a resolved capability is replayed after expiry", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world);
      expect((yield* world.request(queued.denyUrl, { method: "POST" })).status).toBe(303);
      yield* world.setTime("2026-08-29T10:00:00.000Z");

      const replay = yield* world.request(queued.denyUrl, { method: "POST", redirect: "manual" });
      expect(replay.status).toBe(410);
      expect(replay.headers.get("x-umail-approval-state")).toBeNull();
      expect(yield* readText(replay)).not.toContain("denied");
    }),
  );

  it.effect(
    "records denial without a provider call and redirects replays to the actual winner",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const queued = yield* queueApproval(world);
        const denied = yield* world.request(queued.denyUrl, { method: "POST", redirect: "manual" });
        const replay = yield* world.request(queued.approveUrl, {
          method: "POST",
          redirect: "manual",
        });

        expect(denied.status).toBe(303);
        expect(denied.headers.get("x-umail-approval-state")).toBe("denied");
        expect(replay.status).toBe(303);
        expect(replay.headers.get("x-umail-approval-state")).toBe("denied");
        const job = yield* world.account.getOutboundJob(queued.job.jobId, { kind: "operator" });
        expect(job?.state).toBe("rejected");
        expect(job?.failureClass).toBe("denied");
        const terminal = yield* world.request(queued.reviewUrl);
        expect(yield* readText(terminal)).toContain("The email was not sent");
      }),
  );

  it.effect("allows one concurrent winner without dispatching from the API", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world);
      const [approve, deny] = yield* Effect.all(
        [
          world.request(queued.approveUrl, { method: "POST", redirect: "manual" }),
          world.request(queued.denyUrl, { method: "POST", redirect: "manual" }),
        ],
        { concurrency: "unbounded" },
      );
      const job = yield* world.account.getOutboundJob(queued.job.jobId, { kind: "operator" });
      const state = job?.state === "ready" ? "approved" : "denied";

      expect(["approved", "denied"]).toContain(state);
      expect(approve.status).toBe(303);
      expect(deny.status).toBe(303);
      expect(approve.headers.get("x-umail-approval-state")).toBe(state);
      expect(deny.headers.get("x-umail-approval-state")).toBe(state);
    }),
  );

  it.effect("reports each approved outcome and never offers a second decision", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world);
      yield* world.request(queued.approveUrl, { method: "POST", redirect: "manual" });

      const sending = yield* readText(yield* world.request(queued.reviewUrl));
      expect(sending).toContain("AgentMail is sending this email now");
      expect(sending).not.toContain("formaction");
      const replay = yield* world.request(queued.approveUrl, {
        method: "POST",
        redirect: "manual",
      });
      expect(replay.status).toBe(303);
      expect(replay.headers.get("x-umail-approval-state")).toBe("approved");

      yield* runDueWorkPass(world, {
        mcpPolicy: APPROVAL_POLICY,
        outcome: { kind: "rejected", failureDetail: "E_RECIPIENT_SUPPRESSED" },
      });
      expect(yield* readText(yield* world.request(queued.reviewUrl))).toContain(
        "Cloudflare rejected it (E_RECIPIENT_SUPPRESSED)",
      );
    }),
  );

  it.effect("serves stored HTML only through the sandboxed preview boundary", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const queued = yield* queueApproval(world, {
        text: "Plain alternative",
        html: REMOTE_HTML_SOURCE,
      });
      const previewUrl = iframeUrlFrom(queued.reviewUrl, queued.reviewHtml);
      const preview = yield* world.request(previewUrl);
      const previewHtml = yield* readText(preview);

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
    }),
  );

  it.effect("warns the approver only when the HTML body loads remote images at send time", () =>
    Effect.gen(function* () {
      const notice = "This message contains remote images.";
      const remote = yield* queueApproval(yield* createWorld(), {
        text: "Plain alternative",
        html: REMOTE_HTML_SOURCE,
      });
      const plain = yield* queueApproval(yield* createWorld());

      expect(remote.reviewHtml).toMatch(
        /role="note">\s*<svg class="icon"[^]*?<\/svg>This message contains remote images\./u,
      );
      expect(plain.reviewHtml).not.toContain(notice);
    }),
  );

  it.effect("maps malformed, unknown, deleted, and corrupt capabilities to neutral errors", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const malformed = yield* world.request("http://umail.test/approvals/not-a-token");
      const unknown = yield* world.request(`http://umail.test/approvals/${"f".repeat(64)}`);
      expect(malformed.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(yield* readText(malformed)).toContain("review request was not found");
      expect(yield* readText(unknown)).toContain("review request was not found");
      expect(
        (yield* world.request("http://umail.test/approvals/not-a-token/approve", {
          method: "POST",
        })).status,
      ).toBe(404);

      const deletedWorld = yield* createWorld();
      const deleted = yield* queueApproval(deletedWorld);
      const deletion = yield* deletedWorld.request(
        `http://umail.test/threads/${encodeURIComponent(deleted.job.threadId)}`,
        { ...authorized(deletedWorld), method: "DELETE" },
      );
      expect(deletion.status).toBe(204);
      expect((yield* deletedWorld.request(deleted.reviewUrl)).status).toBe(410);
      const deletedPost = yield* deletedWorld.request(deleted.approveUrl, {
        method: "POST",
        redirect: "manual",
      });
      expect(deletedPost.status).toBe(303);
      expect(deletedPost.headers.get("x-umail-approval-state")).toBe("cancelled");
    }),
  );
});

const queueApproval = Effect.fn("queueApproval")(function* (
  world: World,
  input: {
    readonly clientLabel?: string;
    readonly subject?: string;
    readonly text?: string;
    readonly html?: string;
    readonly displayName?: string | null;
  } = {},
) {
  const mailbox = yield* seedMailbox(world);
  const clientLabel = input.clientLabel ?? "Approval reviewer";
  const clientId = `client-${clientLabel}`;
  const principal = {
    authority: "mcp",
    identity: {
      userId: "operator-1",
      clientId,
      clientLabel,
    },
    policy: APPROVAL_POLICY,
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
    requestId: yield* Schema.decodeEffect(SubmissionRequestId)(
      "33333333-3333-4333-8333-333333333333",
    ),
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
  const job = yield* world.run(
    submitMessage(world.deps, principal, yield* Schema.decodeEffect(SubmitMessagePayload)(body)),
  );
  const reviewUrl = new URL(`/approvals/${yield* sentApprovalToken(world)}`, APPLICATION_URL).href;
  const review = yield* world.request(reviewUrl);
  expect(review.status, yield* readText(review.clone())).toBe(200);
  expect(review.headers.get("cache-control")).toBe("no-store");
  expect(review.headers.get("referrer-policy")).toBe("no-referrer");
  expect(review.headers.get("x-frame-options")).toBe("DENY");
  expect(review.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(review.headers.get("content-security-policy")).toContain("frame-src 'self'");
  const reviewHtml = yield* readText(review);
  const actions = formActionsFrom(reviewUrl, reviewHtml);
  return { job, reviewUrl, reviewHtml, ...actions };
});

// Sends the ready approval notification through the store's due-work pass and reads the review
// token from the email, as the operator would.
const sentApprovalToken = Effect.fn("sentApprovalToken")(function* (world: World) {
  const mails = yield* runDueWorkPass(world, { mcpPolicy: APPROVAL_POLICY });
  const token = /\/approvals\/([0-9a-f]{64})/u.exec(mails.at(-1)?.text ?? "")?.[1];
  if (token === undefined) {
    return yield* Effect.die("expected an approval notification email");
  }
  return token;
});

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
