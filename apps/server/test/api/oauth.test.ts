import { describe, expect, it } from "@effect/vitest";
import { UMAIL_OAUTH_SCOPE } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { verifyOAuthBearerToken } from "../../src/auth/oauth-resource.ts";
import { asUmailBetterAuth, type UmailBetterAuth } from "../../src/auth/options.ts";
import { issueMcpAccessToken, registerMcpClient } from "./oauth-flow.ts";
import {
  APPLICATION_ORIGIN,
  authorized,
  createWorld,
  listMcpPolicyRows,
  operatorCookieHeaders,
  readJson,
  readText,
  type World,
} from "./world.ts";

const RegisteredClient = Schema.Struct({
  client_id: Schema.String,
  grant_types: Schema.Array(Schema.String),
  response_types: Schema.Array(Schema.String),
  redirect_uris: Schema.Array(Schema.String),
});
const RegistrationFailure = Schema.Struct({
  error: Schema.String,
  error_description: Schema.String,
});
const DeviceCodes = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
});
const RefreshTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.String,
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CURSOR_CLOUD_CALLBACK = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_PRIVATE_USE = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_LOOPBACK_CALLBACK = "http://localhost:8787/callback";
const UNUSABLE_PRIVATE_USE = "vscode://ms.example/callback";

