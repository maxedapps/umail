import type { MailboxScope } from "../account/domain.ts";
import { comparisonKey, type MailContact, type Principal } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

export function requireAdmin(principal: Principal): Effect.Effect<void, HttpApiError.Forbidden> {
  if (principal.policy.canAdmin) {
    return Effect.void;
  }
  return Effect.fail(new HttpApiError.Forbidden());
}

export function requireRead(principal: Principal): Effect.Effect<void, HttpApiError.Forbidden> {
  if (principal.policy.canRead) {
    return Effect.void;
  }
  return Effect.fail(new HttpApiError.Forbidden());
}

export function requireSend(principal: Principal): Effect.Effect<void, HttpApiError.Forbidden> {
  if (principal.policy.sendMode.kind === "deny") {
    return Effect.fail(new HttpApiError.Forbidden());
  }
  return Effect.void;
}

export function requiresApproval(
  principal: Principal,
  recipients: ReadonlyArray<MailContact>,
): boolean {
  const sendMode = principal.policy.sendMode;
  if (sendMode.kind !== "requireApproval") return false;
  const preapproved = new Set(sendMode.preapprovedRecipients.map(comparisonKey));
  return !recipients.every((recipient) => preapproved.has(comparisonKey(recipient.address)));
}

export function requireDelete(principal: Principal): Effect.Effect<void, HttpApiError.Forbidden> {
  if (principal.policy.canDelete) {
    return Effect.void;
  }
  return Effect.fail(new HttpApiError.Forbidden());
}

export function mailboxAllowed(principal: Principal, mailboxId: string): boolean {
  if (principal.policy.mailboxIds === "all") {
    return true;
  }
  return principal.policy.mailboxIds.includes(mailboxId);
}

export function recipientsAllowed(
  principal: Principal,
  recipients: ReadonlyArray<MailContact>,
): boolean {
  if (principal.policy.recipientAllowlist === "any") {
    return true;
  }
  const allowed = new Set(principal.policy.recipientAllowlist.map(comparisonKey));
  for (const recipient of recipients) {
    if (!allowed.has(comparisonKey(recipient.address))) {
      return false;
    }
  }
  return true;
}

export function mailboxScopeOf(principal: Principal): MailboxScope {
  if (principal.policy.mailboxIds === "all") {
    return "all";
  }
  return principal.policy.mailboxIds;
}
