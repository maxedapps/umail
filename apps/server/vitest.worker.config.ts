import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
  },
});
