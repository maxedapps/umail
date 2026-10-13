import { Config, Context, Data, Effect, Layer, Redacted, Stream } from "effect";
import { fromApiToken, Retry, type CloudflareOpContext } from "@distilled.cloud/cloudflare";
import * as routing from "@distilled.cloud/cloudflare/email-routing";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export type RecipientRule = routing.GetRuleResponse & { readonly id: string };

export class RecipientRuleError extends Data.TaggedError("RecipientRuleError")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}

export interface RecipientRuleClient {
  list(zoneId: string): Effect.Effect<ReadonlyArray<RecipientRule>, RecipientRuleError>;
  read(zoneId: string, id: string): Effect.Effect<RecipientRule | null, RecipientRuleError>;
  save(
    zoneId: string,
    address: string,
    worker: string,
    name: string,
    id: string | null,
  ): Effect.Effect<RecipientRule, RecipientRuleError>;
  remove(zoneId: string, id: string): Effect.Effect<void, RecipientRuleError>;
}

export class RecipientRules extends Context.Service<RecipientRules, RecipientRuleClient>()(
  "umail/mail/RecipientRules",
) {
  static readonly layerNoDeps = Layer.effect(
    RecipientRules,
    Effect.gen(function* () {
      const token = yield* Config.Redacted("CF_EMAIL_ROUTING_RULES_TOKEN");
      const http = yield* HttpClient.HttpClient;
      const credentials = fromApiToken({ apiToken: Redacted.value(token) });
      const run = <A, E extends { readonly _tag: string; readonly message: string }>(
        operation: Effect.Effect<A, E, CloudflareOpContext>,
      ) =>
        operation.pipe(
          Retry.none,
          Effect.timeout("10 seconds"),
          Effect.mapError(classifyRuleError),
          Effect.provide(credentials),
          Effect.provideService(HttpClient.HttpClient, http),
        );
      return RecipientRules.of({
        list: (zoneId) =>
          run(routing.listRules.items({ zoneId }).pipe(Stream.runCollect)).pipe(
            Effect.flatMap((rules) => Effect.forEach(rules, identifyRule)),
          ),
        read: (zoneId, id) =>
          run(
            routing
              .getRule({ zoneId, ruleIdentifier: id })
              .pipe(Effect.catchTag("EmailRoutingRuleNotFound", () => Effect.succeed(null))),
          ).pipe(
            Effect.flatMap((rule) => (rule === null ? Effect.succeed(null) : identifyRule(rule))),
          ),
        save: (zoneId, address, worker, name, id) => {
          const body = {
            zoneId,
            name,
            enabled: true,
            priority: 0,
            matchers: [{ type: "literal" as const, field: "to" as const, value: address }],
            actions: [{ type: "worker" as const, value: [worker] }],
          };
          return run(
            id === null
              ? routing.createRule(body)
              : routing.updateRule({ ...body, ruleIdentifier: id }),
          ).pipe(Effect.flatMap(identifyRule));
        },
        remove: (zoneId, id) =>
          run(
            routing.deleteRule({ zoneId, ruleIdentifier: id }).pipe(
              Effect.catchTag("EmailRoutingRuleNotFound", () => Effect.void),
              Effect.asVoid,
            ),
          ),
      });
    }),
  );
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));
  static layerTest(client: RecipientRuleClient) {
    return Layer.succeed(RecipientRules, client);
  }
}

function identifyRule(
  rule: routing.GetRuleResponse,
): Effect.Effect<RecipientRule, RecipientRuleError> {
  return hasRuleId(rule)
    ? Effect.succeed(rule)
    : Effect.fail(
        new RecipientRuleError({
          message: "Cloudflare returned a rule without an ID; retry will inspect the owned rule.",
          retryable: true,
        }),
      );
}

function hasRuleId(rule: routing.GetRuleResponse): rule is RecipientRule {
  return typeof rule.id === "string" && rule.id.length > 0;
}

function classifyRuleError(error: { readonly _tag: string; readonly message: string }) {
  const terminal = [
    "Unauthorized",
    "Forbidden",
    "BadRequest",
    "UnprocessableEntity",
    "Conflict",
    "InvalidRoute",
    "ConfigError",
  ].includes(error._tag);
  const credential = ["Unauthorized", "Forbidden", "ConfigError"].includes(error._tag);
  return new RecipientRuleError({
    retryable: !terminal,
    message: credential
      ? "Cloudflare refused CF_EMAIL_ROUTING_RULES_TOKEN. Give it Email Routing Rules Write on this installation's zones and retry."
      : `${error._tag}: ${error.message}`,
  });
}

export function ruleMatches(rule: RecipientRule, address: string, worker: string) {
  return (
    rule.matchers?.length === 1 &&
    rule.matchers[0]?.type === "literal" &&
    rule.matchers[0]?.field === "to" &&
    rule.matchers[0]?.value === address &&
    rule.actions?.length === 1 &&
    rule.actions[0]?.type === "worker" &&
    rule.actions[0]?.value?.length === 1 &&
    rule.actions[0]?.value?.[0] === worker
  );
}

export function ruleAddresses(rule: RecipientRule, address: string) {
  return (
    rule.matchers?.some(
      (matcher) =>
        matcher.type === "literal" && matcher.field === "to" && matcher.value === address,
    ) === true
  );
}
