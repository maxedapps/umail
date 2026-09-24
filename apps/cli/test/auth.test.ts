import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Json } from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  accessToken,
  login,
  logout,
  OAuthScheduler,
  type OAuthSchedulerService,
} from "../src/auth.ts";
import {
  credentialPath,
  makeCredentialStore,
  OAuthCredentialStore,
  OAuthCredentialStoreError,
  type OAuthCredentialState,
  type OAuthCredentialStoreService,
  registeredCredentialState,
} from "../src/credential-store.ts";

const ORIGIN = "https://umail.example.test";
const METADATA = {
  issuer: `${ORIGIN}/api/auth`,
  registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
  device_authorization_endpoint: `${ORIGIN}/api/auth/device/code`,
  token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
  revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
};

type CapturedRequest = { readonly method: string; readonly url: string; readonly body: string };
type ResponseFactory = (request: CapturedRequest, index: number) => Response;

function captureHttp(factory: ResponseFactory) {
  const requests: Array<CapturedRequest> = [];
  const httpClient = HttpClient.make((request, url) => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    const captured = { method: request.method, url: url.toString(), body };
    requests.push(captured);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, factory(captured, requests.length - 1)),
    );
  });
  return { httpClient, requests };
}
function json(value: Json, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function memoryStore(initial: OAuthCredentialState | null = null) {
  let current = initial;
  const writes: Array<OAuthCredentialState> = [];
  const service = {
    read: Effect.sync(() => current),
    commit: (expectedGeneration, state) =>
      Effect.sync(() => {
        const currentGeneration = current?.generation ?? 0;
        if (currentGeneration !== expectedGeneration) return "superseded";
        const next = { ...state, generation: expectedGeneration };
        current = next;
        writes.push(next);
        return "committed";
      }),
    takeLogoutSnapshot: (origin) =>
      Effect.sync(() => {
        if (current === null || current.origin !== origin) return null;
        const revocation =
          current.kind === "authorized"
            ? { clientId: current.clientId, refreshToken: current.refreshToken }
            : null;
        const next = {
          ...registeredCredentialState(current),
          generation: current.generation + 1,
        };
        current = next;
        writes.push(next);
        return revocation;
      }),
    withRefreshLock: (body) => body,
  } satisfies OAuthCredentialStoreService;
  return { service, writes, current: () => current };
}
function controlledScheduler(initial = 1_000) {
  let now = initial;
  const sleeps: Array<number> = [];
  const service = {
    now: Effect.sync(() => now),
    sleep: (milliseconds) =>
      Effect.sync(() => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }),
  } satisfies OAuthSchedulerService;
  return { service, sleeps };
}
function runAuth<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | OAuthCredentialStore | OAuthScheduler>,
  httpClient: HttpClient.HttpClient,
  store: OAuthCredentialStoreService,
  scheduler: OAuthSchedulerService,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(OAuthCredentialStore, store),
      Effect.provideService(OAuthScheduler, scheduler),
    ),
  );
}
function validState(overrides: Partial<OAuthCredentialState> = {}): OAuthCredentialState {
  return {
    version: 2,
    kind: "authorized",
    origin: ORIGIN,
    issuer: METADATA.issuer,
    resource: ORIGIN,
    scope: "umail:access offline_access",
    clientId: "umail-cli",
    accessToken: "initial-access-token",
    refreshToken: "initial-refresh-token",
    expiresAt: 3_600_000,
    generation: 0,
    ...overrides,
  };
}

const DEVICE = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: `${ORIGIN}/device`,
  verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 2,
};
const REGISTRATION = { client_id: "umail-cli", token_endpoint_auth_method: "none" };

