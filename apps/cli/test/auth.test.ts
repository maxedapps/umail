import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
  makeCredentialStore,
  OAuthCredentialStore,
  OAuthCredentialStoreError,
  type OAuthCredentials,
  type OAuthCredentialStoreService,
} from "../src/credential-store.ts";

const ORIGIN = "https://umail.example.test";
const METADATA = {
  issuer: `${ORIGIN}/api/auth`,
  device_authorization_endpoint: `${ORIGIN}/api/auth/device/code`,
  token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
  revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
};
const DEVICE = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: `${ORIGIN}/device`,
  verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 2,
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

// Records whether every write and removal happened while the lock was held.
function memoryStore(initial: OAuthCredentials | null = null) {
  let current = initial;
  let locked = false;
  const changes: Array<{ readonly kind: "write" | "remove"; readonly locked: boolean }> = [];
  const service = {
    read: Effect.sync(() => current),
    write: (credentials) =>
      Effect.sync(() => {
        current = credentials;
        changes.push({ kind: "write", locked });
      }),
    remove: Effect.sync(() => {
      current = null;
      changes.push({ kind: "remove", locked });
    }),
    withLock: (body) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          locked = true;
        }),
        () => body,
        () =>
          Effect.sync(() => {
            locked = false;
          }),
      ),
  } satisfies OAuthCredentialStoreService;
  return { service, changes, current: () => current };
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

function withAuth<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | OAuthCredentialStore | OAuthScheduler>,
  httpClient: HttpClient.HttpClient,
  store: OAuthCredentialStoreService,
  scheduler: OAuthSchedulerService,
) {
  return effect.pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(OAuthCredentialStore, store),
    Effect.provideService(OAuthScheduler, scheduler),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ UMAIL_URL: ORIGIN }),
    ),
  );
}

function validCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    origin: ORIGIN,
    scope: "umail:access offline_access",
    accessToken: "initial-access-token",
    refreshToken: "initial-refresh-token",
    expiresAt: 3_600_000,
    ...overrides,
  };
}

describe("OAuth device login", () => {
  it.effect("uses the static CLI client, polls deterministically, and writes under the lock", () =>
    Effect.gen(function* () {
      const store = memoryStore();
      const scheduler = controlledScheduler();
      const responses = [
        json(METADATA),
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
      yield* withAuth(login, http.httpClient, store.service, scheduler.service);
      expect(scheduler.sleeps).toEqual([2_000, 2_000, 7_000]);
      expect(store.changes).toEqual([{ kind: "write", locked: true }]);
      expect(store.current()).toEqual({
        origin: ORIGIN,
        scope: "umail:access offline_access",
        accessToken: "approved",
        refreshToken: "refresh",
        expiresAt: 1_000 + 11_000 + 300_000,
      });
      expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/.well-known/oauth-authorization-server/api/auth",
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
        "/api/auth/oauth2/token",
        "/api/auth/oauth2/token",
      ]);
      expect(new URLSearchParams(http.requests[1]?.body).get("client_id")).toBe("umail-cli");
    }),
  );

  it.effect("rejects cross-origin metadata before starting device authorization", () =>
    Effect.gen(function* () {
      const store = memoryStore();
      const http = captureHttp(() =>
        json({ ...METADATA, device_authorization_endpoint: "https://attacker.invalid/device" }),
      );
      const error = yield* Effect.flip(
        withAuth(login, http.httpClient, store.service, controlledScheduler().service),
      );
      expect(error.message).toContain("invalid response");
      expect(http.requests).toHaveLength(1);
      expect(store.changes).toEqual([]);
    }),
  );

  it.effect("stores nothing when device approval is denied", () =>
    Effect.gen(function* () {
      const store = memoryStore();
      const responses = [
        json(METADATA),
        json({ ...DEVICE, interval: 1 }),
        json({ error: "access_denied" }, 400),
      ];
      const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
      const error = yield* Effect.flip(
        withAuth(login, http.httpClient, store.service, controlledScheduler().service),
      );
      expect(error.message).toBe("Device authorization was denied.");
      expect(store.current()).toBeNull();
    }),
  );
});

