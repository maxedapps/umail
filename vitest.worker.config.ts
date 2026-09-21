import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as Redacted from "effect/Redacted";
import { defineConfig } from "vitest/config";
import { evaluateApplication, requireWorker, resolveGraphValue } from "./tests/stack-fixture.ts";
import { bundleWorker } from "./tests/worker-bundle.ts";

export default defineConfig(async () => {
  const stack = await evaluateApplication("dev");
  // Build every deployed entrypoint so colocated resources are compiled at the runtime boundary.
  await Promise.all(
    ["Inbound", "IndexConsumer", "SendConsumer", "Recovery"].map(async (id) => {
      const worker = requireWorker(stack, id);
      await bundleWorker(fileURLToPath(worker.Props.main!), id, worker.Props);
    }),
  );
  const api = requireWorker(stack, "Api");
  const bundle = await bundleWorker(fileURLToPath(api.Props.main!), "Api", api.Props);
  const environment = await resolveGraphValue(api.Props.env);
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
        main: resolve(".alchemy/test-runtime/Api", bundle.files[0].path),
        miniflare: {
          compatibilityDate: "2026-08-21",
          compatibilityFlags: ["nodejs_compat"],
          bindings,
          d1Databases: ["AuthDb"],
          r2Buckets: ["MailArchive"],
          durableObjects: { AccountStore: { className: "AccountStore", useSQLite: true } },
        },
      }),
    ],
    test: { include: ["tests/**/*.worker.spec.ts"] },
  };
});
