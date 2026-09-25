import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CURSOR_CLOUD_CALLBACK_URI, CURSOR_GROK_BOT_CLIENT_ID } from "../../src/auth/options.ts";
import { connectedMcp } from "./mcp-drivers.ts";
import { issueMcpAccessToken } from "./oauth-flow.ts";
import {
  createWorld,
  listMcpPolicyRows,
  operatorCookieHeaders,
  readJson,
  readText,
  type World,
} from "./world.ts";

const STATIC_CLIENT = {
  clientId: CURSOR_GROK_BOT_CLIENT_ID,
  redirectUri: CURSOR_CLOUD_CALLBACK_URI,
} as const;

const MCP_TOOL_COUNT = 10;
const MCP_RESOURCE = "https://umail.test/mcp";

const Json = Schema.fromJsonString(Schema.Unknown);
const jsonText = Schema.encodeEffect(Json);
const RefreshedTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});

describe("first-party static OAuth client", () => {
  it.effect("completes authorize, consent, and token exchange without dynamic registration", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      expect(yield* listMcpPolicyRows(world)).toEqual([]);

      const token = yield* issueMcpAccessToken(world, STATIC_CLIENT);
      const client = yield* connectedMcp(world, token.access_token);
      expect((yield* Effect.promise(() => client.listTools())).tools).toHaveLength(MCP_TOOL_COUNT);

      expect(yield* staticClientRows(world)).toEqual({
        clients: [{ clientDiscoveryId: "umail-first-party" }],
        resources: [{ resourceId: "https://umail.test/mcp" }],
      });
      expect(yield* listMcpPolicyRows(world)).toHaveLength(1);
    }),
  );

  it.effect("records the scope chosen at consent and lists the client at once", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* issueMcpAccessToken(world, STATIC_CLIENT, { mailboxes: "box-1", sendMode: "deny" });
      const [row] = yield* listMcpPolicyRows(world);
      expect(yield* Schema.decodeUnknownEffect(Json)(row?.policy)).toEqual({
        mailboxIds: ["box-1"],
        canRead: true,
        sendMode: { kind: "deny" },
        recipientAllowlist: "any",
      });
      const clients = yield* world.request("http://umail.test/clients", {
        headers: { cookie: world.sessionCookie },
      });
      const html = yield* readText(clients);
      expect(html).toContain(CURSOR_GROK_BOT_CLIENT_ID);
      expect(html).toContain("1 mailbox · reads · no sending · any recipient");
      expect(html).toContain("umail-cli");
    }),
  );

  it.effect("rejects a consent without a valid policy and leaves no consent behind", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const consentPage = new URL(
        (yield* authorize(world, {})).headers.get("location") ?? "",
        "http://umail.test",
      );
      const consented = yield* world.request("http://umail.test/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          cookie: world.sessionCookie,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: yield* jsonText({
          accept: true,
          oauth_query: consentPage.search.slice(1),
          mailboxes: " , ",
          sendMode: "requireApproval",
        }),
      });
      expect(consented.status).toBe(400);
      // The consent script shows this message next to the form.
      expect(yield* readText(consented)).toContain("Choose at least one mailbox.");
      expect(yield* Effect.promise(() => world.db.all("SELECT id FROM oauthConsent"))).toEqual([]);
    }),
  );

  it.effect("gives a consent without a policy no MCP access", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const token = yield* issueMcpAccessToken(world, STATIC_CLIENT);
      yield* Effect.promise(() => world.db.exec("DELETE FROM mcpPolicy"));
      const response = yield* world.request("http://umail.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: yield* jsonText({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(403);
    }),
  );

  it.effect("revokes the static client but keeps its registration so it can reconnect", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* issueMcpAccessToken(world, STATIC_CLIENT);
      const revoked = yield* world.request(
        `http://umail.test/clients/${CURSOR_GROK_BOT_CLIENT_ID}/revoke`,
        { method: "POST", redirect: "manual", headers: operatorCookieHeaders(world.sessionCookie) },
      );
      expect(revoked.status).toBe(303);
      expect(yield* listMcpPolicyRows(world)).toEqual([]);
      expect((yield* staticClientRows(world)).clients).toHaveLength(1);
      // With the consent gone, authorizing asks for consent again.
      const again = new URL(
        (yield* authorize(world, {})).headers.get("location") ?? "",
        "http://umail.test",
      );
      expect(again.pathname).toBe("/consent");
      const token = yield* issueMcpAccessToken(world, STATIC_CLIENT);
      const client = yield* connectedMcp(world, token.access_token);
      expect((yield* Effect.promise(() => client.listTools())).tools).toHaveLength(MCP_TOOL_COUNT);
    }),
  );

  it.effect("skips the consent page on re-authorization and persists the client exactly once", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* issueMcpAccessToken(world, STATIC_CLIENT);

      const reauthorize = yield* authorize(world, {});
      expect(reauthorize.status).toBe(302);
      const callback = new URL(reauthorize.headers.get("location") ?? "", "http://umail.test");
      expect(callback.origin + callback.pathname).toBe(CURSOR_CLOUD_CALLBACK_URI);
      expect(callback.searchParams.get("code")).not.toBeNull();

      const token = yield* issueMcpAccessToken(world, STATIC_CLIENT);
      const client = yield* connectedMcp(world, token.access_token);
      expect((yield* Effect.promise(() => client.listTools())).tools).toHaveLength(MCP_TOOL_COUNT);
      expect(yield* staticClientRows(world)).toEqual({
        clients: [{ clientDiscoveryId: "umail-first-party" }],
        resources: [{ resourceId: "https://umail.test/mcp" }],
      });
    }),
  );

  it.effect("rotates refresh tokens and keeps MCP access on the replacement token", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const issued = yield* issueMcpAccessToken(world, STATIC_CLIENT);
      expect(issued.refresh_token).toBeDefined();

      const refreshed = yield* world.request("http://umail.test/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token ?? "",
          client_id: CURSOR_GROK_BOT_CLIENT_ID,
          resource: MCP_RESOURCE,
        }).toString(),
      });
      expect(refreshed.status, yield* readText(refreshed.clone())).toBe(200);
      const rotated = yield* Schema.decodeUnknownEffect(RefreshedTokens)(
        yield* readJson(refreshed),
      );
      expect(rotated.refresh_token).not.toBe(issued.refresh_token);

      const client = yield* connectedMcp(world, rotated.access_token);
      expect((yield* Effect.promise(() => client.listTools())).tools).toHaveLength(MCP_TOOL_COUNT);
    }),
  );

  it.effect("rejects an unregistered redirect URI without leaking a code", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* authorize(world, {
        redirect_uri: "https://attacker.example/callback",
      });

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "", "http://umail.test");
      expect(location.origin).toBe("https://umail.test");
      expect(location.searchParams.get("error")).toBe("invalid_redirect");
      yield* expectNoClientSideEffects(world);
    }),
  );

  it.effect("rejects a resource the static client is not linked to", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* authorize(world, { resource: "https://umail.test" });

      expect(response.status).toBe(302);
      const callback = new URL(response.headers.get("location") ?? "", "http://umail.test");
      expect(callback.origin + callback.pathname).toBe(CURSOR_CLOUD_CALLBACK_URI);
      expect(callback.searchParams.get("error")).toBe("invalid_target");
      expect(callback.searchParams.get("code")).toBeNull();
      yield* expectNoClientSideEffects(world);
    }),
  );
});

function authorize(world: World, overrides: Record<string, string>) {
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
  return world.request(`http://umail.test/api/auth/oauth2/authorize?${query.toString()}`, {
    redirect: "manual",
    headers: { cookie: world.sessionCookie },
  });
}

const expectNoClientSideEffects = Effect.fn("expectNoClientSideEffects")(function* (world: World) {
  expect(yield* listMcpPolicyRows(world)).toEqual([]);
});

const staticClientRows = Effect.fn("staticClientRows")(function* (world: World) {
  return {
    clients: yield* Effect.promise(() =>
      world.db.all(
        "SELECT clientDiscoveryId FROM oauthClient WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ),
    resources: yield* Effect.promise(() =>
      world.db.all(
        "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
        CURSOR_GROK_BOT_CLIENT_ID,
      ),
    ),
  };
});
