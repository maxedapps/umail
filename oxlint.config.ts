import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

export default defineConfig({
  $schema: "./node_modules/@effect/tsgo/oxlint-schema.json",
  extends: [recommended],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts",
    },
  ],
  ignorePatterns: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    ".alchemy/**",
    ".wrangler/**",
    ".output/**",
    "tools/oxlint/anti-slop/**",
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "off",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
  },
  overrides: [
    {
      files: [
        "apps/server/src/mail/inbound.ts",
        "apps/server/src/mail/archive.ts",
        "apps/server/src/mail/policy.ts",
        "apps/server/src/mail/notifications.ts",
        "apps/server/test/mail/**",
        "apps/server/test/api/**",
        "apps/server/test/account/**",
        "tests/**",
      ],
      rules: {
        "effecttsgo/async-function": "off",
        "effecttsgo/global-date": "off",
        "effecttsgo/node-builtin-import": "off",
      },
    },
  ],
});
