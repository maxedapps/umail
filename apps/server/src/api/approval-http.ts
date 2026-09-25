import type { OutboundJob, StoredApproval } from "../account/domain.ts";
import {
  hashApprovalToken,
  type ApprovalToken,
  type OutboundThreadMessage,
} from "@umail/api-contract";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AccountStoreRpc } from "../account/worker.ts";
import { projectThreadMessage } from "./projection.ts";

type ApprovalHttpDeps = {
  readonly account: AccountStoreRpc;
};

type ApprovalReviewOutcome =
  | {
      readonly kind: "available";
      readonly approval: StoredApproval;
      readonly job: OutboundJob;
      readonly message: OutboundThreadMessage;
    }
  | { readonly kind: "notFound" }
  | { readonly kind: "gone" };

export const reviewApproval = Effect.fn("reviewApproval")(function* (
  deps: ApprovalHttpDeps,
  token: ApprovalToken,
): Effect.fn.Return<ApprovalReviewOutcome, never, Crypto.Crypto> {
  const lookup = yield* lookupApproval(deps, token);
  if (lookup.kind === "missing") {
    return { kind: "notFound" };
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  if (lookup.approval.expiresAt <= now || isUnavailableState(lookup.approval.state)) {
    return { kind: "gone" };
  }
  const message = yield* loadApprovalMessage(deps, lookup.job.messageId);
  if (message === null || !messageMatchesApproval(lookup.approval, lookup.job, message)) {
    return { kind: "gone" };
  }
  return {
    kind: "available",
    approval: lookup.approval,
    job: lookup.job,
    message,
  };
});

// The store decides atomically: it refuses an approval that is due or whose job is no longer
// waiting, and reports one that was already resolved.
export const decideApproval = Effect.fn("decideApproval")(function* (
  deps: ApprovalHttpDeps,
  token: ApprovalToken,
  decision: "approved" | "denied",
) {
  const tokenHash = yield* hashApprovalToken(token);
  const now = DateTime.formatIso(yield* DateTime.now);
  const result = yield* deps.account
    .decideApproval({ tokenHash, decision, nowIso: now })
    .pipe(Effect.orDie);
  switch (result.kind) {
    case "missing":
      return { kind: "notFound" } as const;
    case "unavailable":
      return { kind: "gone" } as const;
    case "resolved":
      return result.expiresAt <= now
        ? ({ kind: "gone" } as const)
        : ({ kind: "redirect", state: result.state } as const);
    case "claimed":
      return { kind: "redirect", state: result.state } as const;
  }
});

const lookupApproval = Effect.fn("lookupApproval")(function* (
  deps: ApprovalHttpDeps,
  token: ApprovalToken,
) {
  const tokenHash = yield* hashApprovalToken(token);
  return yield* deps.account.lookupApprovalByTokenHash(tokenHash).pipe(Effect.orDie);
});

const loadApprovalMessage = Effect.fn("loadApprovalMessage")(function* (
  deps: ApprovalHttpDeps,
  messageId: string,
) {
  const summary = yield* deps.account.getMessageSummary(messageId, "all");
  const body = yield* deps.account.getMessageBody(messageId, "all");
  if (summary === null || body === null) {
    return null;
  }
  const message = projectThreadMessage(summary, body);
  if (message.direction !== "outbound") {
    return null;
  }
  return message;
}, Effect.orDie);

function isUnavailableState(state: StoredApproval["state"]): boolean {
  return state === "expired" || state === "cancelled";
}

function messageMatchesApproval(
  approval: StoredApproval,
  job: OutboundJob,
  message: OutboundThreadMessage,
): boolean {
  if (message.from.length !== 1 || message.to.length === 0) {
    return false;
  }
  if (approval.state === "pending") {
    return job.state === "waiting_approval";
  }
  return true;
}
