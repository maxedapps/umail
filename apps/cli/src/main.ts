import type { UmailClientEnvironment } from "@umail/api-contract/client";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as CliConfig from "effect/unstable/cli/CliConfig";
import * as CliError from "effect/unstable/cli/CliError";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";

import { CliEnvironment, umailCommand } from "./commands/index.ts";

const TaggedCliError = Schema.Struct({
  _tag: Schema.String,
});

export interface CliFailure {
  readonly cause: unknown;
}

const cliLayer = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

export function formatCliError(failure: CliFailure): string {
  if (Predicate.isError(failure.cause) && failure.cause.message.length > 0) {
    return failure.cause.message;
  }
  const tagged = Schema.decodeUnknownResult(TaggedCliError)(failure.cause);
  if (Result.isSuccess(tagged) && tagged.success._tag.length > 0) {
    return tagged.success._tag;
  }
  if (Predicate.isError(failure.cause) && failure.cause.name.length > 0) {
    return failure.cause.name;
  }
  return "Unknown error";
}

export function program(argv: ReadonlyArray<string>, env: UmailClientEnvironment) {
  return Command.runWith(umailCommand, { version: "0.0.0" })(argv).pipe(
    Effect.provideService(CliEnvironment, env),
    Effect.provide(cliLayer),
    Effect.tapError((error) =>
      CliError.isCliError(error) ? Effect.void : Console.error(formatCliError({ cause: error })),
    ),
  );
}
