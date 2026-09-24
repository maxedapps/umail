import { resolve } from "node:path";
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
