import { createPrivateKey, sign as signBytes } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ExternalMailAddress } from "@umail/api-contract";

import { provisionAuth, type AuthD1Database } from "../../src/auth/provisioning.ts";
import { DISABLED_AUTH_PATHS, sameOriginReturnPath } from "../../src/auth/runtime-surface.ts";
import { issueMcpAccessToken, registerMcpClient } from "./oauth-flow.ts";
import {
  APPLICATION_ORIGIN,
  AUTH_SECRET,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  TEST_SITE,
  createWorld,
  listMcpPolicyRows,
  operatorCookieHeaders,
  type World,
} from "./world.ts";
import { mcpResourceUrl, restResourceUrl } from "../../src/auth/options.ts";

const CURSOR_CLOUD_CALLBACK = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_PRIVATE_USE = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_LOOPBACK_CALLBACK = "http://localhost:8787/callback";
const AccessTokenClaims = Schema.Struct({
  exp: Schema.Finite,
  iat: Schema.Finite,
  umail_operator: Schema.optionalKey(Schema.Boolean),
  sub: Schema.String,
  client_id: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});
const JwtHeader = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  typ: Schema.optionalKey(Schema.String),
});
const OkpPrivateJwk = Schema.Struct({
  kty: Schema.String,
  crv: Schema.String,
  d: Schema.String,
  x: Schema.String,
});
const RedirectResult = Schema.Struct({
  redirect: Schema.Boolean,
  url: Schema.optionalKey(Schema.String),
});
const DeviceCodes = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
});
const RegisteredClient = Schema.Struct({
  client_id: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
});

