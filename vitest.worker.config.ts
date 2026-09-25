import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { defineConfig } from "vitest/config";
import { evaluateApplication, requireWorker, resolveGraphValue } from "./tests/stack-fixture.ts";
import { bundleWorker } from "./tests/worker-bundle.ts";

const workerConfig = Effect.gen(function* () {
  const path = yield* Path.Path;
  const stack = yield* evaluateApplication("dev");
  const app = requireWorker(stack, "App");
  const bundle = yield* bundleWorker(yield* path.fromFileUrl(app.Props.main!), "App", app.Props);
  const environment = yield* resolveGraphValue(app.Props.env);
  const bindings: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    const resolved = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    if (
      typeof resolved !== "string" &&
      typeof resolved !== "number" &&
      typeof resolved !== "boolean"
    ) {
      return yield* Effect.die(new Error(`Unexpected runtime binding ${key}`));
    }
    bindings[key] = resolved;
  }
  return {
    plugins: [
      cloudflareTest({
        main: path.resolve(".alchemy/test-runtime/App", bundle.files[0].path),
        miniflare: {
          compatibilityDate: "2026-08-21",
          compatibilityFlags: ["nodejs_compat"],
          bindings,
          d1Databases: ["AuthDb"],
          r2Buckets: ["MailArchive"],
          queueProducers: ["MailIndex"],
          queueConsumers: { MailIndex: { maxBatchSize: 1 } },
          email: { send_email: [{ name: "EMAIL" }] },
          durableObjects: { AccountStore: { className: "AccountStore", useSQLite: true } },
        },
      }),
    ],
    test: { include: ["tests/**/*.worker.spec.ts"] },
  };
}).pipe(Effect.provide(NodeServices.layer));

export default defineConfig(() => Effect.runPromise(workerConfig));
