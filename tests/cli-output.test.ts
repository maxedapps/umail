import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const CLI_BIN = new URL("../apps/cli/src/bin.ts", import.meta.url);
const JsonString = Schema.fromJsonString(Schema.Json);

it.live(
  "writes large JSON output completely to a pipe before exiting 0",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const addresses = Array.from({ length: 1_000 }, (_, index) => ({
        id: `address-${index}`,
        localPart: `inbox${index}`,
        address: `inbox${index}@umail.example.test`,
        displayName: "Inbox",
        active: true,
        forwardTo: null,
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:00.000Z",
      }));
      yield* HttpServer.serveEffect(Effect.succeed(HttpServerResponse.jsonUnsafe(addresses)));
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        (yield* HttpServer.HttpServer).address,
      );
      const origin = `http://127.0.0.1:${port}`;
      const stateHome = yield* fs.makeTempDirectoryScoped({ prefix: "umail-cli-output-" });
      yield* fs.makeDirectory(path.join(stateHome, "umail"), { mode: 0o700 });
      yield* fs.writeFileString(
        path.join(stateHome, "umail", "oauth.json"),
        yield* Schema.encodeEffect(JsonString)({
          version: 2,
          kind: "authorized",
          origin,
          issuer: `${origin}/api/auth`,
          resource: origin,
          scope: "umail:access offline_access",
          clientId: "cli-output",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
          generation: 0,
        }),
        { mode: 0o600 },
      );
      const child = yield* ChildProcess.make(
        process.execPath,
        [yield* path.fromFileUrl(CLI_BIN), "addresses", "list"],
        { env: { XDG_STATE_HOME: stateHome, UMAIL_URL: origin }, stdin: "ignore" },
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(yield* Schema.decodeEffect(JsonString)(stdout)).toEqual(addresses);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
  15_000,
);
