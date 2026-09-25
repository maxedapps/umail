import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { issueMcpAccessToken, registerMcpClient } from "../api/oauth-flow.ts";
import {
  createWorld,
  listMcpPolicyRows,
  operatorCookieHeaders,
  readText,
  seedMailbox,
  type World,
} from "../api/world.ts";

const StoredPolicy = Schema.fromJsonString(Schema.Unknown);

const page = Effect.fn("page")(function* (world: World, path: string) {
  const response = yield* world.request(`http://umail.test${path}`, {
    headers: { cookie: world.sessionCookie },
  });
  return { status: response.status, body: yield* readText(response) };
});

const post = Effect.fn("post")(function* (world: World, path: string, form: URLSearchParams) {
  return yield* world.request(`http://umail.test${path}`, {
    method: "POST",
    redirect: "manual",
    headers: operatorCookieHeaders(world.sessionCookie, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: form.toString(),
  });
});

const connectedClient = Effect.fn("connectedClient")(function* (world: World) {
  const client = yield* registerMcpClient(world, { label: "Claude <Code>" });
  yield* issueMcpAccessToken(world, client);
  return client;
});

describe("clients pages", () => {
  it.effect("lists each client with its name, kind and a one-line summary", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* connectedClient(world);

      const { status, body } = yield* page(world, "/clients");

      expect(status).toBe(200);
      expect(body).toContain("Claude &lt;Code&gt;");
      expect(body).toContain('<span class="badge">Agent</span>');
      expect(body).toContain("All mailboxes · reads · sends with approval · any recipient");
      expect(body).toContain("Operator CLI");
      expect(body).toContain('href="/clients/umail-cli"');
    }),
  );

  it.effect("saves the checked mailboxes as the client's mailbox scope", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      const client = yield* connectedClient(world);
      const path = `/clients/${encodeURIComponent(client.clientId)}`;

      const detail = yield* page(world, path);
      expect(detail.body).toContain(`value="${inbox.id}"`);

      const form = new URLSearchParams({
        mailboxScope: "some",
        sendMode: "deny",
        canRead: "on",
        recipientScope: "any",
      });
      form.append("mailbox", inbox.id);
      form.append("mailbox", probe.id);
      const saved = yield* post(world, path, form);

      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe(`${path}?saved`);
      const [row] = yield* listMcpPolicyRows(world);
      expect(yield* Schema.decodeUnknownEffect(StoredPolicy)(row?.policy)).toEqual({
        mailboxIds: [inbox.id, probe.id],
        canRead: true,
        sendMode: { kind: "deny" },
        recipientAllowlist: "any",
      });
      expect((yield* page(world, `${path}?saved`)).body).toContain("Access saved.");
    }),
  );

  it.effect("re-renders an invalid entry with its field error and the typed values", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const client = yield* connectedClient(world);
      const before = yield* listMcpPolicyRows(world);

      const response = yield* post(
        world,
        `/clients/${encodeURIComponent(client.clientId)}`,
        new URLSearchParams({
          mailboxScope: "all",
          sendMode: "requireApproval",
          preapproved: "boss@example.com, not an address",
          recipientScope: "some",
          recipients: "team@example.net",
        }),
      );
      const body = yield* readText(response);

      expect(response.status).toBe(400);
      expect(body).toContain("“not an address” is not an email address.");
      expect(body).toContain('value="boss@example.com, not an address"');
      expect(body).toContain('value="team@example.net"');
      expect(body).toMatch(/value="some"\s+checked/u);
      expect(yield* listMcpPolicyRows(world)).toEqual(before);
    }),
  );

  it.effect("revokes a client's consent from its page", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const client = yield* connectedClient(world);

      const detail = yield* page(world, `/clients/${encodeURIComponent(client.clientId)}`);
      expect(detail.body).toContain('popovertarget="revoke-dialog"');

      const revoked = yield* post(
        world,
        `/clients/${encodeURIComponent(client.clientId)}/revoke`,
        new URLSearchParams(),
      );
      expect(revoked.status).toBe(303);
      expect(revoked.headers.get("location")).toBe("/clients?revoked");
      expect(yield* Effect.promise(() => world.db.all("SELECT id FROM oauthConsent"))).toEqual([]);
      expect((yield* page(world, "/clients?revoked")).body).toContain("Access revoked.");
    }),
  );

  it.effect("renders consent with the client's name, the scope in words and real mailboxes", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const client = yield* registerMcpClient(world, { label: "Claude Code" });

      const { status, body } = yield* page(
        world,
        `/consent?${new URLSearchParams({
          client_id: client.clientId,
          scope: "umail:access offline_access",
          redirect_uri: "http://127.0.0.1:33418/callback",
        }).toString()}`,
      );

      expect(status).toBe(200);
      expect(body).toContain("Allow Claude Code to use AgentMail?");
      expect(body).toContain("Use your mailboxes · stay signed in");
      expect(body).toContain("http://127.0.0.1:33418");
      expect(body).toContain(`value="${inbox.id}"`);
      expect(body).toMatch(/value="requireApproval"\s+checked/u);
    }),
  );
});