describe("runtime authentication surface", () => {
  it("authorizes mixed-case operator config through the stable operator id", async () => {
    const mixedCaseEmail = Schema.decodeSync(ExternalMailAddress)("Approver@example.com");
    const world = await createWorld({ operatorEmail: mixedCaseEmail });
    const claims = decodeAccessToken(world.operatorAccessToken);
    expect(claims.sub).toBe(world.operatorId);
    expect(claims.umail_operator).toBe(true);
    expect(
      (
        await world.fetch("http://umail.test/sending-identities", {
          headers: { authorization: `Bearer ${world.operatorAccessToken}` },
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a cryptographically signed JWT that is not an operator token", async () => {
    const world = await createWorld();
    const negative = await signAccessToken(world, { umail_operator: false });
    const response = await world.fetch("http://umail.test/sending-identities", {
      headers: { authorization: `Bearer ${negative}` },
    });
    expect(response.status).toBe(401);
    expect(await listMcpPolicyRows(world)).toEqual([]);
  });

  it("expires access JWTs within five minutes", async () => {
    const world = await createWorld();
    const claims = decodeAccessToken(world.operatorAccessToken);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(claims.exp * 1000).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });

  it("blocks exact disabled paths and parameterized reset, callback, and admin families", async () => {
    const world = await createWorld();
    const blocked = [
      "/api/auth/sign-up/email",
      "/api/auth/change-password",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password",
      "/api/auth/reset-password/reset-token-value",
      "/api/auth/change-email",
      "/api/auth/update-user",
      "/api/auth/delete-user",
      "/api/auth/delete-user/callback",
      "/api/auth/link-social",
      "/api/auth/unlink-account",
      "/api/auth/send-verification-email",
      "/api/auth/verify-email",
      "/api/auth/token",
      "/api/auth/callback/google",
      "/api/auth/admin/oauth2/create-client",
      "/api/auth/admin/oauth2/resources/https%3A%2F%2Fumail.test",
    ];
    for (const path of blocked) {
      const response = await world.fetch(`http://umail.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: world.sessionCookie },
        body: "{}",
      });
      expect(response.status, path).toBe(404);
    }
    expect(DISABLED_AUTH_PATHS.some((path) => path.includes(":"))).toBe(false);

    const allowed = await Promise.all([
      world.fetch("http://umail.test/api/auth/get-session", {
        headers: { cookie: world.sessionCookie },
      }),
      world.fetch("http://umail.test/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "still-allowed",
          application_type: "native",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: ["http://127.0.0.1/callback"],
          subject_type: "public",
        }),
      }),
    ]);
    expect(allowed[0]?.status).toBe(200);
    expect(allowed[1]?.status).toBe(201);
  });

  it("blocks runtime fixed-client management writes", async () => {
    const world = await createWorld();
    const writes = [
      "/api/auth/oauth2/create-client",
      "/api/auth/oauth2/update-client",
      "/api/auth/oauth2/delete-client",
      "/api/auth/oauth2/client/rotate-secret",
    ];
    const clientsBefore = await world.db.all("SELECT clientId FROM oauthClient");
    for (const path of writes) {
      const response = await world.fetch(`http://umail.test${path}`, {
        method: "POST",
        headers: operatorCookieHeaders(world.sessionCookie, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({ client_id: world.operatorClientId }),
      });
      expect(response.status, path).toBe(404);
    }
    expect(await world.db.all("SELECT clientId FROM oauthClient")).toEqual(clientsBefore);
  });

  it("completes signed OAuth continuation and ordinary /clients and /device returns", async () => {
    const world = await createWorld();
    const clients = await world.fetch("http://umail.test/clients", { redirect: "manual" });
    expect(clients.status).toBe(303);
    const login = new URL(clients.headers.get("location") ?? "", "http://umail.test");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe("/clients");
    expect(sameOriginReturnPath(login.searchParams.get("next"), APPLICATION_ORIGIN)).toBe(
      "/clients",
    );

    const signedIn = await world.fetch("http://umail.test/clients", {
      headers: { cookie: world.sessionCookie },
    });
    expect(signedIn.status).toBe(200);

    const registered = await registerMcpClient(world);
    const authorize = await world.fetch(
      `http://umail.test/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: registered.clientId,
        redirect_uri: registered.redirectUri,
        code_challenge: "0M6PxjaDZaOhF9Ovs2Aa2ZoJfrJ9DrYFrJTOFVfnfPg",
        code_challenge_method: "S256",
        state: "umail-continue-state",
        resource: "https://umail.test/mcp",
        scope: "umail:access offline_access",
      }).toString()}`,
      { redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const loginRedirect = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
    expect(loginRedirect.pathname).toBe("/login");
    expect(loginRedirect.searchParams.get("sig")).not.toBeNull();
    expect(loginRedirect.searchParams.getAll("ba_param").length).toBeGreaterThan(0);
    const continued = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email: OPERATOR_EMAIL,
        password: OPERATOR_PASSWORD,
        oauth_query: loginRedirect.search.slice(1),
      }),
    });
    expect(continued.status, await continued.clone().text()).toBe(200);
    const payload = Schema.decodeUnknownSync(RedirectResult)(await continued.json());
    expect(payload.redirect).toBe(true);
    expect(payload.url).toContain("/consent");
  });

  it("rejects unsigned next values stuffed into oauth_query and external return paths", async () => {
    const world = await createWorld();
    const stuffed = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email: OPERATOR_EMAIL,
        password: OPERATOR_PASSWORD,
        oauth_query: "next=/clients",
      }),
    });
    expect(stuffed.status).toBe(400);
    expect(sameOriginReturnPath("https://evil.example/clients", APPLICATION_ORIGIN)).toBeNull();
    expect(sameOriginReturnPath("//evil.example", APPLICATION_ORIGIN)).toBeNull();
    expect(sameOriginReturnPath("/\\evil.example", APPLICATION_ORIGIN)).toBeNull();
    expect(sameOriginReturnPath("/login", APPLICATION_ORIGIN)).toBeNull();
    expect(sameOriginReturnPath("/device?user_code=ABCD-EFGH", APPLICATION_ORIGIN)).toBe(
      "/device?user_code=ABCD-EFGH",
    );
  });

  it("rejects missing, null, mixed-case, and hostile origins without mutating device or policy state", async () => {
    const world = await createWorld();
    const registered = await registerMcpClient(world, { label: "origin probe" });
    await issueMcpAccessToken(world, registered);
    const device = await world.fetch("http://umail.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: world.operatorClientId,
        scope: "umail:access offline_access",
        resource: "https://umail.test",
      }).toString(),
    });
    const codes = Schema.decodeUnknownSync(DeviceCodes)(await device.json());
    const beforeDevice = await world.db.all("SELECT userCode, status FROM deviceCode");
    const beforePolicy = await listMcpPolicyRows(world);

    for (const origin of [null, "null", "https://attacker.example", "https://Umail.test"]) {
      const headers = new Headers({
        cookie: world.sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      });
      if (origin !== null) headers.set("origin", origin);
      const denied = await world.fetch("http://umail.test/device/approve", {
        method: "POST",
        headers,
        body: new URLSearchParams({ userCode: codes.user_code }).toString(),
      });
      expect(denied.status, String(origin)).toBe(403);
      const policy = await world.fetch(
        `http://umail.test/clients/${encodeURIComponent(registered.clientId)}/revoke`,
        { method: "POST", headers },
      );
      expect(policy.status, `revoke ${String(origin)}`).toBe(403);
    }

    expect(await world.db.all("SELECT userCode, status FROM deviceCode")).toEqual(beforeDevice);
    expect(await listMcpPolicyRows(world)).toEqual(beforePolicy);
  });

  it("accepts a same-origin document form POST that omits Origin", async () => {
    const world = await createWorld();
    const device = await world.fetch("http://umail.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: world.operatorClientId,
        scope: "umail:access offline_access",
        resource: "https://umail.test",
      }).toString(),
    });
    const codes = Schema.decodeUnknownSync(DeviceCodes)(await device.json());
    const approved = await world.fetch("http://umail.test/device/approve", {
      method: "POST",
      headers: {
        cookie: world.sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ userCode: codes.user_code }).toString(),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
  });

  it("registers an explicit native Cursor profile and rejects native registrations outside it", async () => {
    const world = await createWorld();
    const allowed = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "explicit native cursor",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_CLOUD_CALLBACK, CURSOR_LOOPBACK_CALLBACK, CURSOR_PRIVATE_USE],
      }),
    });
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    const registered = Schema.decodeUnknownSync(RegisteredClient)(await allowed.json());
    expect(registered.redirect_uris).toEqual([
      CURSOR_CLOUD_CALLBACK,
      CURSOR_LOOPBACK_CALLBACK,
      CURSOR_PRIVATE_USE,
    ]);

    const rejected = await world.fetch("http://umail.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "explicit native outside profile",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [CURSOR_PRIVATE_USE, "https://not-cursor.example/callback"],
      }),
    });
    expect(rejected.status).toBe(400);
    expect(
      await world.db.all(
        "SELECT clientId FROM oauthClient WHERE name = ?",
        "explicit native outside profile",
      ),
    ).toEqual([]);
  });

  it("does not expose a new session, code, or refresh token from a stale completion after rotation", async () => {
    const world = await createWorld();
    const registered = await registerMcpClient(world);
    const pending = await pendingAuthorizationCode(world, registered);
    const device = await world.fetch("http://umail.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: world.operatorClientId,
        scope: "umail:access offline_access",
        resource: "https://umail.test",
      }).toString(),
    });
    const codes = Schema.decodeUnknownSync(DeviceCodes)(await device.json());
    const previousRefresh = world.operatorRefreshToken;
    await rotateOperatorPassword(world, "replacement-passphrase");

    const staleSignIn = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
    });
    expect(staleSignIn.status).toBe(401);
    expect(staleSignIn.headers.get("set-cookie")).toBeNull();

    const staleSession = await world.fetch("http://umail.test/clients", {
      headers: { cookie: world.sessionCookie },
    });
    expect(staleSession.status).toBe(303);

    const staleCode = await world.fetch("http://umail.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: pending.code,
        redirect_uri: registered.redirectUri,
        client_id: registered.clientId,
        code_verifier: pending.verifier,
        resource: "https://umail.test/mcp",
      }).toString(),
    });
    expect(staleCode.status).toBe(400);

    const staleRefresh = await world.fetch("http://umail.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: previousRefresh,
        client_id: world.operatorClientId,
        resource: "https://umail.test",
      }).toString(),
    });
    expect(staleRefresh.status).toBe(400);

    const staleDevice = await world.fetch("http://umail.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codes.device_code,
        client_id: world.operatorClientId,
        resource: "https://umail.test",
      }).toString(),
    });
    expect(staleDevice.status).toBe(400);
  });
});

