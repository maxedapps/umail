import * as Schema from "effect/Schema";

import type { World } from "./world.ts";

const RedirectResult = Schema.Struct({
  redirect: Schema.Boolean,
  url: Schema.optionalKey(Schema.String),
});

// What the operator grants on the consent screen.
export type ConsentChoice = {
  readonly mailboxes?: string;
  readonly sendMode?: "deny" | "allow" | "requireApproval";
};

export async function registerMcpClient(
  world: World,
  input: { readonly label?: string; readonly redirectUri?: string } = {},
) {
  const redirectUri = input.redirectUri ?? "http://127.0.0.1/callback";
  const response = await world.fetch("http://umail.test/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
    throw new Error(`MCP DCR failed: ${response.status} ${await response.text()}`);
  }
  const registered = Schema.decodeUnknownSync(
    Schema.Struct({
      client_id: Schema.String,
      token_endpoint_auth_method: Schema.Literal("none"),
      client_secret: Schema.optionalKey(Schema.Never),
    }),
  )(await response.json());
  return { clientId: registered.client_id, redirectUri };
}

export async function issueMcpAccessToken(
  world: World,
  client: { readonly clientId: string; readonly redirectUri: string },
  choice: ConsentChoice = {},
) {
  const verifier = "umail-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const state = "umail-test-state";
  const authorize = await world.fetch(
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
    throw new Error(`OAuth authorization failed: ${authorize.status} ${await authorize.text()}`);
  }
  const location = new URL(authorize.headers.get("location") ?? "", "http://umail.test");
  const callback = location.searchParams.has("code")
    ? location
    : await grantConsent(world, location, client.redirectUri, choice);
  if (callback.searchParams.get("state") !== state) {
    throw new Error("OAuth callback state mismatch");
  }
  const code = callback.searchParams.get("code");
  if (code === null) throw new Error("OAuth authorization did not issue a code");
  const token = await world.fetch("http://umail.test/api/auth/oauth2/token", {
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
    throw new Error(`OAuth token exchange failed: ${token.status} ${await token.text()}`);
  }
  return Schema.decodeUnknownSync(
    Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.optionalKey(Schema.String),
      token_type: Schema.String,
    }),
  )(await token.json());
}

async function grantConsent(
  world: World,
  consentPage: URL,
  redirectUri: string,
  choice: ConsentChoice,
): Promise<URL> {
  const oauthQuery = consentPage.search.startsWith("?")
    ? consentPage.search.slice(1)
    : consentPage.searchParams.toString();
  const consented = await world.fetch("http://umail.test/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: world.sessionCookie,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      accept: true,
      oauth_query: oauthQuery,
      mailboxes: choice.mailboxes ?? "all",
      sendMode: choice.sendMode ?? "requireApproval",
    }),
  });
  if (!consented.ok) {
    throw new Error(`OAuth consent failed: ${consented.status} ${await consented.text()}`);
  }
  const consent = Schema.decodeUnknownSync(RedirectResult)(await consented.json());
  return new URL(consent.url ?? "", redirectUri);
}
