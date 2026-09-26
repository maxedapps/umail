import type { MailboxScope } from "../account/domain.ts";
import { NotPermitted, type Principal } from "@umail/api-contract";
import * as Effect from "effect/Effect";

export function requireRead(principal: Principal): Effect.Effect<void, NotPermitted> {
  if (principal.policy.canRead) {
    return Effect.void;
  }
  return Effect.fail(
    new NotPermitted({ code: "read_denied", message: "This client has no read access." }),
  );
}

export function requireSend(principal: Principal): Effect.Effect<void, NotPermitted> {
  if (principal.policy.sendMode.kind === "deny") {
    return Effect.fail(
      new NotPermitted({ code: "send_denied", message: "This client may not send mail." }),
    );
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
