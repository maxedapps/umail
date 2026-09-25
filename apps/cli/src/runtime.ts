import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OAuthScheduler } from "./auth.ts";
import { OAuthCredentialStore } from "./credential-store.ts";
import { ApprovalTokenSource } from "./approvals.ts";
import { program } from "./main.ts";

const CliLive = Layer.mergeAll(
  NodeHttpClient.layerUndici,
  OAuthCredentialStore.layer,
  OAuthScheduler.layer,
  ApprovalTokenSource.layer.pipe(Layer.provide(NodeServices.layer)),
).pipe(Layer.provideMerge(NodeServices.layer));

export function runCli(argv: ReadonlyArray<string>) {
  // Failures are printed once by `program`; the default teardown exits non-zero on failure only.
  NodeRuntime.runMain(program(argv).pipe(Effect.provide(CliLive)), {
    disableErrorReporting: true,
  });
}
