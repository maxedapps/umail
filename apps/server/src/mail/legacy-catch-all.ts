import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import { Effect } from "effect";
import * as routing from "@distilled.cloud/cloudflare/email-routing";
import { ReceivingDomainUnsafe } from "./receiving-domain.ts";

// Preserve the old resource identity, but never create, enable or retarget a zone catch-all.
// Retention lets the migration command disable it after the app verifies literal coverage.
export const LegacyCatchAllProvider = Provider.succeed(Cloudflare.Email.CatchAll, {
  stables: ["ruleId", "zoneId", "initialName", "initialEnabled", "initialActions"],
  read: Effect.fn("readLegacyCatchAll")(function* ({ output }) {
    if (output === undefined) return undefined;
    const observed = yield* routing.getRuleCatchAll({ zoneId: output.zoneId });
    yield* requireOwnedCatchAll(output, observed);
    return { ...output, enabled: observed.enabled ?? false };
  }),
  diff: ({ news, output }) =>
    isResolved(news) && output !== undefined && news.zone !== output.zoneId
      ? Effect.fail(
          new ReceivingDomainUnsafe({
            message: "The legacy catch-all zone cannot change during migration.",
          }),
        )
      : Effect.void,
  reconcile: Effect.fn("preserveLegacyCatchAll")(function* ({ output, news }) {
    if (output === undefined || news.zone !== output.zoneId) {
      return yield* new ReceivingDomainUnsafe({
        message:
          "UMAIL_LEGACY_CATCH_ALL requires this installation's stored MailCatchAll ownership. It cannot create or take over a catch-all.",
      });
    }
    const observed = yield* routing.getRuleCatchAll({ zoneId: output.zoneId });
    yield* requireOwnedCatchAll(output, observed);
    return output;
  }),
  delete: Effect.fn("forgetLegacyCatchAll")(function* ({ output }) {
    const observed = yield* routing.getRuleCatchAll({ zoneId: output.zoneId });
    if (observed.enabled || !observed.actions?.every(({ type }) => type === "drop")) {
      return yield* new ReceivingDomainUnsafe({
        message:
          "The legacy catch-all is still active or has changed owner. Keep UMAIL_LEGACY_CATCH_ALL=true until the verified routing cutover succeeds.",
      });
    }
  }),
});

function requireOwnedCatchAll(
  output: Cloudflare.Email.CatchAll["Attributes"],
  observed: routing.GetRuleCatchAllResponse,
) {
  const disabled =
    observed.enabled === false && observed.actions?.every(({ type }) => type === "drop");
  const owned =
    observed.actions?.length === 1 &&
    output.actions.length === 1 &&
    observed.actions[0]?.type === "worker" &&
    output.actions[0]?.type === "worker" &&
    observed.actions[0]?.value?.length === 1 &&
    observed.actions[0]?.value?.[0] === output.actions[0]?.value?.[0];
  return disabled || owned
    ? Effect.void
    : Effect.fail(
        new ReceivingDomainUnsafe({
          message:
            "The legacy catch-all no longer belongs to this installation; umail will not change it.",
        }),
      );
}