describe("OAuth refresh and logout", () => {
  it.effect("returns an unexpired redacted access token without network access", () =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials({ expiresAt: 1_000_000 }));
      const http = captureHttp(() => json({}, 500));
      const token = yield* withAuth(
        accessToken,
        http.httpClient,
        store.service,
        controlledScheduler(10_000).service,
      );
      expect(Redacted.value(token)).toBe("initial-access-token");
      expect(http.requests).toEqual([]);
    }),
  );

  it.effect("asks for a login when the stored tokens belong to another origin", () =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials({ origin: "https://other.example.test" }));
      const error = yield* Effect.flip(
        withAuth(
          accessToken,
          captureHttp(() => json({}, 500)).httpClient,
          store.service,
          controlledScheduler().service,
        ),
      );
      expect(error.message).toBe("OAuth login required. Run: umail login");
    }),
  );

  it.effect.each([
    { error: "invalid_grant", message: "OAuth login required. Run: umail login" },
    { error: "invalid_client", message: "OAuth login required. Run: umail login" },
    { error: "invalid_request", message: "The OAuth server returned an invalid response." },
  ])("maps a $error refresh rejection to a clear error", ({ error, message }) =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials({ expiresAt: 1_001 }));
      const responses = [json(METADATA), json({ error }, 400)];
      const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
      const failure = yield* Effect.flip(
        withAuth(accessToken, http.httpClient, store.service, controlledScheduler(1_000).service),
      );
      expect(failure.message).toBe(message);
      expect(store.changes).toEqual([]);
    }),
  );

  it.effect("rotates and persists refresh tokens under the lock", () =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials({ expiresAt: 1_001 }));
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
      const token = yield* withAuth(
        accessToken,
        http.httpClient,
        store.service,
        controlledScheduler(1_000).service,
      );
      expect(Redacted.value(token)).toBe("rotated");
      expect(store.current()).toMatchObject({ refreshToken: "rotated-refresh" });
      expect(store.changes).toEqual([{ kind: "write", locked: true }]);
      expect(new URLSearchParams(http.requests[1]?.body).get("client_id")).toBe("umail-cli");
    }),
  );

  it.effect("does not return a rotated token when persisting it fails", () =>
    Effect.gen(function* () {
      const store = {
        ...memoryStore(validCredentials({ expiresAt: 1_001 })).service,
        write: () => Effect.fail(new OAuthCredentialStoreError()),
      } satisfies OAuthCredentialStoreService;
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
      const error = yield* Effect.flip(
        withAuth(accessToken, http.httpClient, store, controlledScheduler(1_000).service),
      );
      expect(error.message).toBe("The OAuth credential file is missing or insecure.");
    }),
  );

  it.effect("keeps the local tokens and fails when remote revocation fails", () =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials());
      const responses = [json(METADATA), json({ error: "server_error" }, 500)];
      const http = captureHttp((_request, index) => responses[index] ?? json({}, 500));
      const error = yield* Effect.flip(
        withAuth(logout, http.httpClient, store.service, controlledScheduler().service),
      );
      expect(error.message).toContain("local OAuth credentials were kept");
      expect(store.current()).toEqual(validCredentials());
      expect(store.changes).toEqual([]);
    }),
  );

  it.effect("revokes on the server, then removes the local tokens under the lock", () =>
    Effect.gen(function* () {
      const store = memoryStore(validCredentials());
      const http = captureHttp((request) => {
        expect(store.current()).not.toBeNull();
        if (new URL(request.url).pathname.endsWith("/oauth-authorization-server/api/auth")) {
          return json(METADATA);
        }
        return new Response(null, { status: 200 });
      });
      yield* withAuth(logout, http.httpClient, store.service, controlledScheduler().service);
      expect(store.current()).toBeNull();
      expect(store.changes).toEqual([{ kind: "remove", locked: true }]);
      expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/.well-known/oauth-authorization-server/api/auth",
        "/api/auth/oauth2/revoke",
      ]);
      expect(http.requests[1]?.body).toContain("token=initial-refresh-token");
    }),
  );
});

layer(NodeServices.layer)("POSIX OAuth credential store", (it) => {
  const inTemporaryState = <A, E, R>(
    body: (stateHome: string, file: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateHome = yield* fs.makeTempDirectoryScoped({ prefix: "umail-oauth-" });
      return yield* body(stateHome, path.join(stateHome, "umail", "oauth.json"));
    });

  it.effect("writes and reads an owner-only file atomically", () =>
    inTemporaryState((stateHome, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* makeCredentialStore(file);
        yield* store.withLock(store.write(validCredentials()));
        expect(yield* store.read).toEqual(validCredentials());
        expect((yield* fs.stat(`${stateHome}/umail`)).mode & 0o077).toBe(0);
        expect((yield* fs.stat(file)).mode & 0o077).toBe(0);
        expect(yield* fs.readDirectory(`${stateHome}/umail`)).toEqual(["oauth.json"]);
        yield* store.withLock(store.remove);
        expect(yield* store.read).toBeNull();
      }),
    ),
  );

  it.effect("reads the tokens from a file an older CLI version wrote", () =>
    inTemporaryState((stateHome, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${stateHome}/umail`, { mode: 0o700 });
        yield* fs.writeFileString(
          file,
          `${JSON.stringify({
            version: 2,
            kind: "authorized",
            issuer: METADATA.issuer,
            resource: ORIGIN,
            clientId: "umail-cli",
            generation: 3,
            ...validCredentials(),
          })}\n`,
          { mode: 0o600 },
        );
        const store = yield* makeCredentialStore(file);
        expect(yield* store.read).toEqual(validCredentials());
      }),
    ),
  );

  it.effect.each(["parent", "file"])("rejects a symlinked credential %s", (kind) =>
    inTemporaryState((stateHome, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (kind === "parent") {
          yield* fs.makeDirectory(`${stateHome}/target`, { mode: 0o700 });
          yield* fs.writeFileString(`${stateHome}/target/oauth.json`, "{}", { mode: 0o600 });
          yield* fs.symlink(`${stateHome}/target`, `${stateHome}/umail`);
        } else {
          yield* fs.makeDirectory(`${stateHome}/umail`, { mode: 0o700 });
          yield* fs.symlink(`${stateHome}/missing`, file);
        }
        const store = yield* makeCredentialStore(file);
        const error = yield* Effect.flip(store.read);
        expect(error.message).toBe("The OAuth credential file is missing or insecure.");
      }),
    ),
  );
});
