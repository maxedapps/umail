import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as CliConfig from "effect/unstable/cli/CliConfig";
import * as CliError from "effect/unstable/cli/CliError";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";

import { umailCommand } from "./commands/index.ts";

const cliLayer = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

export function formatCliError(error: unknown): string {
  if (Predicate.isError(error) && error.message.length > 0) return error.message;
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) return error._tag;
  return Predicate.isError(error) ? error.name : "Unknown error";
}

export function program(argv: ReadonlyArray<string>) {
  return Command.runWith(umailCommand, { version: "0.0.0" })(argv).pipe(
    Effect.provide(cliLayer),
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void;
      const error = Cause.squash(cause);
      // Command.runWith already rendered CLI parse/usage errors.
      return CliError.isCliError(error) ? Effect.void : Console.error(formatCliError(error));
    }),
  );
}
