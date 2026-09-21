import { fileURLToPath } from "node:url";
import { bundleMailTestModules } from "../../tests/worker-bundle.ts";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    await bundleMailTestModules(fileURLToPath(new URL("../..", import.meta.url).href)),
    cloudflareTest({
      main: "./test/mail/worker-host.ts",
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
        bindings: {
          ACCOUNT_ID: "account-test",
        },
      },
    }),
  ],
  test: {
    include: ["test/mail/**/*.worker.spec.ts"],
  },
}));
