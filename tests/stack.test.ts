import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import { Action } from "alchemy/Action";
import { apply } from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Resource from "alchemy/Resource";
import { Stack, type StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Cloudflare from "alchemy/Cloudflare";
import { InMemoryService, State } from "alchemy/State";
import { describe, expect, it } from "@effect/vitest";
import { evaluateApplication, requireWorker, resolveGraphValue } from "./stack-fixture.ts";

const COMMON_IDS = [
  "App",
  "App/MailIndexConsumer",
  "AuthDb",
  "BetterAuthSecret",
  "MailArchive",
  "MailIndex",
  "MailRouting",
  "MailRoutingDomain",
  "NotificationKey",
];

it.effect(
  "applies a new action after an unchanged database's asynchronous dependency metadata update",
  () =>
    Effect.gen(function* () {
      type Database = Resource.Resource<"Test.Database", {}, { databaseId: string }>;
      const Database = Resource.Resource<Database>("Test.Database");
      const Provision = Action("Test.Provision", (input: { databaseId: string }) =>
        Effect.succeed({ provisionedDatabase: input.databaseId }),
      );
      let reconciliations = 0;
      const provider = Provider.succeed(Database, {
        read: () => Effect.undefined,
        reconcile: () =>
          Effect.sync(() => {
            reconciliations += 1;
            return { databaseId: "existing-database" };
          }),
        delete: () => Effect.void,
      });

      const result = yield* Effect.gen(function* () {
        const memory = yield* InMemoryService();
        const state = {
          ...memory,
          // Model the suspension of remote state writes without timing-dependent sleeps.
          set: ((request) =>
            Effect.yieldNow.pipe(Effect.andThen(memory.set(request)))) satisfies typeof memory.set,
        };
        const deploy = (withAction: boolean) => {
          const stack: Omit<StackSpec, "output"> = {
            name: "dependency-regression",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          };
          return Effect.gen(function* () {
            const database = yield* Database("AuthDb", {});
            const output = withAction
              ? yield* Provision({ databaseId: database.databaseId })
              : undefined;
            const plan = yield* Plan.make({ ...stack, output });
            if (withAction) expect(plan.resources.AuthDb?.action).toBe("noop");
            return yield* apply(plan);
          }).pipe(
            Effect.provideService(Stack, stack),
            Effect.provideService(Stage, "test"),
            Effect.provideService(State, Effect.succeed(state)),
          );
        };
        yield* deploy(false);
        return yield* deploy(true);
      }).pipe(Effect.provide(provider));

      expect(result).toEqual({ provisionedDatabase: "existing-database" });
      expect(reconciliations).toBe(1);
    }),
);

describe("application resource graph", () => {
  it.effect(
    "preserves production identities and provisions auth before the Worker without live credentials",
    () =>
      Effect.gen(function* () {
        const stack = yield* evaluateApplication("prod");
        expect(Object.keys(stack.resources).sort()).toEqual(
          [...COMMON_IDS, "MailCatchAll", "MailSending"].sort(),
        );
        expect(Object.keys(stack.actions)).toEqual(["AuthProvision"]);
        const action = stack.actions.AuthProvision;
        expect(yield* resolveGraphValue(action?.Input)).toEqual({
          identity: { databaseId: "auth-test" },
          runNonce: expect.any(String),
          operatorEmail: "operator@example.net",
          restResource: "https://umail.example.com",
          mcpResource: "https://umail.example.com/mcp",
        });
        const app = requireWorker(stack, "App");
        const env = yield* resolveGraphValue(app.Props.env);
        expect(env).toMatchObject({ AUTH_OPERATOR_ID: "operator-test" });
        // The approval-link key is an alchemy-managed secret, bound from its resource.
        expect(env).not.toHaveProperty("UMAIL_NOTIFICATION_KEY");
        expect(Redacted.isRedacted(env?.NotificationKey_text)).toBe(true);
        expect(Redacted.isRedacted(env?.UMAIL_OPERATOR_EMAIL)).toBe(true);
        expect(Redacted.isRedacted(env?.CF_EMAIL_ROUTING_TOKEN)).toBe(true);
        expect(env).not.toHaveProperty("UMAIL_OPERATOR_PASSWORD");
        expect(app.Props.exports?.AccountStore?.kind).toBe("durableObject");
        expect(stack.resources.AuthDb?.RemovalPolicy).toBe("retain");
        expect(stack.resources.MailArchive?.RemovalPolicy).toBe("retain");
        expect(stack.resources.MailRouting?.RemovalPolicy).toBe("retain");
        expect(yield* resolveGraphValue(stack.resources.MailCatchAll?.Props)).toMatchObject({
          zone: "test-zone",
          actions: [{ type: "worker", value: ["app-test"] }],
        });
      }),
  );

  it.effect(
    "runs everything in one Worker: HTTP, email, the index consumer, and the store's alarm",
    () =>
      Effect.gen(function* () {
        const stack = yield* evaluateApplication("dev");
        const workers = Object.values(stack.resources).filter((resource) =>
          Cloudflare.isWorker(resource),
        );
        expect(workers.map((worker) => worker.LogicalId)).toEqual(["App"]);
        expect(
          yield* resolveGraphValue(stack.resources["App/MailIndexConsumer"]?.Props),
        ).toMatchObject({
          queueId: "index-id",
          scriptName: "app-test",
          settings: { batchSize: 1, maxConcurrency: 1 },
        });
        const groups = (yield* resolveGraphValue(stack.bindings.App)) ?? [];
        expect(groups.flatMap((group) => group.data.crons ?? [])).toEqual([]);
        const bindings = groups.flatMap((group) => group.data.bindings);
        for (const expected of [
          { type: "send_email", name: "EMAIL" },
          { type: "queue", name: "MailIndex", queueId: "index-id" },
          { type: "d1", name: "AuthDb" },
          { type: "r2_bucket", name: "MailArchive" },
        ]) {
          expect(bindings).toContainEqual(expect.objectContaining(expected));
        }
        // The store is hosted here, so its namespace has no foreign script.
        expect(bindings.filter((binding) => binding.type === "durable_object_namespace")).toEqual([
          { type: "durable_object_namespace", name: "AccountStore", className: "AccountStore" },
        ]);
      }),
  );

  it.effect.each(["dev", "pr-42"])("routes only preview mailboxes for %s", (stage) =>
    Effect.gen(function* () {
      const stack = yield* evaluateApplication(stage);
      expect(Object.keys(stack.resources).sort()).toEqual(
        [
          ...COMMON_IDS,
          "Mail_probe",
          "Mail_inbox",
          ...(stage === "dev" ? ["MailSending"] : []),
        ].sort(),
      );
      for (const part of ["probe", "inbox"]) {
        expect(yield* resolveGraphValue(stack.resources[`Mail_${part}`]?.Props)).toMatchObject({
          zone: "test-zone",
          matchers: [
            { type: "literal", field: "to", value: `${part}@${stage}-mail.umail.example.com` },
          ],
          actions: [{ type: "worker", value: ["app-test"] }],
        });
      }
    }),
  );
});
