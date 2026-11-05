import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { rerunTriggers } from "../../tests/rerun-triggers.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/account/worker-host.ts",
      miniflare: {
        compatibilityDate: "2026-08-21",
        r2Buckets: ["ARCHIVE"],
        queueProducers: ["INDEX"],
        durableObjects: {
          ACCOUNT_STORE: {
            className: "AccountStoreTestHost",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.worker.spec.ts"],
    // With the cache, a later worker gets its specs' whole module graph in one WebSocket message from
    // the Cloudflare pool, past workerd's limit (1009 "Message is too large"), which ends the worker.
    fsModuleCache: false,
    // Agents share the machine, and Vitest's default of a worker per core but one overloads it.
    maxWorkers: 4,
    // Some specs make hundreds of sequential Durable Object calls: well under 5 s alone, but not on
    // a busy machine.
    testTimeout: 30_000,
    // The specs import the host only as a type, so their imports miss what it runs. It doesn't import
    // src/api or src/web.
    forceRerunTriggers: rerunTriggers(
      "apps/server/vitest.worker.config.ts",
      "apps/server/src/!(api|web)/**",
      "apps/server/src/*.ts",
      "apps/server/test/account/worker-host.ts",
    ),
  },
});
