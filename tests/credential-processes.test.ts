import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  credentialLockPath,
  credentialPath,
  credentialRefreshLockPath,
  makeCredentialStore,
  type OAuthCredentialState,
} from "../apps/cli/src/credential-store.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_BIN = join(REPO_ROOT, "apps/cli/src/bin.ts");
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
const CLIENT_ID = "cred-proc-cli";
const SECRETS = [
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  ROTATED_ACCESS_TOKEN,
  ROTATED_REFRESH_TOKEN,
  DEVICE_CODE,
] as const;

interface CliProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface TrackedCliProcess {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly finished: Promise<CliProcessResult>;
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

interface FakeOAuthServer {
  readonly baseUrl: string;
  readonly control: FakeOAuthControl;
  readonly close: () => Promise<void>;
}

const openChildren: Array<ChildProcess> = [];
const openServers: Array<FakeOAuthServer> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  const children = openChildren.splice(0);
  const servers = openServers.splice(0);
  const directories = temporaryDirectories.splice(0);
  await Promise.all(children.map(stopChild));
  await Promise.all(servers.map((server) => server.close()));
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential transitions across processes", () => {
  it("does not restore credentials when a delayed refresh finishes after logout", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() - 1_000);
    server.control.tokenDelayMs = 800;
    const list = spawnCli(["addresses", "list"], env);
    await waitFor(() => server.control.refreshTokenRequests > 0, 5_000, "refresh request");
    const logout = spawnCli(["logout"], env);
    const logoutResult = await logout.finished;
    expect(logoutResult.status).toBe(0);
    expectNoSecrets(logoutResult);
    const listed = await list.finished;
    expectNoSecrets(listed);
    const state = await readState(stateHome);
    expect(state).toMatchObject({ kind: "registered", generation: 1, clientId: CLIENT_ID });
    expect(state).not.toHaveProperty("accessToken");
    expect(state).not.toHaveProperty("refreshToken");
  }, 15_000);

  it("serializes overlapping refresh so only one token request is made", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() - 1_000);
    server.control.tokenDelayMs = 400;
    const first = spawnCli(["addresses", "list"], env);
    const second = spawnCli(["addresses", "list"], env);
    const results = await Promise.all([first.finished, second.finished]);
    for (const result of results) {
      expect(result.status).toBe(0);
      expectNoSecrets(result);
    }
    expect(server.control.refreshTokenRequests).toBe(1);
    const state = await readState(stateHome);
    expect(state).toMatchObject({
      kind: "authorized",
      accessToken: ROTATED_ACCESS_TOKEN,
      refreshToken: ROTATED_REFRESH_TOKEN,
      generation: 0,
    });
  }, 15_000);

  it("cancels device login on SIGINT without persisting tokens or leaving locks", async () => {
    const { stateHome, env } = await startHarness();
    const login = spawnCli(["login"], env);
    await waitFor(
      () => login.stdout().includes("Waiting for approval"),
      5_000,
      "device login prompt",
    );
    login.child.kill("SIGINT");
    const result = await login.finished;
    expect(result.status).toBe(130);
    expectNoSecrets(result);
    expect(await readState(stateHome)).toBeNull();
    expectLockFilesGone(stateHome);
  }, 15_000);

  it("keeps the local credentials and exits non-zero when remote revocation stalls", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() + 3_600_000);
    server.control.hangRevoke = true;
    const started = Date.now();
    const result = await spawnCli(["logout"], env).finished;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local OAuth credentials were kept");
    expectNoSecrets(result);
    expect(await readState(stateHome)).toMatchObject({
      kind: "authorized",
      generation: 0,
      refreshToken: REFRESH_TOKEN,
    });
  }, 15_000);

  it("terminates a stalled refresh instead of hanging", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() - 1_000);
    server.control.hangToken = true;
    const started = Date.now();
    const result = await spawnCli(["addresses", "list"], env).finished;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).not.toBe(0);
    expectNoSecrets(result);
    expectLockFilesGone(stateHome);
  }, 15_000);

  it("releases the refresh lock when a stalled refresh is interrupted", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() - 1_000);
    server.control.hangToken = true;
    const list = spawnCli(["addresses", "list"], env);
    await waitFor(() => server.control.refreshTokenRequests > 0, 5_000, "hung refresh");
    list.child.kill("SIGINT");
    const result = await list.finished;
    expect(result.status).toBe(130);
    expectNoSecrets(result);
    expectLockFilesGone(stateHome);
  }, 15_000);

  it("does not unlink a live lock because its PID is empty", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "umail-cred-proc-"));
    temporaryDirectories.push(stateHome);
    const origin = "https://umail.example.test";
    writeAuthorizedState(stateHome, origin, Date.now() + 3_600_000);
    const lockPath = credentialLockPath(credentialPath({ XDG_STATE_HOME: stateHome }));
    writeFileSync(lockPath, "", { mode: 0o600 });
    chmodSync(lockPath, 0o600);
    const env = { ...process.env, XDG_STATE_HOME: stateHome };
    const workers = [spawnLockWorker(env, origin), spawnLockWorker(env, origin)];
    const results = await Promise.all(workers.map((worker) => worker.finished));
    for (const result of results) {
      expect(result.status).toBe(0);
      expectNoSecrets(result);
      expect(Schema.decodeSync(Schema.fromJsonString(LockWorkerOutput))(result.stdout)).toEqual({
        ok: false,
        tag: "OAuthCredentialLockError",
      });
    }
    expect(await readState(stateHome)).toMatchObject({
      kind: "authorized",
      generation: 0,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });
    expect(statSync(lockPath).isFile()).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("");
  }, 15_000);

  it("rejects a corrupt credential file without leaking secrets", async () => {
    const { stateHome, env } = await startHarness();
    const path = credentialPath({ XDG_STATE_HOME: stateHome });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{not-json\n", { mode: 0o600 });
    const result = await spawnCli(["addresses", "list"], env).finished;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing or insecure");
    expectNoSecrets(result);
  });

  it("rejects a world-writable credential file without leaking secrets", async () => {
    const { server, stateHome, env } = await startHarness();
    writeAuthorizedState(stateHome, server.baseUrl, Date.now() + 3_600_000);
    chmodSync(credentialPath({ XDG_STATE_HOME: stateHome }), 0o666);
    const result = await spawnCli(["addresses", "list"], env).finished;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing or insecure");
    expectNoSecrets(result);
  });

  it("rejects a symlinked credential file without leaking secrets", async () => {
    const { stateHome, env } = await startHarness();
    const path = credentialPath({ XDG_STATE_HOME: stateHome });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(join(stateHome, "missing"), path);
    const result = await spawnCli(["addresses", "list"], env).finished;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing or insecure");
    expectNoSecrets(result);
  });
});

