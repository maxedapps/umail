import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { ApprovalDecisionState, MailThreadPage } from "../packages/api-contract/src/api-spec.ts";

const REPO_ROOT = new URL("..", import.meta.url);
const CLIENTS_DIRECTORY = new URL("../dist/clients/", import.meta.url);
const CLI_ARTIFACT = "umail.mjs";
const NODE_SHEBANG = "#!/usr/bin/env node";
const BUILD_SENTINEL_URL = "https://umail-build-sentinel.invalid";
const TEST_ACCESS_TOKEN = "artifact-test-oauth-access-token";
const APPROVAL_TOKEN = "b".repeat(64);
const JsonString = Schema.fromJsonString(Schema.Json);

const threadPage = {
  items: [],
  nextCursor: "next-cursor",
} satisfies Json;

class ArtifactApprovalDecisionResult extends Schema.Class<ArtifactApprovalDecisionResult>(
  "ArtifactApprovalDecisionResult",
)({
  state: ApprovalDecisionState,
}) {}

interface CapturedApiRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
}

type FakeApprovalBehavior = "redirect-denied" | "server-error";

interface CopiedProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Runs a command to exit, draining both pipes while it runs.
const runToExit = Effect.fn("runToExit")(function* (command: ChildProcess.Command) {
  const child = yield* command;
  const [stdout, stderr, status] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { status, stdout, stderr } satisfies CopiedProcessResult;
});

const BuildClients = Layer.effectDiscard(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const build = yield* runToExit(
      ChildProcess.make("pnpm", ["build:clients"], {
        cwd: yield* path.fromFileUrl(REPO_ROOT),
        env: { UMAIL_URL: BUILD_SENTINEL_URL },
        extendEnv: true,
        stdin: "ignore",
      }),
    );
    expect(build.status, build.stderr || build.stdout).toBe(0);
  }),
);

const startFakeApi = Effect.fn("startFakeApi")(function* (
  approvalBehavior: FakeApprovalBehavior = "redirect-denied",
) {
  const requests: Array<CapturedApiRequest> = [];
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address,
  );
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const captured = {
        method: request.method,
        url: new URL(request.url, "http://127.0.0.1"),
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      } satisfies CapturedApiRequest;
      requests.push(captured);
      if (captured.method === "GET" && captured.url.pathname === "/threads") {
        return jsonResponse(200, threadPage);
      }
      if (
        captured.method === "POST" &&
        captured.url.pathname === `/approvals/${APPROVAL_TOKEN}/approve`
      ) {
        if (approvalBehavior === "server-error") {
          return jsonResponse(500, { error: "approval failed" });
        }
        return HttpServerResponse.redirect(`/approvals/${APPROVAL_TOKEN}`, {
          status: 303,
          headers: {
            "x-umail-approval-state": "denied",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return jsonResponse(404, { error: "not found" });
    }),
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
});

function jsonResponse(status: number, value: Json) {
  return HttpServerResponse.jsonUnsafe(value, { status });
}

const copyArtifactAlone = Effect.fn("copyArtifactAlone")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "umail-artifact-" });
  const artifact = path.join(directory, CLI_ARTIFACT);
  yield* fs.copyFile(path.join(yield* path.fromFileUrl(CLIENTS_DIRECTORY), CLI_ARTIFACT), artifact);
  return { directory, path: artifact };
});

// Merged over the inherited environment; an undefined UMAIL_URL removes the inherited one.
// A type alias, so it stays assignable to the spawn environment's index signature.
type CopiedEnvironment = {
  UMAIL_URL: string | undefined;
  XDG_STATE_HOME?: string;
};

function copiedAloneEnvironment(umail: { readonly UMAIL_URL?: string }, stateHome?: string) {
  const env: CopiedEnvironment = { UMAIL_URL: umail.UMAIL_URL };
  if (stateHome !== undefined) env.XDG_STATE_HOME = stateHome;
  return env;
}

const writeCredentialState = Effect.fn("writeCredentialState")(function* (
  stateHome: string,
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateHome, "umail");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const state = yield* Schema.encodeEffect(JsonString)({
    version: 2,
    kind: "authorized",
    origin,
    issuer: `${origin}/api/auth`,
    resource: origin,
    scope: "umail:access offline_access",
    clientId: "artifact-cli",
    accessToken: TEST_ACCESS_TOKEN,
    refreshToken: "artifact-test-refresh-token",
    expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
  });
  yield* fs.writeFileString(path.join(directory, "oauth.json"), `${state}\n`, { mode: 0o600 });
});

const runCopiedNode = Effect.fn("runCopiedNode")(function* (
  scriptPath: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: CopiedEnvironment,
) {
  return yield* runToExit(
    ChildProcess.make("node", [scriptPath, ...args], {
      cwd,
      env,
      extendEnv: true,
      stdin: "ignore",
    }),
  );
});

