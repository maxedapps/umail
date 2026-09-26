import * as Output from "alchemy/Output";
import { inMemoryState } from "alchemy/State";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import type { StackSpec } from "alchemy/Stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { application } from "../alchemy.run.ts";
import { EmailRoutingDomain } from "../apps/server/src/mail/routing.ts";

export const evaluateApplication = Effect.fn("evaluateApplication")(function* (
  stage: string,
  env: Record<string, string> = {},
) {
  const stack: Omit<StackSpec, "output"> = {
    name: "uMail",
    stage,
    resources: {},
    bindings: {},
    actions: {},
  };
  const output = yield* application.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network request during graph evaluation")),
        ),
        Layer.succeed(
          Cloudflare.Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("unused-test-token"),
            apiBaseUrl: "https://unused.invalid",
          }),
        ),
        Layer.succeed(Alchemy.Stack, stack),
        Layer.succeed(Alchemy.Stage, stage),
        Layer.succeed(AlchemyContext, {
          dotAlchemy: "/tmp/umail-graph-unused",
          dev: false,
          adopt: false,
        }),
        Layer.succeed(Cloudflare.Providers, {
          kind: "ProviderCollection",
          get: () => undefined,
          providers: {},
        }),
        Alchemy.RandomProvider(),
        Provider.succeed(EmailRoutingDomain, {
          read: () => Effect.die("Unexpected provider read"),
          reconcile: () => Effect.die("Unexpected cloud write"),
          delete: () => Effect.die("Unexpected cloud delete"),
        }),
        Layer.succeed(
          Cloudflare.CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("unused-test-token"),
            accountId: "test-account",
            source: { type: "env" },
          }),
        ),
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            UMAIL_DOMAIN: "umail.example.com",
            UMAIL_OPERATOR_EMAIL: "operator@example.net",
            UMAIL_OPERATOR_PASSWORD: "operator-test-passphrase",
            CF_EMAIL_ROUTING_TOKEN: "unused-runtime-test-token",
            ...env,
          }),
        ),
      ),
    ),
    Effect.scoped,
  );
  return { ...stack, output };
});

export const testOutputs = {
  AuthProvision: { operatorId: "operator-test" },
  App: { workerName: "app-test" },
  MailIndex: { queueName: "index-queue", queueId: "index-id" },
  MailArchive: { bucketName: "archive-test", jurisdiction: "default" },
  AuthDb: { databaseId: "auth-test" },
  BetterAuthSecret: { text: Redacted.make("test-signing-secret-01234567890123456789") },
  NotificationKey: {
    text: Redacted.make(Encoding.encodeHex(Uint8Array.from({ length: 32 }, (_, index) => index))),
  },
  MailRouting: { zoneId: "test-zone" },
  MailRoutingDomain: { zoneId: "test-zone" },
};

export function requireWorker(stack: Omit<StackSpec, "output">, id: string) {
  const resource = stack.resources[id];
  if (!Cloudflare.isWorker(resource)) throw new Error(`Missing Worker ${id}`);
  return resource;
}

export function resolveGraphValue<A>(value: A | Output.Output<A, never>) {
  return Output.evaluate(value, testOutputs).pipe(Effect.provide(inMemoryState()));
}
