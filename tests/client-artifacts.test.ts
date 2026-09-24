import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";

import { ApprovalDecisionState, MailThreadPage } from "../packages/api-contract/src/api-spec.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENTS_DIRECTORY = join(REPO_ROOT, "dist", "clients");
const CLI_ARTIFACT = "umail.mjs";
const NODE_SHEBANG = "#!/usr/bin/env node";
const BUILD_SENTINEL_URL = "https://umail-build-sentinel.invalid";
const TEST_ACCESS_TOKEN = "artifact-test-oauth-access-token";
const APPROVAL_TOKEN = "b".repeat(64);

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

interface FakeApiServer {
  readonly baseUrl: string;
  readonly requests: Array<CapturedApiRequest>;
  readonly close: () => Promise<void>;
}

interface CopiedProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CopiedArtifact {
  readonly directory: string;
  readonly path: string;
}

const openChildren: Array<ChildProcess> = [];
const openApiServers: Array<FakeApiServer> = [];
const temporaryDirectories: Array<string> = [];

afterEach(releaseOwnedResources);
afterAll(releaseOwnedResources);

beforeAll(() => {
  const build = spawnSync("pnpm", ["build:clients"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, UMAIL_URL: BUILD_SENTINEL_URL },
    timeout: 120_000,
  });
  expect(build.status, build.stderr || build.stdout).toBe(0);
}, 120_000);

async function releaseOwnedResources() {
  const children = openChildren.splice(0);
  const servers = openApiServers.splice(0);
  const directories = temporaryDirectories.splice(0);
  await Promise.all(children.map(closeChild));
  await Promise.all(servers.map((server) => server.close()));
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function closeChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

function jsonResponse(response: ServerResponse, status: number, value: Json) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function decodeHeader(value: string | ReadonlyArray<string> | undefined) {
  return Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String))(value);
}

function closeHttpServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

function startFakeApi(approvalBehavior: FakeApprovalBehavior = "redirect-denied") {
  return new Promise<FakeApiServer>((resolve, reject) => {
    const requests: Array<CapturedApiRequest> = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const rawUrl = Schema.decodeUnknownSync(Schema.String)(request.url);
        const captured = {
          method: Schema.decodeUnknownSync(Schema.String)(request.method),
          url: new URL(rawUrl, "http://127.0.0.1"),
          authorization: decodeHeader(request.headers.authorization),
          contentType: decodeHeader(request.headers["content-type"]),
        } satisfies CapturedApiRequest;
        requests.push(captured);
        if (captured.method === "GET" && captured.url.pathname === "/threads") {
          jsonResponse(response, 200, threadPage);
          return;
        }
        if (
          captured.method === "POST" &&
          captured.url.pathname === `/approvals/${APPROVAL_TOKEN}/approve`
        ) {
          if (approvalBehavior === "server-error") {
            jsonResponse(response, 500, { error: "approval failed" });
            return;
          }
          response.writeHead(303, {
            location: `/approvals/${APPROVAL_TOKEN}`,
            "x-umail-approval-state": "denied",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          response.end();
          return;
        }
        jsonResponse(response, 404, { error: "not found" });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const fake = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => closeHttpServer(server),
      } satisfies FakeApiServer;
      openApiServers.push(fake);
      resolve(fake);
    });
  });
}

function copyArtifactAlone(): CopiedArtifact {
  const directory = mkdtempSync(join(tmpdir(), "umail-artifact-"));
  temporaryDirectories.push(directory);
  const path = join(directory, CLI_ARTIFACT);
  copyFileSync(join(CLIENTS_DIRECTORY, CLI_ARTIFACT), path);
  return { directory, path };
}

function copiedAloneEnvironment(umail: { readonly UMAIL_URL?: string }, stateHome?: string) {
  const env = { ...process.env };
  delete env.UMAIL_URL;
  const url = umail.UMAIL_URL;
  if (url !== undefined) env.UMAIL_URL = url;
  if (stateHome !== undefined) env.XDG_STATE_HOME = stateHome;
  return env;
}