async function startHarness() {
  const stateHome = mkdtempSync(join(tmpdir(), "umail-cred-proc-"));
  temporaryDirectories.push(stateHome);
  const server = await startFakeOAuth();
  openServers.push(server);
  const env = cliEnvironment(server.baseUrl, stateHome);
  return { server, stateHome, env };
}

function cliEnvironment(origin: string, stateHome: string) {
  return {
    ...process.env,
    UMAIL_URL: origin,
    XDG_STATE_HOME: stateHome,
  };
}

function spawnCli(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): TrackedCliProcess {
  return trackChild(
    spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function spawnLockWorker(env: NodeJS.ProcessEnv, origin: string): TrackedCliProcess {
  const script = `
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeCredentialStore } from ${JSON.stringify(CREDENTIAL_STORE_HREF)};

const result = await Effect.runPromise(
  Effect.result(makeCredentialStore(process.env).clearTokens(${JSON.stringify(origin)})),
);
if (Result.isFailure(result)) {
  process.stdout.write(JSON.stringify({ ok: false, tag: result.failure._tag }));
} else {
  process.stdout.write(JSON.stringify({ ok: true }));
}
`;
  return trackChild(
    spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function trackChild(child: ChildProcess): TrackedCliProcess {
  openChildren.push(child);
  const stdoutChunks: Array<string> = [];
  const stderrChunks: Array<string> = [];
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("Expected piped stdio from CLI process");
  }
  stdout.on("data", (chunk: string | Buffer) => stdoutChunks.push(chunk.toString()));
  stderr.on("data", (chunk: string | Buffer) => stderrChunks.push(chunk.toString()));
  const finished = Promise.race([
    once(child, "error").then((caught) => {
      throw caught[0];
    }),
    once(child, "close").then((closeArgs) => {
      const status = Schema.decodeUnknownSync(Schema.NullOr(Schema.Int))(closeArgs[0]);
      const signal = Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(closeArgs[1]);
      return {
        status,
        signal: decodeSignal(signal),
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      } satisfies CliProcessResult;
    }),
  ]);
  return {
    child,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
    finished,
  };
}

function decodeSignal(signal: string | null): NodeJS.Signals | null {
  if (signal === null) return null;
  return Schema.decodeUnknownSync(Schema.Literals(["SIGINT", "SIGTERM", "SIGKILL"]))(signal);
}

function writeAuthorizedState(stateHome: string, origin: string, expiresAt: number) {
  const path = credentialPath({ XDG_STATE_HOME: stateHome });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state = {
    version: 2,
    kind: "authorized",
    origin,
    issuer: `${origin}/api/auth`,
    resource: origin,
    scope: "umail:access offline_access",
    clientId: CLIENT_ID,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt,
    generation: 0,
  } satisfies OAuthCredentialState;
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

async function readState(stateHome: string) {
  return Effect.runPromise(makeCredentialStore({ XDG_STATE_HOME: stateHome }).read);
}

function expectLockFilesGone(stateHome: string) {
  const path = credentialPath({ XDG_STATE_HOME: stateHome });
  expect(existsSync(credentialLockPath(path))).toBe(false);
  expect(existsSync(credentialRefreshLockPath(path))).toBe(false);
}

function expectNoSecrets(result: CliProcessResult) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of SECRETS) {
    expect(output).not.toContain(secret);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

function startFakeOAuth() {
  return new Promise<FakeOAuthServer>((resolve, reject) => {
    const control: FakeOAuthControl = {
      deviceApproved: false,
      tokenDelayMs: 0,
      hangToken: false,
      hangRevoke: false,
      refreshTokenRequests: 0,
      deviceTokenRequests: 0,
      revokeRequests: 0,
    };
    const delayed: Array<ReturnType<typeof setTimeout>> = [];
    const server = createServer((request, response) => {
      void handleOAuthRequest(request, response, server, control, delayed).catch(() => {
        if (!response.headersSent) jsonResponse(response, 500, { error: "server_error" });
        else response.end();
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const fake = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        control,
        close: () => closeHttpServer(server, delayed),
      };
      resolve(fake);
    });
  });
}

async function handleOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
  control: FakeOAuthControl,
  delayed: Array<ReturnType<typeof setTimeout>>,
) {
  const method = Schema.decodeUnknownSync(Schema.String)(request.method);
  const rawUrl = Schema.decodeUnknownSync(Schema.String)(request.url);
  const origin = serverOrigin(server);
  const url = new URL(rawUrl, `${origin}/`);
  const body = await readBody(request);
  if (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server/api/auth") {
    jsonResponse(response, 200, {
      issuer: `${origin}/api/auth`,
      device_authorization_endpoint: `${origin}/api/auth/device/code`,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/device/code") {
    jsonResponse(response, 200, {
      device_code: DEVICE_CODE,
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/device`,
      verification_uri_complete: `${origin}/device?user_code=ABCD-EFGH`,
      expires_in: 600,
      interval: 1,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/oauth2/token") {
    const grantType = new URLSearchParams(body).get("grant_type");
    if (grantType === "refresh_token") control.refreshTokenRequests += 1;
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      control.deviceTokenRequests += 1;
    }
    if (control.hangToken) return;
    const send = () => {
      if (grantType === "refresh_token") {
        jsonResponse(response, 200, rotatedTokens());
        return;
      }
      if (control.deviceApproved) {
        jsonResponse(response, 200, rotatedTokens());
        return;
      }
      jsonResponse(response, 400, { error: "authorization_pending" });
    };
    if (control.tokenDelayMs <= 0) {
      send();
      return;
    }
    delayed.push(setTimeout(send, control.tokenDelayMs));
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/oauth2/revoke") {
    control.revokeRequests += 1;
    if (control.hangRevoke) return;
    response.writeHead(200);
    response.end();
    return;
  }
  if (method === "GET" && url.pathname === "/addresses") {
    jsonResponse(response, 200, []);
    return;
  }
  jsonResponse(response, 404, { error: "not found" });
}

function rotatedTokens() {
  return {
    access_token: ROTATED_ACCESS_TOKEN,
    refresh_token: ROTATED_REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 300,
    scope: "umail:access offline_access",
  };
}

function serverOrigin(server: Server) {
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
  return `http://127.0.0.1:${address.port}`;
}

function jsonResponse(response: ServerResponse, status: number, value: Json) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closeHttpServer(server: Server, delayed: ReadonlyArray<ReturnType<typeof setTimeout>>) {
  for (const timer of delayed) clearTimeout(timer);
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
