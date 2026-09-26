import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { makeCredentialStore, OAuthCredentials } from "../apps/cli/src/credential-store.ts";

const REPO_ROOT = new URL("..", import.meta.url);
const CREDENTIAL_STORE_HREF = new URL("../apps/cli/src/credential-store.ts", import.meta.url).href;
const LockWorkerOutput = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    tag: Schema.Literals(["OAuthCredentialLockError", "OAuthCredentialStoreError"]),
  }),
]);
const ACCESS_TOKEN = "cred-proc-access-token";
const REFRESH_TOKEN = "cred-proc-refresh-token";
const ROTATED_ACCESS_TOKEN = "cred-proc-rotated-access";
const ROTATED_REFRESH_TOKEN = "cred-proc-rotated-refresh";
const DEVICE_CODE = "cred-proc-device-code";
const SECRETS = [
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  ROTATED_ACCESS_TOKEN,
  ROTATED_REFRESH_TOKEN,
  DEVICE_CODE,
] as const;

interface CliProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FakeOAuthControl {
  deviceApproved: boolean;
  tokenDelayMs: number;
  hangToken: boolean;
  hangRevoke: boolean;
  refreshTokenRequests: number;
  deviceTokenRequests: number;
  revokeRequests: number;
}

type ProcessEnvironment = Record<string, string>;

// Real clock and processes; every server, child and directory is released with the test's scope.
layer(NodeServices.layer, { excludeTestServices: true })(
  "credential transitions across processes",
  (it) => {
    it.effect(
      "does not restore credentials when a delayed refresh finishes after logout",
      () =>
        Effect.gen(function* () {
          const { server, stateHome, env } = yield* startHarness();
          yield* writeAuthorizedState(stateHome, server.baseUrl, -1_000);
          server.control.tokenDelayMs = 800;
          const list = yield* spawnCli(["addresses", "list"], env);
          yield* waitFor(() => server.control.refreshTokenRequests > 0, "refresh request");
          const logout = yield* spawnCli(["logout"], env);
          const logoutResult = yield* logout.finished;
          expect(logoutResult.status).toBe(0);
          expectNoSecrets(logoutResult);
          const listed = yield* list.finished;
          expectNoSecrets(listed);
          expect(yield* readState(stateHome)).toBeNull();
        }),
      15_000,
    );

    it.effect(
      "serializes overlapping refresh so only one token request is made",
      () =>
        Effect.gen(function* () {
          const { server, stateHome, env } = yield* startHarness();
          yield* writeAuthorizedState(stateHome, server.baseUrl, -1_000);
          server.control.tokenDelayMs = 400;
          const first = yield* spawnCli(["addresses", "list"], env);
          const second = yield* spawnCli(["addresses", "list"], env);
          const results = yield* Effect.all([first.finished, second.finished]);
          for (const result of results) {
            expect(result.status).toBe(0);
            expectNoSecrets(result);
          }
          expect(server.control.refreshTokenRequests).toBe(1);
          const state = yield* readState(stateHome);
          expect(state).toMatchObject({
            accessToken: ROTATED_ACCESS_TOKEN,
            refreshToken: ROTATED_REFRESH_TOKEN,
          });
        }),
      15_000,
    );

    it.effect(
      "cancels device login on SIGINT without persisting tokens or leaving locks",
      () =>
        Effect.gen(function* () {
          const { stateHome, env } = yield* startHarness();
          const login = yield* spawnCli(["login"], env);
          yield* waitFor(
            () => login.stdout().includes("Waiting for approval"),
            "device login prompt",
          );
          yield* login.handle.kill({ killSignal: "SIGINT" });
          const result = yield* login.finished;
          expect(result.status).toBe(130);
          expectNoSecrets(result);
          expect(yield* readState(stateHome)).toBeNull();
          yield* expectLockFilesGone(stateHome);
        }),
      15_000,
    );

    it.effect(
      "keeps the local credentials and exits non-zero when remote revocation stalls",
      () =>
        Effect.gen(function* () {
          const { server, stateHome, env } = yield* startHarness();
          yield* writeAuthorizedState(stateHome, server.baseUrl, 3_600_000);
          server.control.hangRevoke = true;
          const [elapsed, result] = yield* Effect.timed(
            Effect.flatMap(spawnCli(["logout"], env), (logout) => logout.finished),
          );
          expect(Duration.toMillis(elapsed)).toBeLessThan(8_000);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("local OAuth credentials were kept");
          expectNoSecrets(result);
          expect(yield* readState(stateHome)).toMatchObject({ refreshToken: REFRESH_TOKEN });
        }),
      15_000,
    );

    it.effect(
      "terminates a stalled refresh instead of hanging",
      () =>
        Effect.gen(function* () {
          const { server, stateHome, env } = yield* startHarness();
          yield* writeAuthorizedState(stateHome, server.baseUrl, -1_000);
          server.control.hangToken = true;
          const [elapsed, result] = yield* Effect.timed(
            Effect.flatMap(spawnCli(["addresses", "list"], env), (list) => list.finished),
          );
          expect(Duration.toMillis(elapsed)).toBeLessThan(10_000);
          expect(result.status).not.toBe(0);
          expectNoSecrets(result);
          yield* expectLockFilesGone(stateHome);
        }),
      15_000,
    );

    it.effect(
      "releases the credential lock when a stalled refresh is interrupted",
      () =>
        Effect.gen(function* () {
          const { server, stateHome, env } = yield* startHarness();
          yield* writeAuthorizedState(stateHome, server.baseUrl, -1_000);
          server.control.hangToken = true;
          const list = yield* spawnCli(["addresses", "list"], env);
          yield* waitFor(() => server.control.refreshTokenRequests > 0, "hung refresh");
          yield* list.handle.kill({ killSignal: "SIGINT" });
          const result = yield* list.finished;
          expect(result.status).toBe(130);
          expectNoSecrets(result);
          yield* expectLockFilesGone(stateHome);
        }),
      15_000,
    );

    it.effect(
      "does not unlink a live lock because its PID is empty",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stateHome = yield* makeStateHome;
          const origin = "https://umail.example.test";
          yield* writeAuthorizedState(stateHome, origin, 3_600_000);
          const lockPath = `${yield* credentialFileIn(stateHome)}.lock`;
          yield* fs.writeFileString(lockPath, "", { mode: 0o600 });
          yield* fs.chmod(lockPath, 0o600);
          const workers = [yield* spawnLockWorker(stateHome), yield* spawnLockWorker(stateHome)];
          const results = yield* Effect.all(workers.map((worker) => worker.finished));
          for (const result of results) {
            expect(result.status).toBe(0);
            expectNoSecrets(result);
            expect(
              yield* Schema.decodeEffect(Schema.fromJsonString(LockWorkerOutput))(result.stdout),
            ).toEqual({ ok: false, tag: "OAuthCredentialLockError" });
          }
          expect(yield* readState(stateHome)).toMatchObject({
            accessToken: ACCESS_TOKEN,
            refreshToken: REFRESH_TOKEN,
          });
          expect((yield* fs.stat(lockPath)).type).toBe("File");
          expect(yield* fs.readFileString(lockPath)).toBe("");
        }),
      15_000,
    );

    it.effect("rejects a corrupt credential file without leaking secrets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateHome, env } = yield* startHarness();
        const file = yield* credentialFileIn(stateHome);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(file, "{not-json\n", { mode: 0o600 });
        const result = yield* (yield* spawnCli(["addresses", "list"], env)).finished;
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "is not valid umail credentials. Delete it and run: umail login",
        );
        expectNoSecrets(result);
      }),
    );

    it.effect("rejects a world-writable credential file without leaking secrets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { server, stateHome, env } = yield* startHarness();
        yield* writeAuthorizedState(stateHome, server.baseUrl, 3_600_000);
        yield* fs.chmod(yield* credentialFileIn(stateHome), 0o666);
        const result = yield* (yield* spawnCli(["addresses", "list"], env)).finished;
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("is open to other users (mode 666). Run: chmod 600");
        expectNoSecrets(result);
      }),
    );

    it.effect("rejects a symlinked credential file without leaking secrets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateHome, env } = yield* startHarness();
        const file = yield* credentialFileIn(stateHome);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        yield* fs.symlink(path.join(stateHome, "missing"), file);
        const result = yield* (yield* spawnCli(["addresses", "list"], env)).finished;
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("is a symlink;");
        expectNoSecrets(result);
      }),
    );
  },
);

const makeStateHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "umail-cred-proc-" });
});

const startHarness = Effect.fn("startHarness")(function* () {
  const stateHome = yield* makeStateHome;
  const server = yield* startFakeOAuth();
  const env = { UMAIL_URL: server.baseUrl, XDG_STATE_HOME: stateHome };
  return { server, stateHome, env };
});

const spawnCli = Effect.fn("spawnCli")(function* (
  args: ReadonlyArray<string>,
  env: ProcessEnvironment,
) {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(REPO_ROOT);
  return yield* trackChild(
    ChildProcess.make(process.execPath, [path.join(root, "apps/cli/src/bin.ts"), ...args], {
      cwd: root,
      env,
      extendEnv: true,
      stdin: "ignore",
      killSignal: "SIGKILL",
    }),
  );
});

const LOCK_WORKER_SCRIPT = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { credentialFile, makeCredentialStore } from ${JSON.stringify(CREDENTIAL_STORE_HREF)};

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* makeCredentialStore(yield* credentialFile);
    return yield* Effect.result(store.withLock(store.remove));
  }).pipe(Effect.provide(NodeServices.layer)),
);
if (Result.isFailure(result)) {
  process.stdout.write(JSON.stringify({ ok: false, tag: result.failure._tag }));
} else {
  process.stdout.write(JSON.stringify({ ok: true }));
}
`;

const spawnLockWorker = Effect.fn("spawnLockWorker")(function* (stateHome: string) {
  const path = yield* Path.Path;
  return yield* trackChild(
    ChildProcess.make(process.execPath, ["--input-type=module", "--eval", LOCK_WORKER_SCRIPT], {
      cwd: yield* path.fromFileUrl(REPO_ROOT),
      env: { XDG_STATE_HOME: stateHome },
      extendEnv: true,
      stdin: "ignore",
      killSignal: "SIGKILL",
    }),
  );
});

// Collects output while the process runs, so tests can wait on it and both pipes keep draining.
const trackChild = Effect.fn("trackChild")(function* (command: ChildProcess.Command) {
  const handle = yield* command;
  const stdoutChunks: Array<string> = [];
  const stderrChunks: Array<string> = [];
  const collect = (stream: typeof handle.stdout, chunks: Array<string>) =>
    Effect.forkScoped(
      Stream.runForEach(Stream.decodeText(stream), (text) => Effect.sync(() => chunks.push(text))),
    );
  const stdout = yield* collect(handle.stdout, stdoutChunks);
  const stderr = yield* collect(handle.stderr, stderrChunks);
  const finished = Effect.gen(function* () {
    const status = yield* handle.exitCode;
    yield* Fiber.join(stdout);
    yield* Fiber.join(stderr);
    return {
      status,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    } satisfies CliProcessResult;
  });
  return { handle, stdout: () => stdoutChunks.join(""), finished };
});

const writeAuthorizedState = Effect.fn("writeAuthorizedState")(function* (
  stateHome: string,
  origin: string,
  expiresInMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* credentialFileIn(stateHome);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  const state = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthCredentials))({
    origin,
    scope: "umail:access offline_access",
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: (yield* Clock.currentTimeMillis) + expiresInMs,
  });
  yield* fs.writeFileString(file, `${state}\n`, { mode: 0o600 });
});

const credentialFileIn = Effect.fn("credentialFileIn")(function* (stateHome: string) {
  const path = yield* Path.Path;
  return path.join(stateHome, "umail", "oauth.json");
});

const readState = Effect.fn("readState")(function* (stateHome: string) {
  const store = yield* makeCredentialStore(yield* credentialFileIn(stateHome));
  return yield* store.read;
});

const expectLockFilesGone = Effect.fn("expectLockFilesGone")(function* (stateHome: string) {
  const fs = yield* FileSystem.FileSystem;
  expect(yield* fs.exists(`${yield* credentialFileIn(stateHome)}.lock`)).toBe(false);
});

function expectNoSecrets(result: CliProcessResult) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of SECRETS) {
    expect(output).not.toContain(secret);
  }
}

const waitFor = Effect.fn("waitFor")(function* (predicate: () => boolean, label: string) {
  yield* Effect.sync(predicate).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("25 millis") }),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${label}`)),
    }),
  );
});

