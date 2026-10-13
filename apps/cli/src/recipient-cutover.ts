import type { Address, RoutingConfiguration } from "@umail/api-contract";
import { fromApiToken, Retry, type CloudflareOpContext } from "@distilled.cloud/cloudflare";
import * as routing from "@distilled.cloud/cloudflare/email-routing";
import { Config, ConfigProvider, Data, Effect, Redacted, Schema, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";

export class RecipientCutoverError extends Data.TaggedError("RecipientCutoverError")<{
  readonly message: string;
}> {}

export interface CutoverCloudflare {
  list(
    zoneId: string,
  ): Effect.Effect<ReadonlyArray<routing.GetRuleResponse>, RecipientCutoverError>;
  catchAll(zoneId: string): Effect.Effect<routing.GetRuleCatchAllResponse, RecipientCutoverError>;
  disableCatchAll(
    zoneId: string,
  ): Effect.Effect<routing.PutRuleCatchAllResponse, RecipientCutoverError>;
}

export const cutoverCloudflare = Effect.fn("cutoverCloudflare")(function* (envFile: string) {
  const provider = yield* ConfigProvider.fromDotEnv({ path: envFile, preserveEmptyStrings: true });
  const token = yield* Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
    "CF_EMAIL_ROUTING_RULES_TOKEN",
  ).parse(provider);
  const http = yield* HttpClient.HttpClient;
  const run = <A, E extends { readonly _tag: string }>(
    request: Effect.Effect<A, E, CloudflareOpContext>,
  ) =>
    request.pipe(
      Retry.none,
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (error) =>
          new RecipientCutoverError({
            message: `Cloudflare ${error._tag}; no further cutover operation was attempted.`,
          }),
      ),
      Effect.provide(fromApiToken({ apiToken: Redacted.value(token) })),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  return {
    list: (zoneId: string) => run(routing.listRules.items({ zoneId }).pipe(Stream.runCollect)),
    catchAll: (zoneId: string) => run(routing.getRuleCatchAll({ zoneId })),
    disableCatchAll: (zoneId: string) =>
      run(
        routing.putRuleCatchAll({
          zoneId,
          enabled: false,
          matchers: [{ type: "all" }],
          actions: [{ type: "drop" }],
        }),
      ),
  } satisfies CutoverCloudflare;
});

// Default is observation only. A later --execute repeats this inspection with current API
// mailbox intent and requires every active or paused recipient to have its owned literal rule.
export const recipientCutover = Effect.fn("recipientCutover")(function* (
  input: {
    readonly zoneId: string;
    readonly execute: boolean;
    readonly configuration: RoutingConfiguration;
    readonly mailboxes: ReadonlyArray<Address>;
  },
  cloudflare: CutoverCloudflare,
) {
  const { configuration, mailboxes, zoneId } = input;
  if (!configuration.domains.some((domain) => domain.receive && domain.zoneId === zoneId))
    return yield* refusal("The zone is outside this installation's receiving manifest.");
  const zones = [
    ...new Set(
      configuration.domains.filter((domain) => domain.receive).map((domain) => domain.zoneId),
    ),
  ];
  const rulesByZone = new Map(
    yield* Effect.forEach(zones, (zone) =>
      cloudflare.list(zone).pipe(Effect.map((rules) => [zone, rules] as const)),
    ),
  );
  const coverage = mailboxes
    .filter((mailbox) => mailbox.retiredAt === null)
    .map((mailbox) => {
      const mailboxZone = mailbox.routing.zoneId;
      const rules = mailboxZone === null ? [] : (rulesByZone.get(mailboxZone) ?? []);
      const matches = rules.filter(
        (rule) =>
          rule.id === mailbox.routing.ruleId &&
          rule.name === `${configuration.ownerPrefix}${mailbox.id}` &&
          rule.enabled &&
          rule.matchers?.length === 1 &&
          rule.matchers[0]?.type === "literal" &&
          rule.matchers[0]?.field === "to" &&
          rule.matchers[0]?.value === mailbox.address &&
          rule.actions?.length === 1 &&
          rule.actions[0]?.type === "worker" &&
          rule.actions[0]?.value?.length === 1 &&
          rule.actions[0]?.value[0] === configuration.workerName,
      );
      const foreign = rules.some(
        (rule) =>
          rule.id !== mailbox.routing.ruleId &&
          rule.matchers?.some(
            (matcher) =>
              matcher.type === "literal" &&
              matcher.field === "to" &&
              matcher.value === mailbox.address,
          ),
      );
      const configured = configuration.domains.some(
        (domain) =>
          domain.receive && domain.name === mailbox.domain && domain.zoneId === mailboxZone,
      );
      return {
        address: mailbox.address,
        zoneId: mailboxZone,
        ruleId: mailbox.routing.ruleId,
        ready: configured && mailbox.routing.state === "ready" && matches.length === 1 && !foreign,
        inCutoverZone: mailboxZone === zoneId,
      };
    });
  const catchAll = yield* cloudflare.catchAll(zoneId);
  const disabled =
    catchAll.enabled === false &&
    catchAll.actions?.length === 1 &&
    catchAll.actions[0]?.type === "drop";
  const owned =
    catchAll.enabled === true &&
    catchAll.matchers?.length === 1 &&
    catchAll.matchers[0]?.type === "all" &&
    catchAll.actions?.length === 1 &&
    catchAll.actions[0]?.type === "worker" &&
    catchAll.actions[0]?.value?.length === 1 &&
    catchAll.actions[0]?.value[0] === configuration.workerName;
  const ready =
    coverage.length > 0 && coverage.every((mailbox) => mailbox.ready) && (owned || disabled);
  const plan = {
    installation: configuration.ownerPrefix,
    worker: configuration.workerName,
    zoneId,
    mode: input.execute ? "execute" : "dry-run",
    ready,
    coverage,
    catchAll: {
      owned,
      alreadyDisabled: disabled,
      change: owned ? { enabled: false, actions: [{ type: "drop" }] } : null,
    },
  };
  if (!input.execute) return plan;
  if (!ready)
    return yield* refusal(
      "Cutover refused: every non-retired mailbox must be ready with verified ownership, and the catch-all must belong to this installation. Run without --execute to inspect coverage.",
    );
  if (owned) {
    const fresh = yield* cloudflare.catchAll(zoneId);
    if (JSON.stringify(fresh) !== JSON.stringify(catchAll))
      return yield* refusal(
        "The catch-all changed during verification; no change was made. Run the dry-run again.",
      );
    const result = yield* cloudflare.disableCatchAll(zoneId);
    if (
      result.enabled !== false ||
      result.actions?.length !== 1 ||
      result.actions[0]?.type !== "drop"
    )
      return yield* refusal(
        "Cloudflare did not confirm catch-all disablement. Inspect it before changing the installation env file.",
      );
  }
  return {
    ...plan,
    nextStep:
      "Set UMAIL_LEGACY_CATCH_ALL=false in the existing installation's env file, then dry-run its next deploy. The retained catch-all state may be relinquished; it must not be recreated.",
  };
});

function refusal(message: string) {
  return Effect.fail(new RecipientCutoverError({ message }));
}
