import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import { Action } from "alchemy/Action";
import { apply } from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Resource from "alchemy/Resource";
import { Stack, type StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { InMemoryService, State } from "alchemy/State";
import { describe, expect, it } from "vitest";
import { evaluateApplication, requireWorker, resolveGraphValue } from "./stack-fixture.ts";

const COMMON_IDS = [
  "Api",
  "AuthDb",
  "BetterAuthSecret",
  "Inbound",
  "IndexConsumer",
  "IndexConsumer/MailIndexConsumer",
  "MailArchive",
  "MailIndex",
  "MailIndexDlq",
  "MailRouting",
  "MailRoutingDomain",
  "MailSend",
  "MailSendDlq",
  "Recovery",
  "SendConsumer",
  "SendConsumer/MailSendConsumer",
];

it("applies a new action after an unchanged database's asynchronous dependency metadata update", async () => {
  type Database = Resource.Resource<"Test.Database", {}, { databaseId: string }>;
  const Database = Resource.Resource<Database>("Test.Database");
  const Provision = Action("Test.Provision", (input: { databaseId: string }) =>
    Effect.succeed({ provisionedDatabase: input.databaseId }),
  );
  let reconciliations = 0;
  const provider = Provider.succeed(Database, {
    read: () => Effect.succeed(undefined),
    reconcile: () =>
      Effect.sync(() => {
        reconciliations += 1;
        return { databaseId: "existing-database" };
      }),
    delete: () => Effect.void,
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
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
    }).pipe(Effect.provide(provider)),
  );

  expect(result).toEqual({ provisionedDatabase: "existing-database" });
  expect(reconciliations).toBe(1);
});

describe("application resource graph", () => {
  it("preserves production identities and provisions auth before workers without live credentials", async () => {
    const stack = await evaluateApplication("prod");
    expect(Object.keys(stack.resources).sort()).toEqual(
      [...COMMON_IDS, "MailCatchAll", "MailSending"].sort(),
    );
    expect(Object.keys(stack.actions)).toEqual(["AuthProvision"]);
    const action = stack.actions.AuthProvision;
    expect(await resolveGraphValue(action?.Input)).toEqual({
      identity: { databaseId: "auth-test" },
      runNonce: expect.any(String),
      operatorEmail: "operator@example.net",
      restResource: "https://umail.example.com",
      mcpResource: "https://umail.example.com/mcp",
    });
    const api = requireWorker(stack, "Api");
    const apiEnv = await resolveGraphValue(api.Props.env);
    expect(apiEnv).toMatchObject({
      AUTH_OPERATOR_ID: "operator-test",
      AUTH_SCHEMA_REVISION: "test-schema",
      AUTH_PROVISION_GENERATION: 1,
      UMAIL_MAIL_DOMAIN: "umail.example.com",
      UMAIL_PREVIEW_MAILBOXES: "",
    });
    expect(Redacted.isRedacted(apiEnv?.UMAIL_NOTIFICATION_KEY)).toBe(true);
    expect(Redacted.isRedacted(apiEnv?.CF_EMAIL_ROUTING_TOKEN)).toBe(true);
    expect(apiEnv).not.toHaveProperty("UMAIL_OPERATOR_PASSWORD");
    expect(api.Props.exports?.AccountStore?.kind).toBe("durableObject");
    expect(stack.resources.AuthDb?.RemovalPolicy).toBe("retain");
    expect(stack.resources.MailArchive?.RemovalPolicy).toBe("retain");
    expect(stack.resources.MailRouting?.RemovalPolicy).toBe("retain");
    expect(stack.resources.MailRoutingDomain?.Adopt).toBe(true);
    for (const id of ["Inbound", "IndexConsumer", "SendConsumer"]) {
      expect(await resolveGraphValue(requireWorker(stack, id).Props.env)).toMatchObject({
        AUTH_OPERATOR_ID: "operator-test",
      });
    }
    expect(await resolveGraphValue(stack.resources.MailCatchAll?.Props)).toMatchObject({
      zone: "test-zone",
      actions: [{ type: "worker", value: ["inbound-test"] }],
    });
  });

  it("wires real queue consumers, failure queues, and the shared AccountStore host", async () => {
    const stack = await evaluateApplication("dev");
    expect(
      await resolveGraphValue(stack.resources["IndexConsumer/MailIndexConsumer"]?.Props),
    ).toMatchObject({
      queueId: "index-id",
      scriptName: "index-test",
      deadLetterQueue: "index-dlq",
      settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 4 },
    });
    expect(
      await resolveGraphValue(stack.resources["SendConsumer/MailSendConsumer"]?.Props),
    ).toMatchObject({
      queueId: "send-id",
      scriptName: "send-test",
      deadLetterQueue: "send-dlq",
      settings: { maxRetries: 4 },
    });
    for (const id of ["Inbound", "IndexConsumer", "SendConsumer", "Recovery"]) {
      const bindings = await resolveGraphValue(stack.bindings[id]);
      expect(bindings?.flatMap((group) => group.data.bindings)).toContainEqual(
        expect.objectContaining({
          type: "durable_object_namespace",
          className: "AccountStore",
          scriptName: "api-test",
        }),
      );
    }
    const recovery = requireWorker(stack, "Recovery");
    expect(recovery.Props.isExternal).toBe(true);
    expect(recovery.Props.crons).toEqual(["* * * * *"]);
    expect(await resolveGraphValue(recovery.Props.env?.ACCOUNT_ID)).toBe("operator-test");
    const indexBindings = await resolveGraphValue(stack.bindings.IndexConsumer);
    expect(
      indexBindings
        ?.flatMap((group) => group.data.bindings)
        .some((binding) => binding.type === "send_email"),
    ).toBe(false);
    const sendBindings = await resolveGraphValue(stack.bindings.SendConsumer);
    expect(
      sendBindings
        ?.flatMap((group) => group.data.bindings)
        .some((binding) => binding.type === "r2_bucket"),
    ).toBe(false);
  });

  it.each(["dev", "pr-42"])("routes only preview mailboxes for %s", async (stage) => {
    const stack = await evaluateApplication(stage);
    expect(Object.keys(stack.resources).sort()).toEqual(
      [
        ...COMMON_IDS,
        "Mail_probe",
        "Mail_inbox",
        ...(stage === "dev" ? ["MailSending"] : []),
      ].sort(),
    );
    for (const part of ["probe", "inbox"]) {
      expect(await resolveGraphValue(stack.resources[`Mail_${part}`]?.Props)).toMatchObject({
        zone: "test-zone",
        matchers: [
          { type: "literal", field: "to", value: `${part}@${stage}-mail.umail.example.com` },
        ],
        actions: [{ type: "worker", value: ["inbound-test"] }],
      });
    }
  });
});
