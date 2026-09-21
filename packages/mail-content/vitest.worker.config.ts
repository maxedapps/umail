import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-21",
      },
    }),
  ],
  test: {
    include: ["test/**/*.worker.spec.ts"],
  },
});