describe("OAuth DCR and device login", () => {
  it("registers once, polls deterministically, and persists an authorized state", async () => {
    const store = memoryStore();
    const scheduler = controlledScheduler();
    const responses = [
      json(METADATA),
      json(REGISTRATION, 201),
      json(DEVICE),
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json({
        access_token: "approved",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 300,
        scope: "umail:access offline_access",
      }),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service);
    expect(scheduler.sleeps).toEqual([2_000, 2_000, 7_000]);
    expect(store.writes.map((state) => state.kind)).toEqual(["registered", "authorized"]);
    expect(store.current()).toMatchObject({
      kind: "authorized",
      clientId: "umail-cli",
      accessToken: "approved",
      generation: 0,
    });
    expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/.well-known/oauth-authorization-server/api/auth",
      "/api/auth/oauth2/register",
      "/api/auth/device/code",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/token",
    ]);
    expect(JSON.parse(http.requests[1]?.body ?? "{}")).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      resources: [ORIGIN],
    });
  });

  it("reuses a stored public registration without another DCR request", async () => {
    const registered = { ...validState(), kind: "registered" as const };
    const store = memoryStore(registered);
    const scheduler = controlledScheduler();
    const responses = [
      json(METADATA),
      json(DEVICE),
      json({
        access_token: "approved",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 300,
        scope: "umail:access offline_access",
      }),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service);
    expect(
      http.requests.some(
        (request) => new URL(request.url).pathname === "/api/auth/oauth2/register",
      ),
    ).toBe(false);
  });

  it("replaces a stale registration once after confirmed invalid_client", async () => {
    const stale = { ...validState(), kind: "registered" as const };
    const store = memoryStore(stale);
    const scheduler = controlledScheduler();
    const responses = [
      json(METADATA),
      json({ error: "invalid_client" }, 400),
      json({ client_id: "replacement-cli", token_endpoint_auth_method: "none" }, 201),
      json({ ...DEVICE, interval: 1 }),
      json({
        access_token: "approved",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 300,
        scope: "umail:access offline_access",
      }),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service);
    expect(
      http.requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/oauth2/register",
      ),
    ).toHaveLength(1);
    expect(store.current()).toMatchObject({ kind: "authorized", clientId: "replacement-cli" });
  });

  it("rejects cross-origin metadata before registration", async () => {
    const store = memoryStore();
    const scheduler = controlledScheduler();
    const http = captureHttp(() =>
      json({ ...METADATA, registration_endpoint: "https://attacker.invalid/register" }),
    );
    await expect(
      runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service),
    ).rejects.toThrow("invalid response");
    expect(store.writes).toEqual([]);
  });

  it("retains only registration when device approval is denied", async () => {
    const store = memoryStore();
    const scheduler = controlledScheduler();
    const responses = [
      json(METADATA),
      json(REGISTRATION, 201),
      json({ ...DEVICE, interval: 1 }),
      json({ error: "access_denied" }, 400),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await expect(
      runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service),
    ).rejects.toThrow("Device authorization was denied");
    expect(store.current()).toMatchObject({ kind: "registered", clientId: "umail-cli" });
  });
});

