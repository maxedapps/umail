import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { OAuthScheduler } from "./auth.ts";
import { OAuthCredentialStore } from "./credential-store.ts";
import { ApprovalTokenSource } from "./approvals.ts";
import { umailCommand } from "./commands/index.ts";
import { program } from "./main.ts";

const CliLive = Layer.mergeAll(
  NodeHttpClient.layerUndici,
  OAuthCredentialStore.layer,
  OAuthScheduler.layer,
  ApprovalTokenSource.layer,
);

export function runCli(argv: ReadonlyArray<string>) {
  // Provided to the command, not the program, so a setup failure (e.g. no HOME for the credential
  // file) is printed like any other failure. Failures are printed once by `program`; the default
  // teardown exits non-zero on failure only.
  NodeRuntime.runMain(
    program(umailCommand.pipe(Command.provide(CliLive)), argv).pipe(
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