function expectNoSecretLeakage(result: CopiedProcessResult, baseUrl?: string) {
  for (const output of [result.stdout, result.stderr]) {
    expect(output).not.toContain(TEST_ACCESS_TOKEN);
    expect(output).not.toContain(APPROVAL_TOKEN);
    expect(output).not.toContain(BUILD_SENTINEL_URL);
    if (baseUrl !== undefined) expect(output).not.toContain(baseUrl);
  }
}

function requestAt(requests: ReadonlyArray<CapturedApiRequest>, index: number) {
  const request = requests[index];
  if (request === undefined) throw new Error(`Expected captured API request at index ${index}`);
  return request;
}

// Builds the CLI once; real clock and processes, released with each test's scope.
layer(Layer.provideMerge(BuildClients, NodeServices.layer), {
  timeout: "120 seconds",
  excludeTestServices: true,
})("standalone CLI artifact", (it) => {
  it.effect(
    "emits exactly one executable shebang file without embedding build configuration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const clientsDirectory = yield* path.fromFileUrl(CLIENTS_DIRECTORY);
        expect(yield* fs.readDirectory(clientsDirectory)).toEqual([CLI_ARTIFACT]);
        const artifactPath = path.join(clientsDirectory, CLI_ARTIFACT);
        const contents = yield* fs.readFileString(artifactPath);
        expect(contents.split("\n")[0]).toBe(NODE_SHEBANG);
        expect(contents).not.toContain(BUILD_SENTINEL_URL);
        expect((yield* fs.stat(artifactPath)).mode & 0o111).not.toBe(0);
      }),
    30_000,
  );

  it.effect(
    "prints help from a standalone copy",
    () =>
      Effect.gen(function* () {
        const copied = yield* copyArtifactAlone();
        const result = yield* runCopiedNode(
          copied.path,
          copied.directory,
          ["--help"],
          copiedAloneEnvironment({}),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("login");
        expect(result.stdout).toContain("messages");
        expect(result.stdout).toContain("jobs");
        expect(result.stdout.toLowerCase()).not.toContain("bootstrap");
        expect(result.stdout).not.toMatch(/--token(?=[\s<])/u);
        expectNoSecretLeakage(result);
      }),
    30_000,
  );

  it.effect(
    "fails safely without UMAIL_URL",
    () =>
      Effect.gen(function* () {
        const copied = yield* copyArtifactAlone();
        const result = yield* runCopiedNode(
          copied.path,
          copied.directory,
          ["threads", "list"],
          copiedAloneEnvironment({}),
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("UMAIL_URL is required");
        expect(result.stdout).toBe("");
        expectNoSecretLeakage(result);
      }),
    30_000,
  );

  it.effect(
    "uses the persisted OAuth access token for a REST command",
    () =>
      Effect.gen(function* () {
        const copied = yield* copyArtifactAlone();
        const api = yield* startFakeApi();
        yield* writeCredentialState(copied.directory, api.baseUrl);
        const result = yield* runCopiedNode(
          copied.path,
          copied.directory,
          ["threads", "list", "--limit", "2"],
          copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }, copied.directory),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(MailThreadPage))(result.stdout),
        ).toEqual(threadPage);
        expect(api.requests).toHaveLength(1);
        const request = requestAt(api.requests, 0);
        expect(request.method).toBe("GET");
        expect(`${request.url.pathname}${request.url.search}`).toBe("/threads?limit=2");
        expect(request.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
        expect(request.contentType).toBe("application/json");
        expectNoSecretLeakage(result);
      }),
    30_000,
  );

  it.effect(
    "keeps public approval capability requests OAuth-independent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const copied = yield* copyArtifactAlone();
        const tokenPath = path.join(copied.directory, "approval-token");
        yield* fs.writeFileString(tokenPath, `${APPROVAL_TOKEN}\n`, { mode: 0o600 });
        const api = yield* startFakeApi();
        const result = yield* runCopiedNode(
          copied.path,
          copied.directory,
          ["approvals", "approve", "--token-file", tokenPath],
          copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(ArtifactApprovalDecisionResult))(
            result.stdout,
          ),
        ).toEqual({ state: "denied" });
        const request = requestAt(api.requests, 0);
        expect(request.authorization).toBeUndefined();
        expect(request.contentType).toBeUndefined();
        expectNoSecretLeakage(result, api.baseUrl);
      }),
    30_000,
  );

  it.effect(
    "redacts public approval failures",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const copied = yield* copyArtifactAlone();
        const tokenPath = path.join(copied.directory, "approval-token");
        yield* fs.writeFileString(tokenPath, `${APPROVAL_TOKEN}\n`, { mode: 0o600 });
        const api = yield* startFakeApi("server-error");
        const result = yield* runCopiedNode(
          copied.path,
          copied.directory,
          ["approvals", "approve", "--token-file", tokenPath],
          copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }),
        );
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "umail: The umail server failed (HTTP 500) on the approval request. Try again later.\n",
        );
        expectNoSecretLeakage(result, api.baseUrl);
      }),
    30_000,
  );
});
