import type { OutboundJob, StoredApproval } from "../account/domain.ts";
import {
  hashApprovalToken,
  type ApprovalToken,
  type OutboundThreadMessage,
} from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ApiAccountStore } from "../account/worker.ts";
import { projectThreadMessage } from "./projection.ts";

export type ApprovalHttpDeps = {
  readonly account: ApiAccountStore;
  readonly approvalClock: {
    readonly now: Effect.Effect<DateTime.Utc>;
  };
};

export type ApprovalReviewOutcome =
  | {
      readonly kind: "available";
      readonly approval: StoredApproval;
      readonly job: OutboundJob;
      readonly message: OutboundThreadMessage;
    }
  | { readonly kind: "notFound" }
  | { readonly kind: "gone" };

export type ApprovalDecisionOutcome =
  | { readonly kind: "redirect"; readonly state: StoredApproval["state"] }
  | { readonly kind: "notFound" }
  | { readonly kind: "gone" };

export function reviewApproval(
  deps: ApprovalHttpDeps,
  token: ApprovalToken,
): Effect.Effect<ApprovalReviewOutcome> {
  return Effect.gen(function* () {
    const lookup = yield* lookupApproval(deps, token);
    if (lookup.kind === "missing") {
      return { kind: "notFound" };
    }
    const now = DateTime.formatIso(yield* deps.approvalClock.now);
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
}

export function decideApproval(
  deps: ApprovalHttpDeps,
  token: ApprovalToken,
  decision: "approved" | "denied",
): Effect.Effect<ApprovalDecisionOutcome> {
  return Effect.gen(function* () {
    const lookup = yield* lookupApproval(deps, token);
    if (lookup.kind === "missing") {
      return { kind: "notFound" };
    }
    const now = DateTime.formatIso(yield* deps.approvalClock.now);
    if (lookup.approval.state !== "pending") {
      if (lookup.approval.expiresAt <= now) {
        return { kind: "gone" };
      }
      return { kind: "redirect", state: lookup.approval.state };
    }
    if (lookup.approval.expiresAt <= now) {
      const expired = yield* deps.account
        .expirePendingApproval({ approvalId: lookup.approval.id, nowIso: now })
        .pipe(Effect.orDie);
      if (expired.kind === "missing") {
        return { kind: "notFound" };
      }
      if (expired.kind === "pending") {
        return { kind: "gone" };
      }
      return { kind: "redirect", state: expired.state };
    }
    const review = yield* reviewApproval(deps, token);
    if (review.kind !== "available") {
      return review;
    }
    const claimed = yield* deps.account
      .decideApproval({ tokenHash: lookup.approval.tokenHash, decision, nowIso: now })
      .pipe(Effect.orDie);
    if (claimed.kind === "missing") {
      return { kind: "notFound" };
    }
    if (claimed.kind === "unavailable") {
      return { kind: "gone" };
    }
    return { kind: "redirect", state: claimed.state };
  });
}

function lookupApproval(deps: ApprovalHttpDeps, token: ApprovalToken) {
  return Effect.gen(function* () {
    const tokenHash = yield* Effect.promise(() => hashApprovalToken(token));
    return yield* deps.account.lookupApprovalByTokenHash(tokenHash).pipe(Effect.orDie);
  });
}

function loadApprovalMessage(deps: ApprovalHttpDeps, messageId: string) {
  return Effect.gen(function* () {
    const summary = yield* deps.account.getMessageSummary(messageId, "all").pipe(Effect.orDie);
    const body = yield* deps.account.getMessageBody(messageId, "all").pipe(Effect.orDie);
    if (summary === null || body === null) {
      return null;
    }
    const message = projectThreadMessage(summary, body);
    if (message === null || message.direction !== "outbound") {
      return null;
    }
    return message;
  });
}

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
