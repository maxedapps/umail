import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import { Effect } from "effect";
import * as routing from "@distilled.cloud/cloudflare/email-routing";
import { ReceivingDomainUnsafe } from "./receiving-domain.ts";

// Old previews declared two literal rules in Alchemy. Only stored IDs can be handed to the
// controller; dropping their declarations must never run the SDK's destructive rule delete.
export const LegacySeedRuleProvider = Provider.succeed(Cloudflare.Email.Rule, {
  stables: ["ruleId", "zoneId"],
  read: Effect.fn("readLegacySeedRule")(function* ({ output }) {
    if (output === undefined) return undefined;
    const observed = yield* routing.getRule({
      zoneId: output.zoneId,
      ruleIdentifier: output.ruleId,
    });
    if (
      JSON.stringify(observed.matchers) !== JSON.stringify(output.matchers) ||
      JSON.stringify(observed.actions) !== JSON.stringify(output.actions)
    ) {
      return yield* new ReceivingDomainUnsafe({
        message: "An old preview seed rule has changed owner; umail will not take it over.",
      });
    }
    return { ...output, name: observed.name ?? "", enabled: observed.enabled ?? false };
  }),
  diff: () => Effect.void,
  reconcile: ({ output }) =>
    output === undefined
      ? Effect.fail(
          new ReceivingDomainUnsafe({
            message:
              "UMAIL_LEGACY_SEED_RULES can only transfer this stage's stored seed rules; it cannot create rules.",
          }),
        )
      : Effect.succeed(output),
  delete: Effect.fn("forgetTransferredSeedRule")(function* ({ output }) {
    const stack = yield* Alchemy.Stack;
    const observed = yield* routing
      .getRule({ zoneId: output.zoneId, ruleIdentifier: output.ruleId })
      .pipe(Effect.catchTag("EmailRoutingRuleNotFound", () => Effect.void));
    if (
      observed &&
      (!observed.name?.startsWith(`umail/${stack.name}/${stack.stage}/`) ||
        JSON.stringify(observed.matchers) !== JSON.stringify(output.matchers) ||
        JSON.stringify(observed.actions) !== JSON.stringify(output.actions))
    ) {
      return yield* new ReceivingDomainUnsafe({
        message:
          "An old seed rule has not been transferred. Set UMAIL_LEGACY_SEED_RULES=true for this stage's first controller rollout.",
      });
    }
  }),
});
