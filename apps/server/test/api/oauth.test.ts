import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { verifyOAuthBearerToken } from "../../src/auth/oauth-resource.ts";
import {
  UMAIL_OAUTH_SCOPE,
  asUmailBetterAuth,
  type UmailBetterAuth,
} from "../../src/auth/options.ts";
import { issueMcpAccessToken, registerMcpClient } from "./oauth-flow.ts";
import {
  APPLICATION_ORIGIN,
  authorized,
  createWorld,
  listMcpPolicyRows,
  operatorCookieHeaders,
} from "./world.ts";

const DynamicClient = Schema.Struct({
  client_id: Schema.String,
  token_endpoint_auth_method: Schema.Literal("none"),
  client_secret: Schema.optionalKey(Schema.Never),
});
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

const CURSOR_CLOUD_CALLBACK = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_PRIVATE_USE = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_LOOPBACK_CALLBACK = "http://localhost:8787/callback";
const UNUSABLE_PRIVATE_USE = "vscode://ms.example/callback";

describe("OAuth-only operator and client lifecycle", () => {
  it("requires a browser session for policy administration", async () => {
    const world = await createWorld();
    const clients = await world.fetch("http://umail.test/clients", { redirect: "manual" });
    expect(clients.status).toBe(303);
    expect(clients.headers.get("location")).toContain("/login?next=");
  });

  it("publishes DCR and registers an inert public MCP client without a secret", async () => {
    const world = await createWorld();
    const metadata = await world.fetch(
      "http://umail.test/.well-known/oauth-authorization-server/api/auth",
    );
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      await metadata.json(),
    );
    expect(body.registration_endpoint).toBe("https://umail.test/api/auth/oauth2/register");

    const registered = await registerMcpClient(world);
    expect(registered.clientId).not.toBe("");
    expect(await listMcpPolicyRows(world)).toEqual([]);
    expect(
      await world.db.all(
        "SELECT clientSecret FROM oauthClient WHERE clientId = ?",
        registered.clientId,
      ),
    ).toEqual([{ clientSecret: null }]);
  });

  it("uses self-registered public Device Authorization with exact resource and scopes", async () => {
    const world = await createWorld();
    const registered = await registerDeviceClient(world);
    const issued = await world.fetch("http://umail.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registered.client_id,
        scope: "umail:access offline_access",
        resource: "https://umail.test",
      }).toString(),
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const codes = Schema.decodeUnknownSync(DeviceCodes)(await issued.json());
    const review = await world.fetch(codes.verification_uri_complete, {
      headers: { cookie: world.sessionCookie },
    });
    expect(review.status).toBe(200);
    expect(await review.text()).toContain(codes.user_code);
    const approved = await world.fetch("http://umail.test/device/approve", {
      method: "POST",
      headers: operatorCookieHeaders(world.sessionCookie, {
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: new URLSearchParams({ userCode: codes.user_code }).toString(),
    });
    expect(approved.status).toBe(200);
  });

  it("rotates refresh tokens and recovers the replacement pair during the reuse window", async () => {
    const world = await createWorld();
    const refresh = () =>
      world.fetch("http://umail.test/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: world.operatorRefreshToken,
          client_id: world.operatorClientId,
          resource: "https://umail.test",
        }).toString(),
      });
    const firstResponse = await refresh();
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = Schema.decodeUnknownSync(RefreshTokens)(await firstResponse.json());
    expect(first.refresh_token).not.toBe(world.operatorRefreshToken);
    const recoveryResponse = await refresh();
    expect(recoveryResponse.status, await recoveryResponse.clone().text()).toBe(200);
    expect(Schema.decodeUnknownSync(RefreshTokens)(await recoveryResponse.json())).toEqual(first);
  });

  it("accepts only an operator-marked token with the exact REST audience", async () => {
    const world = await createWorld();
    expect(
      (await world.fetch("http://umail.test/sending-identities", authorized(world))).status,
    ).toBe(200);
    const sessionValue = world.sessionCookie.split("=", 2)[1] ?? "";
    expect(
      (
        await world.fetch("http://umail.test/sending-identities", {
          headers: { authorization: `Bearer ${sessionValue}` },
        })
      ).status,
    ).toBe(401);
    const mcpToken = await issueMcpAccessToken(world, await registerMcpClient(world));
    expect(
      (
        await world.fetch("http://umail.test/sending-identities", {
          headers: { authorization: `Bearer ${mcpToken.access_token}` },
        })
      ).status,
    ).toBe(401);
  });

  it("reuses the fetched JWKS across per-request auth instances", async () => {
    const world = await createWorld();
    const first = countingJwks(world.auth);
    const second = countingJwks(world.auth);
    const requirements = {
      issuer: `${APPLICATION_ORIGIN}/api/auth`,
      audience: APPLICATION_ORIGIN,
      scopes: [UMAIL_OAUTH_SCOPE],
    };

    const firstAccess = await verifyOAuthBearerToken(
      first.auth,
      world.operatorAccessToken,
      requirements,
    );
    const secondAccess = await verifyOAuthBearerToken(
      second.auth,
      world.operatorAccessToken,
      requirements,
    );

    expect(firstAccess.subject).toBe(world.operatorId);
    expect(secondAccess.subject).toBe(world.operatorId);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
  });

  it("registers Cursor's MCP profile and honors its private-use callback", async () => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Cursor",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const registered = Schema.decodeUnknownSync(RegisteredClient)(await response.json());
    expect(registered.redirect_uris).toEqual([
      CURSOR_CLOUD_CALLBACK,
      CURSOR_LOOPBACK_CALLBACK,
      CURSOR_PRIVATE_USE,
    ]);
    expect(
      await world.db.all(
        "SELECT applicationType FROM oauthClient WHERE clientId = ?",
        registered.client_id,
      ),
    ).toEqual([{ applicationType: "native" }]);

    for (const target of [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE]) {
      const authorize = await authorizeWith(world, registered.client_id, target);
      const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
      expect(location.pathname, target).toBe("/consent");
      expect(location.searchParams.get("redirect_uri")).toBe(target);
    }
  });

  it("names the offending URI when an authorization redirect is unregistered", async () => {
    const world = await createWorld();
    const reg = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Cursor",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE],
      }),
    });
    const client = Schema.decodeUnknownSync(RegisteredClient)(await reg.json());

    const mismatch = await authorizeWith(world, client.client_id, "https://elsewhere.example/cb");
    const failure = new URL(mismatch.headers.get("location") ?? "", "http://umail.test");
    expect(failure.pathname).toBe("/api/auth/error");
    expect(failure.searchParams.get("error")).toBe("invalid_redirect");
    const description = failure.searchParams.get("error_description") ?? "";
    expect(description).toContain("https://elsewhere.example/cb");
    expect(description).toContain(CURSOR_CLOUD_CALLBACK);

    for (const target of [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE]) {
      const ok = await authorizeWith(world, client.client_id, target);
      expect(new URL(ok.headers.get("location") ?? "", "http://umail.test").pathname, target).toBe(
        "/consent",
      );
    }
    const nearMiss = await authorizeWith(world, client.client_id, "http://localhost:9999/callback");
    expect(new URL(nearMiss.headers.get("location") ?? "", "http://umail.test").pathname).toBe(
      "/api/auth/error",
    );
  });

  it("never registers a private-use callback from a look-alike authority", async () => {
    const world = await createWorld();
    const impostor = "cursor://attacker.cursor-mcp/oauth/callback";
    const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "look-alike",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_CLOUD_CALLBACK, impostor],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const registered = Schema.decodeUnknownSync(RegisteredClient)(await response.json());
    expect(registered.redirect_uris).toEqual([CURSOR_CLOUD_CALLBACK]);

    const authorize = await authorizeWith(world, registered.client_id, impostor);
    const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
    expect(location.pathname).toBe("/api/auth/error");
    expect(location.searchParams.get("error")).toBe("invalid_redirect");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("rejects Cursor's private-use callback outside its registration profile", async () => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "profile mismatch",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_PRIVATE_USE, "https://not-cursor.example/callback"],
      }),
    });
    expect(response.status).toBe(400);
    expect(
      await world.db.all("SELECT clientId FROM oauthClient WHERE name = ?", "profile mismatch"),
    ).toEqual([]);
  });

  it("drops a loopback callback a plain web client can never be redirected to", async () => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "plain web",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: ["https://app.example.com/callback", "http://localhost:8787/callback"],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const registered = Schema.decodeUnknownSync(RegisteredClient)(await response.json());
    expect(registered.redirect_uris).toEqual(["https://app.example.com/callback"]);
    expect(
      await world.db.all(
        "SELECT applicationType FROM oauthClient WHERE clientId = ?",
        registered.client_id,
      ),
    ).toEqual([{ applicationType: "web" }]);
  });

  it.each([
    ["authorization code", { grant_types: ["authorization_code"], response_types: ["code"] }],
    ["device", { grant_types: ["urn:ietf:params:oauth:grant-type:device_code"] }],
  ])(
    "rejects a %s registration whose redirect URIs are all unusable",
    async (_name, grantOverride) => {
      const world = await createWorld();
      const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
      const failure = Schema.decodeUnknownSync(RegistrationFailure)(await response.json());
      expect(failure.error).toBe("invalid_redirect_uri");
      expect(failure.error_description).toContain(UNUSABLE_PRIVATE_USE);
      expect(
        await world.db.all("SELECT clientId FROM oauthClient WHERE name = ?", "unusable redirects"),
      ).toEqual([]);
    },
  );

  it("applies RFC 7591 defaults for omitted grant and response types", async () => {
    const world = await createWorld();
    const register = (body: {
      readonly client_name: string;
      readonly grant_types?: readonly string[];
    }) =>
      world.fetch("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application_type: "native",
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1/callback"],
          subject_type: "public",
          ...body,
        }),
      });

    const withoutResponseTypes = await register({
      client_name: "no response types",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(withoutResponseTypes.status, await withoutResponseTypes.clone().text()).toBe(201);
    expect(
      Schema.decodeUnknownSync(RegisteredClient)(await withoutResponseTypes.json()).response_types,
    ).toEqual(["code"]);

    const withoutGrantTypes = await register({ client_name: "no grant types" });
    expect(withoutGrantTypes.status, await withoutGrantTypes.clone().text()).toBe(201);
    const defaulted = Schema.decodeUnknownSync(RegisteredClient)(await withoutGrantTypes.json());
    expect(defaulted.grant_types).toEqual(["authorization_code"]);
    expect(defaulted.response_types).toEqual(["code"]);
    expect(
      await world.db.all(
        "SELECT grantTypes FROM oauthClient WHERE clientId = ?",
        defaulted.client_id,
      ),
    ).toEqual([{ grantTypes: JSON.stringify(["authorization_code"]) }]);
  });

  it.each([
    ["confidential", { token_endpoint_auth_method: "client_secret_basic" }],
    ["client credentials", { grant_types: ["client_credentials"] }],
    [
      "mixed grants",
      { grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"] },
    ],
    ["DPoP-bound tokens", { dpop_bound_access_tokens: true }],
    ["server-assigned metadata", { client_id: "attacker-chosen-client" }],
    ["REST authorization-code resource", { resources: ["https://umail.test"] }],
  ])("rejects forbidden %s DCR capability without application policy", async (_name, override) => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
    expect(await listMcpPolicyRows(world)).toEqual([]);
  });

  it("isolates the DCR limit by Cloudflare client IP and ignores forwarded-header spoofing", async () => {
    const world = await createWorld({ rateLimit: true });
    const register = (clientIp: string, forwardedFor: string) =>
      world.fetch("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": clientIp,
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({
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
      const response = await register("203.0.113.25", "192.0.2.1, 203.0.113.25");
      expect(response.status, await response.clone().text()).toBe(201);
    }
    // Changing an untrusted header must not reset this client's quota.
    const limited = await register("203.0.113.25", "192.0.2.99");
    expect(limited.status).toBe(429);
    const otherClient = await register("203.0.113.26", "192.0.2.1, 203.0.113.25");
    expect(otherClient.status, await otherClient.clone().text()).toBe(201);
  });
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

function authorizeWith(
  world: Awaited<ReturnType<typeof createWorld>>,
  clientId: string,
  redirectUri: string,
) {
  return world.fetch(
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

async function registerDeviceClient(world: Awaited<ReturnType<typeof createWorld>>) {
  const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "uMail CLI test",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      subject_type: "public",
      dpop_bound_access_tokens: false,
      resources: ["https://umail.test"],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return Schema.decodeUnknownSync(DynamicClient)(await response.json());
}
