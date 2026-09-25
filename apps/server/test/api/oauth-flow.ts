import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

import { webCrypto } from "../../src/crypto.ts";
import { jsonBody, readJson, readText, type World } from "./world.ts";

const RedirectResult = Schema.Struct({
  redirect: Schema.Boolean,
  url: Schema.optionalKey(Schema.String),
});

// What the operator grants on the consent screen.
export type ConsentChoice = {
  readonly mailboxes?: string;
  readonly sendMode?: "deny" | "allow" | "requireApproval";
};

export const registerMcpClient = Effect.fn("registerMcpClient")(function* (
  world: World,
  input: { readonly label?: string; readonly redirectUri?: string } = {},
) {
  const redirectUri = input.redirectUri ?? "http://127.0.0.1/callback";
  const response = yield* world.request("http://umail.test/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody({
      client_name: input.label ?? "Test MCP",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [redirectUri],
      subject_type: "public",
      dpop_bound_access_tokens: false,
    }),
  });
  if (!response.ok) {
    return yield* Effect.die(`MCP DCR failed: ${response.status} ${yield* readText(response)}`);
  }
  const registered = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      client_id: Schema.String,
      token_endpoint_auth_method: Schema.Literal("none"),
      client_secret: Schema.optionalKey(Schema.Never),
    }),
  )(yield* readJson(response)).pipe(Effect.orDie);
  return { clientId: registered.client_id, redirectUri };
});

export const issueMcpAccessToken = Effect.fn("issueMcpAccessToken")(function* (
  world: World,
  client: { readonly clientId: string; readonly redirectUri: string },
  choice: ConsentChoice = {},
) {
  const verifier = "umail-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";
  const challenge = Encoding.encodeBase64Url(
    yield* webCrypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
  );
  const state = "umail-test-state";
  const authorize = yield* world.request(
    `http://umail.test/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: "https://umail.test/mcp",
      scope: "umail:access offline_access",
    }).toString()}`,
    { redirect: "manual", headers: { cookie: world.sessionCookie } },
  );
  if (![302, 303, 307].includes(authorize.status)) {
    return yield* Effect.die(
      `OAuth authorization failed: ${authorize.status} ${yield* readText(authorize)}`,
    );
  }
  const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
  const callback = location.searchParams.has("code")
    ? location
    : yield* grantConsent(world, location, client.redirectUri, choice);
  if (callback.searchParams.get("state") !== state) {
    return yield* Effect.die("OAuth callback state mismatch");
  }
  const code = callback.searchParams.get("code");
  if (code === null) return yield* Effect.die("OAuth authorization did not issue a code");
  const token = yield* world.request("http://umail.test/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: "https://umail.test/mcp",
    }).toString(),
  });
  if (!token.ok) {
    return yield* Effect.die(
      `OAuth token exchange failed: ${token.status} ${yield* readText(token)}`,
    );
  }
  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.optionalKey(Schema.String),
      token_type: Schema.String,
    }),
  )(yield* readJson(token)).pipe(Effect.orDie);
});

const grantConsent = Effect.fn("grantConsent")(function* (
  world: World,
  consentPage: URL,
  redirectUri: string,
  choice: ConsentChoice,
) {
  const oauthQuery = consentPage.search.startsWith("?")
    ? consentPage.search.slice(1)
    : consentPage.searchParams.toString();
  const consented = yield* world.request("http://umail.test/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: world.sessionCookie,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: jsonBody({
      accept: true,
      oauth_query: oauthQuery,
      mailboxes: choice.mailboxes ?? "all",
      sendMode: choice.sendMode ?? "requireApproval",
    }),
  });
  if (!consented.ok) {
    return yield* Effect.die(
      `OAuth consent failed: ${consented.status} ${yield* readText(consented)}`,
    );
  }
  const consent = yield* Schema.decodeUnknownEffect(RedirectResult)(
    yield* readJson(consented),
  ).pipe(Effect.orDie);
  return new URL(consent.url ?? "", redirectUri);
});
