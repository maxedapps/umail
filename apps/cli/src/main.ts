import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as CliConfig from "effect/unstable/cli/CliConfig";
import * as CliError from "effect/unstable/cli/CliError";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";

const cliLayer = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

// What a failure prints: one line for an expected error, which carries its own message; the full
// cause for a defect or a failure without an error. Nothing for an interruption or a usage error,
// which Command.runWith has already shown.
export function renderCause(cause: Cause.Cause<unknown>): string | null {
  if (Cause.hasInterruptsOnly(cause)) return null;
  if (Cause.hasDies(cause)) return Cause.pretty(cause);
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error) || !Predicate.isError(error.value)) return Cause.pretty(cause);
  if (CliError.isCliError(error.value)) return null;
  return `umail: ${error.value.message}`;
}

export function program<const Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  argv: ReadonlyArray<string>,
) {
  return Command.runWith(command, { version: "0.0.0" })(argv).pipe(
    Effect.provide(cliLayer),
    Effect.tapCause((cause) => {
      const rendered = renderCause(cause);
      return rendered === null ? Effect.void : Console.error(rendered);
    }),
  );
}