function decodeAccessToken(token: string) {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("access token is not a JWT");
  return Schema.decodeUnknownSync(AccessTokenClaims)(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
}

async function signAccessToken(world: World, claims: { readonly umail_operator: boolean }) {
  const original = decodeAccessToken(world.operatorAccessToken);
  const headerPart = world.operatorAccessToken.split(".")[0];
  if (headerPart === undefined) throw new Error("access token is not a JWT");
  const header = Schema.decodeUnknownSync(JwtHeader)(
    JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")),
  );
  const row = (await world.db.all("SELECT id, privateKey, alg FROM jwks"))[0];
  if (row === undefined || row.privateKey === null) throw new Error("jwks private key is missing");
  const decrypted = await symmetricDecrypt({
    key: AUTH_SECRET,
    data: JSON.parse(String(row.privateKey)),
  });
  const jwk = Schema.decodeUnknownSync(OkpPrivateJwk)(JSON.parse(decrypted));
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...original,
      umail_operator: claims.umail_operator,
    }),
  ).toString("base64url");
  const key = createPrivateKey({
    key: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x },
    format: "jwk",
  });
  const signature = signBytes(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key);
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function pendingAuthorizationCode(
  world: World,
  client: { readonly clientId: string; readonly redirectUri: string },
) {
  const verifier = "umail-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorize = await world.fetch(
    `http://umail.test/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "umail-stale-state",
      resource: "https://umail.test/mcp",
      scope: "umail:access offline_access",
    }).toString()}`,
    { redirect: "manual", headers: { cookie: world.sessionCookie } },
  );
  const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
  const callback = location.searchParams.has("code")
    ? location
    : await consentForCode(world, location, client.redirectUri);
  const code = callback.searchParams.get("code");
  if (code === null) throw new Error("authorization did not issue a code");
  return { code, verifier };
}

async function consentForCode(world: World, consentPage: URL, redirectUri: string): Promise<URL> {
  const consented = await world.fetch("http://umail.test/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: world.sessionCookie,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentPage.search.startsWith("?")
        ? consentPage.search.slice(1)
        : consentPage.searchParams.toString(),
      mailboxes: "all",
      sendMode: "requireApproval",
    }),
  });
  const consent = Schema.decodeUnknownSync(RedirectResult)(await consented.json());
  return new URL(consent.url ?? "", redirectUri);
}

async function rotateOperatorPassword(world: World, password: string): Promise<void> {
  await provisionAuth(world.db as AuthD1Database, {
    identity: { databaseId: "test-auth" },
    runNonce: crypto.randomUUID(),
    operatorEmail: world.operatorEmail,
    restResource: restResourceUrl(TEST_SITE),
    mcpResource: mcpResourceUrl(TEST_SITE),
    password,
  });
}
