import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { CURSOR_CLOUD_CALLBACK_URI, CURSOR_GROK_BOT_CLIENT_ID } from "../../src/auth/options.ts";
import { connectedMcp } from "./mcp-drivers.ts";
import { issueMcpAccessToken } from "./oauth-flow.ts";
import { createWorld, listMcpPolicyRows, operatorCookieHeaders, type World } from "./world.ts";

const STATIC_CLIENT = {
  clientId: CURSOR_GROK_BOT_CLIENT_ID,
  redirectUri: CURSOR_CLOUD_CALLBACK_URI,
} as const;

const MCP_TOOL_COUNT = 10;
const MCP_RESOURCE = "https://umail.test/mcp";

const RefreshedTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});

describe("first-party static OAuth client", () => {
  it("completes authorize, consent, and token exchange without dynamic registration", async () => {
    const world = await createWorld();
    expect(await listMcpPolicyRows(world)).toEqual([]);

    const token = await issueMcpAccessToken(world, STATIC_CLIENT);
    const client = await connectedMcp(world, token.access_token);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_COUNT);
    } finally {
      await client.close();
    }

    expect(await staticClientRows(world)).toEqual({
      clients: [{ clientDiscoveryId: "umail-first-party" }],
      resources: [{ resourceId: "https://umail.test/mcp" }],
    });
    expect(await listMcpPolicyRows(world)).toHaveLength(1);
  });

  it("records the scope chosen at consent and lists the client at once", async () => {
    const world = await createWorld();
    await issueMcpAccessToken(world, STATIC_CLIENT, { mailboxes: "box-1", sendMode: "deny" });
    const [row] = await listMcpPolicyRows(world);
    expect(JSON.parse(String(row?.policy))).toEqual({
      mailboxIds: ["box-1"],
      canRead: true,
      sendMode: { kind: "deny" },
      recipientAllowlist: "any",
    });
    const clients = await world.fetch("http://umail.test/clients", {
      headers: { cookie: world.sessionCookie },
    });
    const html = await clients.text();
    expect(html).toContain(CURSOR_GROK_BOT_CLIENT_ID);
    expect(html).toContain('value="box-1"');
    expect(html).toContain("umail-cli");
  });

  it("rejects a consent without a valid policy and leaves no consent behind", async () => {
    const world = await createWorld();
    const consentPage = new URL(
      (await authorize(world, {})).headers.get("location") ?? "",
      "http://umail.test",
    );
    const consented = await world.fetch("http://umail.test/api/auth/oauth2/consent", {
      method: "POST",
      headers: {
        cookie: world.sessionCookie,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentPage.search.slice(1),
        mailboxes: " , ",
        sendMode: "requireApproval",
      }),
    });
    expect(consented.status).toBe(400);
    expect(await world.db.all("SELECT id FROM oauthConsent")).toEqual([]);
  });

  it("gives a consent without a policy no MCP access", async () => {
    const world = await createWorld();
    const token = await issueMcpAccessToken(world, STATIC_CLIENT);
    await world.db.exec("DELETE FROM mcpPolicy");
    const response = await world.fetch("http://umail.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  });

  it("revokes the static client but keeps its registration so it can reconnect", async () => {
    const world = await createWorld();
    await issueMcpAccessToken(world, STATIC_CLIENT);
    const revoked = await world.fetch(
      `http://umail.test/clients/${CURSOR_GROK_BOT_CLIENT_ID}/revoke`,
      { method: "POST", redirect: "manual", headers: operatorCookieHeaders(world.sessionCookie) },
    );
    expect(revoked.status).toBe(303);
    expect(await listMcpPolicyRows(world)).toEqual([]);
    expect((await staticClientRows(world)).clients).toHaveLength(1);
    // With the consent gone, authorizing asks for consent again.
    const again = new URL(
      (await authorize(world, {})).headers.get("location") ?? "",
      "http://umail.test",
    );
    expect(again.pathname).toBe("/consent");
    const token = await issueMcpAccessToken(world, STATIC_CLIENT);
    const client = await connectedMcp(world, token.access_token);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_COUNT);
    } finally {
      await client.close();
    }
  });

  it("skips the consent page on re-authorization and persists the client exactly once", async () => {
    const world = await createWorld();
    await issueMcpAccessToken(world, STATIC_CLIENT);

    const reauthorize = await authorize(world, {});
    expect(reauthorize.status).toBe(302);
    const callback = new URL(reauthorize.headers.get("location") ?? "", "http://umail.test");
    expect(callback.origin + callback.pathname).toBe(CURSOR_CLOUD_CALLBACK_URI);
    expect(callback.searchParams.get("code")).not.toBeNull();

    const token = await issueMcpAccessToken(world, STATIC_CLIENT);
    const client = await connectedMcp(world, token.access_token);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_COUNT);
    } finally {
      await client.close();
    }
    expect(await staticClientRows(world)).toEqual({
      clients: [{ clientDiscoveryId: "umail-first-party" }],
      resources: [{ resourceId: "https://umail.test/mcp" }],
    });
  });

  it("rotates refresh tokens and keeps MCP access on the replacement token", async () => {
    const world = await createWorld();
    const issued = await issueMcpAccessToken(world, STATIC_CLIENT);
    expect(issued.refresh_token).toBeDefined();

    const refreshed = await world.fetch("http://umail.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token ?? "",
        client_id: CURSOR_GROK_BOT_CLIENT_ID,
        resource: MCP_RESOURCE,
      }).toString(),
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const rotated = Schema.decodeUnknownSync(RefreshedTokens)(await refreshed.json());
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);

    const client = await connectedMcp(world, rotated.access_token);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_COUNT);
    } finally {
      await client.close();
    }
  });

  it("rejects an unregistered redirect URI without leaking a code", async () => {
    const world = await createWorld();
    const response = await authorize(world, { redirect_uri: "https://attacker.example/callback" });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", "http://umail.test");
    expect(location.origin).toBe("https://umail.test");
    expect(location.searchParams.get("error")).toBe("invalid_redirect");
    await expectNoClientSideEffects(world);
  });

  it("rejects a resource the static client is not linked to", async () => {
    const world = await createWorld();
    const response = await authorize(world, { resource: "https://umail.test" });

    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location") ?? "", "http://umail.test");
    expect(callback.origin + callback.pathname).toBe(CURSOR_CLOUD_CALLBACK_URI);
    expect(callback.searchParams.get("error")).toBe("invalid_target");
    expect(callback.searchParams.get("code")).toBeNull();
    await expectNoClientSideEffects(world);
  });
});

function authorize(world: World, overrides: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CURSOR_GROK_BOT_CLIENT_ID,
    redirect_uri: CURSOR_CLOUD_CALLBACK_URI,
    code_challenge: "0M6PxjaDZaOhF9Ovs2Aa2ZoJfrJ9DrYFrJTOFVfnfPg",
    code_challenge_method: "S256",
    state: "umail-static-state",
    resource: MCP_RESOURCE,
    scope: "umail:access offline_access",
    ...overrides,
  });
  return world.fetch(`http://umail.test/api/auth/oauth2/authorize?${query.toString()}`, {
    redirect: "manual",
    headers: { cookie: world.sessionCookie },
  });
}

async function expectNoClientSideEffects(world: World): Promise<void> {
  expect(await listMcpPolicyRows(world)).toEqual([]);
}

async function staticClientRows(world: World) {
  return {
    clients: await world.db.all(
      "SELECT clientDiscoveryId FROM oauthClient WHERE clientId = ?",
      CURSOR_GROK_BOT_CLIENT_ID,
    ),
    resources: await world.db.all(
      "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
      CURSOR_GROK_BOT_CLIENT_ID,
    ),
  };
}