function writeCredentialState(stateHome: string, origin: string) {
  const directory = join(stateHome, "umail");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "oauth.json"),
    `${JSON.stringify({
      version: 2,
      kind: "authorized",
      origin,
      issuer: `${origin}/api/auth`,
      resource: origin,
      scope: "umail:access offline_access",
      clientId: "artifact-cli",
      accessToken: TEST_ACCESS_TOKEN,
      refreshToken: "artifact-test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    })}\n`,
    { mode: 0o600 },
  );
}

function runCopiedNode(
  scriptPath: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<CopiedProcessResult>((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    openChildren.push(child);
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("Expected piped stdio from copied artifact"));
      return;
    }
    const stdoutChunks: Array<string> = [];
    const stderrChunks: Array<string> = [];
    stdout.on("data", (chunk: string | Buffer) => stdoutChunks.push(chunk.toString()));
    stderr.on("data", (chunk: string | Buffer) => stderrChunks.push(chunk.toString()));
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") });
    });
  });
}

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

describe("standalone CLI artifact", { timeout: 30_000 }, () => {
  it("emits exactly one executable shebang file without embedding build configuration", () => {
    expect(readdirSync(CLIENTS_DIRECTORY)).toEqual([CLI_ARTIFACT]);
    const artifactPath = join(CLIENTS_DIRECTORY, CLI_ARTIFACT);
    const contents = readFileSync(artifactPath, "utf8");
    expect(contents.split("\n")[0]).toBe(NODE_SHEBANG);
    expect(contents).not.toContain(BUILD_SENTINEL_URL);
    expect(statSync(artifactPath).mode & 0o111).not.toBe(0);
  });

  it("prints help from a standalone copy", async () => {
    const copied = copyArtifactAlone();
    const result = await runCopiedNode(
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
  });

  it("fails safely without UMAIL_URL", async () => {
    const copied = copyArtifactAlone();
    const result = await runCopiedNode(
      copied.path,
      copied.directory,
      ["threads", "list"],
      copiedAloneEnvironment({}),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("UMAIL_URL is required");
    expect(result.stdout).toBe("");
    expectNoSecretLeakage(result);
  });

  it("uses the persisted OAuth access token for a REST command", async () => {
    const copied = copyArtifactAlone();
    const api = await startFakeApi();
    writeCredentialState(copied.directory, api.baseUrl);
    const result = await runCopiedNode(
      copied.path,
      copied.directory,
      ["threads", "list", "--limit", "2"],
      copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }, copied.directory),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Schema.decodeSync(Schema.fromJsonString(MailThreadPage))(result.stdout)).toEqual(
      threadPage,
    );
    expect(api.requests).toHaveLength(1);
    const request = requestAt(api.requests, 0);
    expect(request.method).toBe("GET");
    expect(`${request.url.pathname}${request.url.search}`).toBe("/threads?limit=2");
    expect(request.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(request.contentType).toBe("application/json");
    expectNoSecretLeakage(result);
  });

  it.effect("keeps public approval capability requests OAuth-independent", () =>
    Effect.gen(function* () {
      const copied = copyArtifactAlone();
      const tokenPath = join(copied.directory, "approval-token");
      writeFileSync(tokenPath, `${APPROVAL_TOKEN}\n`, { mode: 0o600 });
      const api = yield* Effect.promise(() => startFakeApi());
      const result = yield* Effect.promise(() =>
        runCopiedNode(
          copied.path,
          copied.directory,
          ["approvals", "approve", "--token-file", tokenPath],
          copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }),
        ),
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
  );

  it.effect("redacts public approval failures", () =>
    Effect.gen(function* () {
      const copied = copyArtifactAlone();
      const tokenPath = join(copied.directory, "approval-token");
      writeFileSync(tokenPath, `${APPROVAL_TOKEN}\n`, { mode: 0o600 });
      const api = yield* Effect.promise(() => startFakeApi("server-error"));
      const result = yield* Effect.promise(() =>
        runCopiedNode(
          copied.path,
          copied.directory,
          ["approvals", "approve", "--token-file", tokenPath],
          copiedAloneEnvironment({ UMAIL_URL: api.baseUrl }),
        ),
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Could not complete the approval request.\n");
      expectNoSecretLeakage(result, api.baseUrl);
    }),
  );
});
