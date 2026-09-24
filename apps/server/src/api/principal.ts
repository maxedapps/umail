import type { MailboxScope } from "../account/domain.ts";
import type { Principal } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

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

export function mailboxAllowed(principal: Principal, mailboxId: string): boolean {
  if (principal.policy.mailboxIds === "all") {
    return true;
  }
  return principal.policy.mailboxIds.includes(mailboxId);
}

export function mailboxScopeOf(principal: Principal): MailboxScope {
  if (principal.policy.mailboxIds === "all") {
    return "all";
  }
  return principal.policy.mailboxIds;
}