describe("OAuth-only operator and client lifecycle", () => {
  it.effect("requires a browser session for policy administration", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const clients = yield* world.request("http://umail.test/clients", { redirect: "manual" });
      expect(clients.status).toBe(303);
      expect(clients.headers.get("location")).toContain("/login?next=");
    }),
  );

  it.effect("publishes DCR and registers an inert public MCP client without a secret", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const metadata = yield* world.request(
        "http://umail.test/.well-known/oauth-authorization-server/api/auth",
      );
      const body = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
        yield* readJson(metadata),
      );
      expect(body.registration_endpoint).toBe("https://umail.test/api/auth/oauth2/register");

      const registered = yield* registerMcpClient(world);
      expect(registered.clientId).not.toBe("");
      expect(yield* listMcpPolicyRows(world)).toEqual([]);
      expect(
        yield* query(
          world,
          "SELECT clientSecret FROM oauthClient WHERE clientId = ?",
          registered.clientId,
        ),
      ).toEqual([{ clientSecret: null }]);
    }),
  );

  it.effect(
    "authorizes the static CLI client through Device Authorization for the REST resource",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const issued = yield* world.request("http://umail.test/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "umail-cli",
            scope: "umail:access offline_access",
            resource: "https://umail.test",
          }).toString(),
        });
        expect(issued.status, yield* readText(issued.clone())).toBe(200);
        const codes = yield* Schema.decodeUnknownEffect(DeviceCodes)(yield* readJson(issued));
        const review = yield* world.request(codes.verification_uri_complete, {
          headers: { cookie: world.sessionCookie },
        });
        expect(review.status).toBe(200);
        expect(yield* readText(review)).toContain(codes.user_code);
        const approved = yield* world.request("http://umail.test/device/approve", {
          method: "POST",
          headers: operatorCookieHeaders(world.sessionCookie, {
            "content-type": "application/x-www-form-urlencoded",
          }),
          body: new URLSearchParams({ userCode: codes.user_code }).toString(),
        });
        expect(approved.status).toBe(200);
      }),
  );

  it.effect("refuses dynamic registration of device-code clients and REST-resource clients", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const register = (body: Record<string, unknown>) =>
        world.request("http://umail.test/api/auth/oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: toJson({
            client_name: "Impostor CLI",
            application_type: "native",
            token_endpoint_auth_method: "none",
            subject_type: "public",
            dpop_bound_access_tokens: false,
            ...body,
          }),
        });
      const device = yield* register({
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        resources: ["https://umail.test"],
      });
      const rest = yield* register({
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: ["http://127.0.0.1/callback"],
        resources: ["https://umail.test"],
      });
      expect([device.status, rest.status]).toEqual([400, 400]);
      expect(
        yield* query(world, "SELECT clientId FROM oauthClient WHERE name = ?", "Impostor CLI"),
      ).toEqual([]);
    }),
  );

  it.effect(
    "rotates refresh tokens and recovers the replacement pair during the reuse window",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const refresh = () =>
          world.request("http://umail.test/api/auth/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: world.operatorRefreshToken,
              client_id: world.operatorClientId,
              resource: "https://umail.test",
            }).toString(),
          });
        const firstResponse = yield* refresh();
        expect(firstResponse.status, yield* readText(firstResponse.clone())).toBe(200);
        const first = yield* Schema.decodeUnknownEffect(RefreshTokens)(
          yield* readJson(firstResponse),
        );
        expect(first.refresh_token).not.toBe(world.operatorRefreshToken);
        const recoveryResponse = yield* refresh();
        expect(recoveryResponse.status, yield* readText(recoveryResponse.clone())).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(RefreshTokens)(yield* readJson(recoveryResponse)),
        ).toEqual(first);
      }),
  );

  it.effect("accepts only an operator-marked token with the exact REST audience", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      expect(
        (yield* world.request("http://umail.test/sending-identities", authorized(world))).status,
      ).toBe(200);
      const sessionValue = world.sessionCookie.split("=", 2)[1] ?? "";
      expect(
        (yield* world.request("http://umail.test/sending-identities", {
          headers: { authorization: `Bearer ${sessionValue}` },
        })).status,
      ).toBe(401);
      const mcpToken = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      expect(
        (yield* world.request("http://umail.test/sending-identities", {
          headers: { authorization: `Bearer ${mcpToken.access_token}` },
        })).status,
      ).toBe(401);
    }),
  );

  it.effect("reuses the fetched JWKS across per-request auth instances", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const first = countingJwks(world.auth);
      const second = countingJwks(world.auth);
      const requirements = {
        issuer: `${APPLICATION_ORIGIN}/api/auth`,
        audience: APPLICATION_ORIGIN,
        scopes: [UMAIL_OAUTH_SCOPE],
      };

      const firstAccess = yield* world.run(
        verifyOAuthBearerToken(
          { auth: Effect.succeed(first.auth) },
          world.operatorAccessToken,
          requirements,
        ),
      );
      const secondAccess = yield* world.run(
        verifyOAuthBearerToken(
          { auth: Effect.succeed(second.auth) },
          world.operatorAccessToken,
          requirements,
        ),
      );

      expect(firstAccess.subject).toBe(world.operatorId);
      expect(secondAccess.subject).toBe(world.operatorId);
      expect(first.calls()).toBe(1);
      expect(second.calls()).toBe(0);
    }),
  );

  it.effect("registers Cursor's MCP profile and honors its private-use callback", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "Cursor",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE],
        }),
      });
      expect(response.status, yield* readText(response.clone())).toBe(201);
      const registered = yield* Schema.decodeUnknownEffect(RegisteredClient)(
        yield* readJson(response),
      );
      expect(registered.redirect_uris).toEqual([
        CURSOR_CLOUD_CALLBACK,
        CURSOR_LOOPBACK_CALLBACK,
        CURSOR_PRIVATE_USE,
      ]);
      expect(
        yield* query(
          world,
          "SELECT applicationType FROM oauthClient WHERE clientId = ?",
          registered.client_id,
        ),
      ).toEqual([{ applicationType: "native" }]);

      for (const target of [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE]) {
        const authorize = yield* authorizeWith(world, registered.client_id, target);
        const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
        expect(location.pathname, target).toBe("/consent");
        expect(location.searchParams.get("redirect_uri")).toBe(target);
      }
    }),
  );

  it.effect("names the offending URI when an authorization redirect is unregistered", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const reg = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "Cursor",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE],
        }),
      });
      const client = yield* Schema.decodeUnknownEffect(RegisteredClient)(yield* readJson(reg));

      const mismatch = yield* authorizeWith(
        world,
        client.client_id,
        "https://elsewhere.example/cb",
      );
      const failure = new URL(mismatch.headers.get("location") ?? "", "http://umail.test");
      expect(failure.pathname).toBe("/api/auth/error");
      expect(failure.searchParams.get("error")).toBe("invalid_redirect");
      const description = failure.searchParams.get("error_description") ?? "";
      expect(description).toContain("https://elsewhere.example/cb");
      expect(description).toContain(CURSOR_CLOUD_CALLBACK);

      for (const target of [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE]) {
        const ok = yield* authorizeWith(world, client.client_id, target);
        expect(
          new URL(ok.headers.get("location") ?? "", "http://umail.test").pathname,
          target,
        ).toBe("/consent");
      }
      const nearMiss = yield* authorizeWith(
        world,
        client.client_id,
        "http://localhost:9999/callback",
      );
      expect(new URL(nearMiss.headers.get("location") ?? "", "http://umail.test").pathname).toBe(
        "/api/auth/error",
      );
    }),
  );

  it.effect("never registers a private-use callback from a look-alike authority", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const impostor = "cursor://attacker.cursor-mcp/oauth/callback";
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "look-alike",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: [CURSOR_CLOUD_CALLBACK, impostor],
        }),
      });
      expect(response.status, yield* readText(response.clone())).toBe(201);
      const registered = yield* Schema.decodeUnknownEffect(RegisteredClient)(
        yield* readJson(response),
      );
      expect(registered.redirect_uris).toEqual([CURSOR_CLOUD_CALLBACK]);

      const authorize = yield* authorizeWith(world, registered.client_id, impostor);
      const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
      expect(location.pathname).toBe("/api/auth/error");
      expect(location.searchParams.get("error")).toBe("invalid_redirect");
      expect(location.searchParams.has("code")).toBe(false);
    }),
  );

  it.effect("rejects Cursor's private-use callback outside its registration profile", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "profile mismatch",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: [CURSOR_PRIVATE_USE, "https://not-cursor.example/callback"],
        }),
      });
      expect(response.status).toBe(400);
      expect(
        yield* query(world, "SELECT clientId FROM oauthClient WHERE name = ?", "profile mismatch"),
      ).toEqual([]);
    }),
  );

  it.effect("drops a loopback callback a plain web client can never be redirected to", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "plain web",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: ["https://app.example.com/callback", "http://localhost:8787/callback"],
        }),
      });
      expect(response.status, yield* readText(response.clone())).toBe(201);
      const registered = yield* Schema.decodeUnknownEffect(RegisteredClient)(
        yield* readJson(response),
      );
      expect(registered.redirect_uris).toEqual(["https://app.example.com/callback"]);
      expect(
        yield* query(
          world,
          "SELECT applicationType FROM oauthClient WHERE clientId = ?",
          registered.client_id,
        ),
      ).toEqual([{ applicationType: "web" }]);
    }),
  );

  it.effect.each<readonly [string, Record<string, unknown>]>([
    ["authorization code", { grant_types: ["authorization_code"], response_types: ["code"] }],
    ["device", { grant_types: ["urn:ietf:params:oauth:grant-type:device_code"] }],
  ])("rejects a %s registration whose redirect URIs are all unusable", ([_name, grantOverride]) =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "unusable redirects",
          application_type: "native",
          token_endpoint_auth_method: "none",
          redirect_uris: [UNUSABLE_PRIVATE_USE, "not-a-url"],
          subject_type: "public",
          resources: ["https://umail.test"],
          ...grantOverride,
        }),
      });
      expect(response.status).toBe(400);
      const failure = yield* Schema.decodeUnknownEffect(RegistrationFailure)(
        yield* readJson(response),
      );
      expect(failure.error).toBe("invalid_redirect_uri");
      expect(failure.error_description).toContain(UNUSABLE_PRIVATE_USE);
      expect(
        yield* query(
          world,
          "SELECT clientId FROM oauthClient WHERE name = ?",
          "unusable redirects",
        ),
      ).toEqual([]);
    }),
  );

  it.effect("applies RFC 7591 defaults for omitted grant and response types", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const register = (body: {
        readonly client_name: string;
        readonly grant_types?: readonly string[];
      }) =>
        world.request("http://umail.test/api/auth/oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: toJson({
            application_type: "native",
            token_endpoint_auth_method: "none",
            redirect_uris: ["http://127.0.0.1/callback"],
            subject_type: "public",
            ...body,
          }),
        });

      const withoutResponseTypes = yield* register({
        client_name: "no response types",
        grant_types: ["authorization_code", "refresh_token"],
      });
      expect(withoutResponseTypes.status, yield* readText(withoutResponseTypes.clone())).toBe(201);
      expect(
        (yield* Schema.decodeUnknownEffect(RegisteredClient)(yield* readJson(withoutResponseTypes)))
          .response_types,
      ).toEqual(["code"]);

      const withoutGrantTypes = yield* register({ client_name: "no grant types" });
      expect(withoutGrantTypes.status, yield* readText(withoutGrantTypes.clone())).toBe(201);
      const defaulted = yield* Schema.decodeUnknownEffect(RegisteredClient)(
        yield* readJson(withoutGrantTypes),
      );
      expect(defaulted.grant_types).toEqual(["authorization_code"]);
      expect(defaulted.response_types).toEqual(["code"]);
      expect(
        yield* query(
          world,
          "SELECT grantTypes FROM oauthClient WHERE clientId = ?",
          defaulted.client_id,
        ),
      ).toEqual([{ grantTypes: toJson(["authorization_code"]) }]);
    }),
  );

  it.effect.each<readonly [string, Record<string, unknown>]>([
    ["confidential", { token_endpoint_auth_method: "client_secret_basic" }],
    ["client credentials", { grant_types: ["client_credentials"] }],
    [
      "mixed grants",
      { grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"] },
    ],
    ["DPoP-bound tokens", { dpop_bound_access_tokens: true }],
    ["server-assigned metadata", { client_id: "attacker-chosen-client" }],
    ["REST authorization-code resource", { resources: ["https://umail.test"] }],
  ])("rejects forbidden %s DCR capability without application policy", ([_name, override]) =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({
          client_name: "forbidden",
          application_type: "native",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: ["http://127.0.0.1/callback"],
          subject_type: "public",
          resources: ["https://umail.test/mcp"],
          ...override,
        }),
      });
      expect(response.status).toBe(400);
      expect(yield* listMcpPolicyRows(world)).toEqual([]);
    }),
  );

  it.effect(
    "isolates the DCR limit by Cloudflare client IP and ignores forwarded-header spoofing",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld({ rateLimit: true });
        const register = (clientIp: string, forwardedFor: string) =>
          world.request("http://umail.test/api/auth/oauth2/register", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "cf-connecting-ip": clientIp,
              "x-forwarded-for": forwardedFor,
            },
            body: toJson({
              client_name: "rate-limit probe",
              application_type: "native",
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              redirect_uris: ["http://127.0.0.1/callback"],
              subject_type: "public",
              dpop_bound_access_tokens: false,
            }),
          });

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = yield* register("203.0.113.25", "192.0.2.1, 203.0.113.25");
          expect(response.status, yield* readText(response.clone())).toBe(201);
        }
        // Changing an untrusted header must not reset this client's quota.
        const limited = yield* register("203.0.113.25", "192.0.2.99");
        expect(limited.status).toBe(429);
        const otherClient = yield* register("203.0.113.26", "192.0.2.1, 203.0.113.25");
        expect(otherClient.status, yield* readText(otherClient.clone())).toBe(201);
      }),
  );
});

// Mirrors alchemy building a fresh auth instance per request, and counts its JWKS fetches.
function countingJwks(auth: UmailBetterAuth) {
  let calls = 0;
  const counted = asUmailBetterAuth({
    ...auth,
    api: {
      ...auth.api,
      getJwks: () => {
        calls += 1;
        return auth.api.getJwks({});
      },
    },
  });
  return { auth: counted, calls: () => calls };
}

function authorizeWith(world: World, clientId: string, redirectUri: string) {
  return world.request(
    `http://umail.test/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: "umail-test-challenge-0123456789abcdefghijklmnopqrstuvw",
      code_challenge_method: "S256",
      state: "umail-test-state",
      resource: "https://umail.test/mcp",
      scope: "umail:access offline_access",
    }).toString()}`,
    { redirect: "manual", headers: { cookie: world.sessionCookie } },
  );
}

function query(world: World, sql: string, ...params: ReadonlyArray<string>) {
  return Effect.promise(() => world.db.all(sql, ...params));
}
