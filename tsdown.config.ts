import { defineConfig, type UserConfig } from "tsdown";

const clientBundlePolicy = {
  outDir: "dist/clients",
  clean: true,
  format: "esm",
  platform: "node",
  target: "node22.18",
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  minify: false,
  exports: false,
  exe: false,
  outputOptions: {
    codeSplitting: false,
  },
  deps: {
    alwaysBundle: () => true,
    onlyBundle: false,
    onlyImport: [],
  },
} satisfies UserConfig;

export default defineConfig({
  ...clientBundlePolicy,
  name: "umail",
  entry: {
    umail: "apps/cli/src/bin.ts",
  },
});
