import type { UmailClientEnvironment } from "@umail/api-contract/client";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";

import { OAuthCredentialStore, OAuthScheduler } from "./auth.ts";
import { ApprovalTokenSource } from "./approvals.ts";
import { program } from "./main.ts";

export const CliLive = Layer.mergeAll(
  NodeHttpClient.layerUndici,
  OAuthCredentialStore.layer,
  OAuthScheduler.layer,
  ApprovalTokenSource.layer.pipe(Layer.provide(NodeServices.layer)),
).pipe(Layer.provideMerge(NodeServices.layer));

export function runCli(argv: ReadonlyArray<string>, env: UmailClientEnvironment) {
  NodeRuntime.runMain(program(argv, env).pipe(Effect.provide(CliLive)), {
    disableErrorReporting: true,
    teardown: (exit, _onExit) => {
      Runtime.defaultTeardown(exit, (code) => {
        process.exit(code);
      });
    },
  });
}