describe("OAuth refresh and logout", () => {
  it("returns an unexpired redacted access token without network access", async () => {
    const store = memoryStore(validState({ expiresAt: 1_000_000 }));
    const scheduler = controlledScheduler(10_000);
    const http = captureHttp(() => json({}, 500));
    const token = await runAuth(
      accessToken({ UMAIL_URL: ORIGIN }),
      http.httpClient,
      store.service,
      scheduler.service,
    );
    expect(Redacted.value(token)).toBe("initial-access-token");
    expect(http.requests).toEqual([]);
  });

  it.each([
    ["invalid_grant", "OAuth login required. Run: umail login"],
    ["invalid_client", "OAuth login required. Run: umail login"],
    ["invalid_request", "The OAuth server returned an invalid response."],
  ])("maps a %s refresh rejection to a clear error", async (error, message) => {
    const store = memoryStore(validState({ expiresAt: 1_001 }));
    const responses = [json(METADATA), json({ error }, 400)];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await expect(
      runAuth(
        accessToken({ UMAIL_URL: ORIGIN }),
        http.httpClient,
        store.service,
        controlledScheduler(1_000).service,
      ),
    ).rejects.toThrow(message);
    expect(store.writes).toEqual([]);
  });

  it("rotates and persists refresh tokens", async () => {
    const store = memoryStore(validState({ expiresAt: 1_001 }));
    const scheduler = controlledScheduler(1_000);
    const responses = [
      json(METADATA),
      json({
        access_token: "rotated",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 300,
      }),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    expect(
      Redacted.value(
        await runAuth(
          accessToken({ UMAIL_URL: ORIGIN }),
          http.httpClient,
          store.service,
          scheduler.service,
        ),
      ),
    ).toBe("rotated");
    expect(store.current()).toMatchObject({ kind: "authorized", refreshToken: "rotated-refresh" });
  });

  it("keeps the registration but clears tokens when remote revocation fails", async () => {
    const store = memoryStore(validState());
    const scheduler = controlledScheduler();
    const responses = [json(METADATA), json({ error: "server_error" }, 500)];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await runAuth(logout({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service);
    expect(store.current()).toEqual({
      version: 2,
      kind: "registered",
      origin: ORIGIN,
      issuer: METADATA.issuer,
      resource: ORIGIN,
      scope: "umail:access offline_access",
      clientId: "umail-cli",
      generation: 1,
    });
  });

  it("commits local logout and generation change before remote revocation", async () => {
    const store = memoryStore(validState({ generation: 4 }));
    const scheduler = controlledScheduler();
    const http = captureHttp((request) => {
      expect(store.current()).toMatchObject({ kind: "registered", generation: 5 });
      if (new URL(request.url).pathname.endsWith("/oauth-authorization-server/api/auth")) {
        return json(METADATA);
      }
      return new Response(null, { status: 200 });
    });
    await runAuth(logout({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service);
    expect(store.writes[0]).toMatchObject({ kind: "registered", generation: 5 });
    expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/.well-known/oauth-authorization-server/api/auth",
      "/api/auth/oauth2/revoke",
    ]);
    expect(http.requests[1]?.body).toContain("token=initial-refresh-token");
  });

  it("does not persist delayed login tokens after a generation change", async () => {
    const store = memoryStore({ ...validState(), kind: "registered" });
    const scheduler = controlledScheduler();
    const responses = [
      json(METADATA),
      json(DEVICE),
      json({
        access_token: "late-login",
        refresh_token: "late-refresh",
        token_type: "Bearer",
        expires_in: 300,
        scope: "umail:access offline_access",
      }),
    ];
    const http = captureHttp((request, index) => {
      if (new URL(request.url).pathname === "/api/auth/oauth2/token") {
        Effect.runSync(store.service.takeLogoutSnapshot(ORIGIN));
      }
      return responses[index] ?? json({}, 500);
    });
    await expect(
      runAuth(login({ UMAIL_URL: ORIGIN }), http.httpClient, store.service, scheduler.service),
    ).rejects.toThrow("replaced by another process");
    expect(store.current()).toMatchObject({ kind: "registered", generation: 1 });
    expect(store.current()).not.toMatchObject({ accessToken: "late-login" });
  });

  it("does not persist a delayed refresh after logout", async () => {
    const store = memoryStore(validState({ expiresAt: 1_001, generation: 2 }));
    const scheduler = controlledScheduler(1_000);
    const responses = [
      json(METADATA),
      json({
        access_token: "late-rotated",
        refresh_token: "late-rotated-refresh",
        token_type: "Bearer",
        expires_in: 300,
      }),
    ];
    const http = captureHttp((_request, index) => {
      if (index === 1) Effect.runSync(store.service.takeLogoutSnapshot(ORIGIN));
      return responses[index] ?? json({}, 500);
    });
    await expect(
      runAuth(
        accessToken({ UMAIL_URL: ORIGIN }),
        http.httpClient,
        store.service,
        scheduler.service,
      ),
    ).rejects.toThrow("OAuth login required");
    expect(store.current()).toMatchObject({ kind: "registered", generation: 3 });
    expect(store.current()).not.toMatchObject({ accessToken: "late-rotated" });
  });

  it("does not return a rotated token when atomic persistence fails", async () => {
    const initial = validState({ expiresAt: 1_001 });
    const store = {
      read: Effect.succeed(initial),
      commit: () => Effect.fail(new OAuthCredentialStoreError()),
      takeLogoutSnapshot: () => Effect.succeed(null),
      withRefreshLock: (body) => body,
    } satisfies OAuthCredentialStoreService;
    const scheduler = controlledScheduler(1_000);
    const responses = [
      json(METADATA),
      json({
        access_token: "unpersisted",
        refresh_token: "new",
        token_type: "Bearer",
        expires_in: 300,
      }),
    ];
    const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
    await expect(
      runAuth(accessToken({ UMAIL_URL: ORIGIN }), http.httpClient, store, scheduler.service),
    ).rejects.toThrow("OAuth credential file is missing or insecure");
  });
});

describe("POSIX OAuth credential store", () => {
  it("writes and reads an owner-only file atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umail-oauth-store-"));
    try {
      const store = makeCredentialStore({ XDG_STATE_HOME: directory });
      const state = validState();
      await Effect.runPromise(store.commit(state.generation, state));
      expect(await Effect.runPromise(store.read)).toEqual(state);
      expect(statSync(join(directory, "umail")).mode & 0o077).toBe(0);
      expect(statSync(credentialPath({ XDG_STATE_HOME: directory })).mode & 0o077).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["parent", "file"])("rejects a symlinked credential %s", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "umail-oauth-symlink-"));
    try {
      if (kind === "parent") {
        const target = join(directory, "target");
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, join(directory, "umail"));
      } else {
        const stateDirectory = join(directory, "umail");
        mkdirSync(stateDirectory, { mode: 0o700 });
        symlinkSync(join(directory, "missing"), join(stateDirectory, "oauth.json"));
      }
      await expect(
        Effect.runPromise(makeCredentialStore({ XDG_STATE_HOME: directory }).read),
      ).rejects.toThrow("OAuth credential file is missing or insecure");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("treats a missing generation field as generation 0", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umail-oauth-generation-"));
    try {
      const stateDirectory = join(directory, "umail");
      mkdirSync(stateDirectory, { mode: 0o700 });
      writeFileSync(
        join(stateDirectory, "oauth.json"),
        `${JSON.stringify({
          version: 2,
          kind: "authorized",
          origin: ORIGIN,
          issuer: METADATA.issuer,
          resource: ORIGIN,
          scope: "umail:access offline_access",
          clientId: "umail-cli",
          accessToken: "initial-access-token",
          refreshToken: "initial-refresh-token",
          expiresAt: 3_600_000,
        })}\n`,
        { mode: 0o600 },
      );
      const store = makeCredentialStore({ XDG_STATE_HOME: directory });
      expect(await Effect.runPromise(store.read)).toMatchObject({ generation: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
