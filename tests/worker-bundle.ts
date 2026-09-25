import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Artifacts from "alchemy/Artifacts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

// Compile through the same source provider used for deployment, including runtime phase folding.
export const bundleWorker = Effect.fn("bundleWorker")(
  function* (main: string, id: string, props: Cloudflare.WorkerProps) {
    const path = yield* Path.Path;
    const workerProps = {
      ...props,
      main: path.resolve(main),
      build: { output: { dir: path.resolve(".alchemy/test-runtime", id), minify: false } },
    };
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
    if (!built.bundle) return yield* Effect.die(new Error(`No runtime bundle for ${id}`));
    return built.bundle;
  },
  (effect, _main, id) =>
    effect.pipe(
      Effect.provide(Artifacts.scopedArtifacts(id)),
      Artifacts.provideFreshArtifactStore,
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);
