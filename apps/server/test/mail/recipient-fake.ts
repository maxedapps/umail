import { Effect } from "effect";
import { MailDomain } from "@umail/api-contract";
import type { RecipientRoutingPorts } from "../../src/account/recipient-routing.ts";
import {
  RecipientRuleError,
  type RecipientRule,
  type RecipientRuleClient,
} from "../../src/mail/recipient-rules.ts";

export class MemoryRecipientRules implements RecipientRuleClient {
  readonly rows = new Map<string, { readonly zoneId: string; readonly rule: RecipientRule }>();
  readonly writes: Array<{
    readonly operation: "save" | "remove";
    readonly zoneId: string;
    readonly id: string;
  }> = [];
  failure: RecipientRuleError | null = null;
  afterSave: (() => void) | undefined;
  #sequence = 0;

  list(zoneId: string) {
    return Effect.suspend(() =>
      this.failure === null
        ? Effect.succeed(
            [...this.rows.values()]
              .filter((entry) => entry.zoneId === zoneId)
              .map(({ rule }) => rule),
          )
        : Effect.fail(this.failure),
    );
  }
  read(zoneId: string, id: string) {
    return Effect.sync(() => {
      const entry = this.rows.get(id);
      return entry?.zoneId === zoneId ? entry.rule : null;
    });
  }
  save(zoneId: string, address: string, worker: string, name: string, existing: string | null) {
    return Effect.try({
      try: () => {
        const id = existing ?? `rule-${++this.#sequence}`;
        const rule: RecipientRule = {
          id,
          name,
          enabled: true,
          priority: 0,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "worker", value: [worker] }],
        };
        this.rows.set(id, { zoneId, rule });
        this.writes.push({ operation: "save", zoneId, id });
        this.afterSave?.();
        return rule;
      },
      catch: (cause) =>
        cause instanceof RecipientRuleError
          ? cause
          : new RecipientRuleError({ message: String(cause), retryable: true }),
    });
  }
  remove(zoneId: string, id: string) {
    return Effect.sync(() => {
      if (this.rows.get(id)?.zoneId === zoneId) this.rows.delete(id);
      this.writes.push({ operation: "remove", zoneId, id });
    });
  }
}

export function recipientPorts(
  domain = MailDomain.make("umail.example.com"),
): RecipientRoutingPorts {
  return {
    client: new MemoryRecipientRules(),
    domains: [{ name: domain, zoneId: "test-zone", receive: true, send: true }],
    workerName: "test-worker",
    ownerPrefix: "umail/uMail/test/",
    legacySeeds: [],
  };
}
