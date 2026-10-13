import { parseArgs } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import { deployConfigError, stackName } from "../apps/server/src/site.ts";

// Alchemy needs a string name when importing the entrypoint, before it installs its ConfigProvider.
// Match its --env-file precedence, preserving blanks so they cannot select another installation.
export async function loadStackName(): Promise<string> {
  const { values } = parseArgs({
    options: { "env-file": { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const selected = typeof values["env-file"] === "string" ? values["env-file"] : undefined;
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const shell = ConfigProvider.fromEnv({ preserveEmptyStrings: true });
      const path = selected ?? ((yield* fs.exists(".env")) ? ".env" : undefined);
      let provider = shell;
      if (path !== undefined) {
        const file = yield* ConfigProvider.fromDotEnv({ path, preserveEmptyStrings: true });
        provider =
          selected === undefined
            ? ConfigProvider.orElse(shell, file)
            : ConfigProvider.orElse(file, shell);
      }
      return yield* stackName.parse(provider);
    }).pipe(
      Effect.catchTag("ConfigError", (error) => Effect.fail(deployConfigError(error))),
      Effect.provide(NodeServices.layer),
    ),
  );
  // Throw the actual marked error, not runPromise's wrapper, for Alchemy's one-line config output.
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}