const startFakeOAuth = Effect.fn("startFakeOAuth")(function* () {
  const control: FakeOAuthControl = {
    deviceApproved: false,
    tokenDelayMs: 0,
    hangToken: false,
    hangRevoke: false,
    refreshTokenRequests: 0,
    deviceTokenRequests: 0,
    revokeRequests: 0,
  };
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address,
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // Stalled requests are answered once the test ends: the server only closes after every
  // request has a response, even when its client already exited.
  const testEnded = yield* Deferred.make<void>();
  yield* server.serve(handleOAuthRequest(baseUrl, control, Deferred.await(testEnded)));
  yield* Effect.addFinalizer(() => Deferred.done(testEnded, Exit.void));
  return { baseUrl, control };
});

const handleOAuthRequest = (
  origin: string,
  control: FakeOAuthControl,
  stall: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, `${origin}/`);
    const body = yield* request.text;
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server/api/auth"
    ) {
      return jsonResponse(200, {
        issuer: `${origin}/api/auth`,
        device_authorization_endpoint: `${origin}/api/auth/device/code`,
        token_endpoint: `${origin}/api/auth/oauth2/token`,
        revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/device/code") {
      return jsonResponse(200, {
        device_code: DEVICE_CODE,
        user_code: "ABCD-EFGH",
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/oauth2/token") {
      const grantType = new URLSearchParams(body).get("grant_type");
      if (grantType === "refresh_token") control.refreshTokenRequests += 1;
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        control.deviceTokenRequests += 1;
      }
      if (control.hangToken) yield* stall;
      yield* Effect.sleep(Duration.millis(control.tokenDelayMs));
      if (grantType === "refresh_token" || control.deviceApproved) {
        return jsonResponse(200, rotatedTokens());
      }
      return jsonResponse(400, { error: "authorization_pending" });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/oauth2/revoke") {
      control.revokeRequests += 1;
      if (control.hangRevoke) yield* stall;
      return HttpServerResponse.empty({ status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/addresses") {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, { error: "not found" });
  });

function rotatedTokens() {
  return {
    access_token: ROTATED_ACCESS_TOKEN,
    refresh_token: ROTATED_REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 300,
    scope: "umail:access offline_access",
  };
}

function jsonResponse(status: number, value: Json) {
  return HttpServerResponse.jsonUnsafe(value, { status });
}
