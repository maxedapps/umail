import { describe, expect, it } from "@effect/vitest";
import { RpcCallError } from "alchemy/Rpc";
import * as Effect from "effect/Effect";

import { createWorld, operatorCookieHeaders, readText } from "../api/world.ts";

describe("operator browser session", () => {
  it.effect("sends a signed-out console request to the login page and back", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/clients?saved", {
        redirect: "manual",
      });

      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "", "http://umail.test");
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe("/clients?saved");
    }),
  );

  it.effect("refuses a cross-site console POST before looking at the session", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/clients/some-client/revoke", {
        method: "POST",
        redirect: "manual",
        headers: { origin: "https://attacker.example" },
      });

      expect(response.status).toBe(403);
      expect(yield* readText(response)).toContain("sent from another site");
    }),
  );

  it.effect("ends the session on sign-out, so the next console request signs in again", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const signedIn = yield* world.request("http://umail.test/clients", {
        headers: { cookie: world.sessionCookie },
      });
      expect(signedIn.status).toBe(200);

      const signedOut = yield* world.request("http://umail.test/logout", {
        method: "POST",
        redirect: "manual",
        headers: operatorCookieHeaders(world.sessionCookie),
      });
      expect(signedOut.status).toBe(303);
      expect(signedOut.headers.get("location")).toBe("/login");
      expect(signedOut.headers.getSetCookie().join("\n")).toContain("Max-Age=0");

      const after = yield* world.request("http://umail.test/clients", {
        redirect: "manual",
        headers: { cookie: world.sessionCookie },
      });
      expect(after.status).toBe(303);
      expect(after.headers.get("location")).toContain("/login?next=");
    }),
  );

  it.effect("keeps Better Auth's routes to its own prefixes", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();

      for (const path of ["/api/auth", "/.well-known", "/api/authx", "/logout"]) {
        const response = yield* world.request(`http://umail.test${path}`);
        expect(response.status, path).toBe(404);
      }
      const metadata = yield* world.request(
        "http://umail.test/.well-known/oauth-authorization-server/api/auth",
      );
      expect(metadata.status).toBe(200);
    }),
  );

  it.effect("heads an error page with its status and shows the error's own message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/mail/threads/t-missing", {
        headers: { cookie: world.sessionCookie },
      });
      expect(response.status).toBe(404);
      const body = yield* readText(response);
      expect(body).toContain("<h1>Not found</h1>");
      expect(body).toContain("Thread t-missing was not found, or it is outside this client");
      expect(body).toContain('href="/mail">Back to Mail</a>');
    }),
  );

  it.effect("renders a 500 page, not a blank one, when a console page fails unexpectedly", () =>
    Effect.gen(function* () {
      const world = yield* createWorld({
        account: {
          listAddresses: () =>
            Effect.die(new RpcCallError({ method: "listAddresses", cause: new Error("DO reset") })),
        },
      });
      const response = yield* world.request("http://umail.test/mailboxes", {
        headers: { cookie: world.sessionCookie },
      });
      expect(response.status).toBe(500);
      const body = yield* readText(response);
      expect(body).toContain("<h1>Server error</h1>");
      expect(body).toContain(
        "AgentMail failed while handling this page. Reload to retry; the Worker logs have the details.",
      );
      expect(body).not.toContain("DO reset");
    }),
  );
});
