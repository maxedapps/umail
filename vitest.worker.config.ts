import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as Redacted from "effect/Redacted";
import { defineConfig } from "vitest/config";
import { evaluateApplication, requireWorker, resolveGraphValue } from "./tests/stack-fixture.ts";
import { bundleWorker } from "./tests/worker-bundle.ts";

export default defineConfig(async () => {
  const stack = await evaluateApplication("dev");
  const app = requireWorker(stack, "App");
  const bundle = await bundleWorker(fileURLToPath(app.Props.main!), "App", app.Props);
  const environment = await resolveGraphValue(app.Props.env);
  const bindings: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    const resolved = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    if (
      typeof resolved !== "string" &&
      typeof resolved !== "number" &&
      typeof resolved !== "boolean"
    ) {
      throw new Error(`Unexpected runtime binding ${key}`);
    }
    bindings[key] = resolved;
  }
  return {
    plugins: [
      cloudflareTest({
        main: resolve(".alchemy/test-runtime/App", bundle.files[0].path),
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
});
