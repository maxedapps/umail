import { builtinModules } from "node:module";
import * as Bundle from "alchemy/Bundle";
import { dirname, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Artifacts from "alchemy/Artifacts";
import * as Effect from "effect/Effect";

// Compile through the same source provider used for deployment, including runtime phase folding.
export function bundleWorker(main: string, id: string, props: Cloudflare.WorkerProps = {}) {
  const workerProps = {
    ...props,
    main: resolve(main),
    build: { output: { dir: resolve(".alchemy/test-runtime", id), minify: false } },
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* Cloudflare.resolveSource(workerProps);
      const built = yield* source.build(
        Cloudflare.makeSourceContext({
          id,
          fqn: id,
          workerName: id,
          props: workerProps,
          compatibility: { date: "2026-08-21", flags: ["nodejs_compat"] },
          stack: { name: "uMail", stage: "dev" },
        }),
      );
      if (!built.bundle) throw new Error(`No runtime bundle for ${id}`);
      return built.bundle;
    }).pipe(
      Effect.provide(Artifacts.scopedArtifacts(id)),
      Artifacts.provideFreshArtifactStore,
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );
}

// Workerd tests need runtime bundles too: Vite's plain TS transform retains deployment imports.
export async function bundleMailTestModules(root: string) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const modules = [
    "archive",
    "email-sender",
    "indexing",
    "send",
    "notifications",
    "inbound",
    "recovery",
  ];
  const directory = resolve(root, ".alchemy/test-runtime");
  await mkdir(directory, { recursive: true });
  const facade = resolve(directory, "mail-modules.ts");
  await writeFile(
    facade,
    modules
      .map(
        (name) =>
          `export * from ${JSON.stringify(pathToFileURL(resolve(root, "apps/server/src/mail", `${name}.ts`)).href)};`,
      )
      .join("\n") + "\nexport default {};\n",
  );
  // Share the test runner's Effect instance: Schema adapters are instance-sensitive.
  const output = resolve(directory, "mail-modules");
  const bundle = await Effect.runPromise(
    Bundle.build(
      {
        input: facade,
        external: (id) =>
          id === "effect" ||
          id.startsWith("effect/") ||
          id.startsWith("node:") ||
          id.startsWith("cloudflare:") ||
          id.startsWith("@effect/platform-bun/") ||
          builtinModules.includes(id),
        resolve: { conditionNames: ["workerd", "worker", "node", "default"] },
        preserveEntrySignatures: "strict",
      },
      { dir: output, format: "esm", entryFileNames: "index.js" },
    ),
  );
  const entry = resolve(output, bundle.files[0].path);
  const sources = new Set(
    modules.map((name) => resolve(root, "apps/server/src/mail", `${name}.ts`)),
  );
  return {
    name: "alchemy-runtime-test-modules",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (importer && sources.has(resolve(dirname(importer), source))) return entry;
      return undefined;
    },
  };
}
