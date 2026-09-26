import { describe, expect, it } from "@effect/vitest";
import { Unavailable } from "@umail/api-contract";
import * as Effect from "effect/Effect";

import { createWorld, operatorCookieHeaders, readText, type World } from "../api/world.ts";

const page = Effect.fn("page")(function* (world: World, path: string) {
  const response = yield* world.request(`http://umail.test${path}`, {
    headers: { cookie: world.sessionCookie },
  });
  return yield* readText(response);
});

const post = Effect.fn("post")(function* (
  world: World,
  path: string,
  form: Record<string, string>,
) {
  return yield* world.request(`http://umail.test${path}`, {
    method: "POST",
    redirect: "manual",
    headers: operatorCookieHeaders(world.sessionCookie, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams(form).toString(),
  });
});

const createMailbox = Effect.fn("createMailbox")(function* (world: World, localPart: string) {
  const created = yield* post(world, "/mailboxes", { localPart, displayName: "Support" });
  expect(created.status).toBe(303);
  const path = (created.headers.get("location") ?? "").replace("?saved", "");
  expect(path).toMatch(/^\/mailboxes\/[^/]+$/u);
  return path;
});

describe("mailbox pages", () => {
  it.effect("creates a mailbox, lists it, and refuses the same address twice", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* createMailbox(world, "support");

      const list = yield* page(world, "/mailboxes");
      expect(list).toContain("support@umail.example.com");
      expect(list).toContain("Support");
      expect(list).toContain('<span class="badge success">Active</span>');
      expect(list).toContain("@umail.example.com</span>");

      const duplicate = yield* post(world, "/mailboxes", { localPart: "support" });
      const body = yield* readText(duplicate);
      expect(duplicate.status).toBe(400);
      expect(body).toContain("support@umail.example.com already exists.");
      expect(body).toContain('value="support"');
    }),
  );

  it.effect("deactivating a mailbox removes it from the compose From list", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const path = yield* createMailbox(world, "support");
      const id = path.split("/").at(-1) ?? "";
      expect(yield* page(world, "/mail/compose")).toContain(`value="${id}"`);

      const saved = yield* post(world, path, { displayName: "Support desk" });
      expect(saved.status).toBe(303);

      const detail = yield* page(world, `${path}?saved`);
      expect(detail).toContain('value="Support desk"');
      expect(detail).toContain('<span class="badge">Inactive</span>');
      expect(detail).toContain("Saved.");
      expect(yield* page(world, "/mail/compose")).not.toContain(`value="${id}"`);
    }),
  );

  it.effect("sets forwarding with its verification state and stops it again", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const path = yield* createMailbox(world, "support");

      const pending = yield* post(world, `${path}/forwarding`, { email: "me@example.net" });
      expect(pending.headers.get("location")).toBe(`${path}?forwarding=pending`);
      // Kept on the page, not in a toast that fades while the page claims mail is forwarded.
      const waiting = yield* page(world, `${path}?forwarding=pending`);
      expect(waiting).toMatch(
        /class="note warning" role="status">[^]*Waiting for verification — Cloudflare emailed\s+me@example\.net\./u,
      );
      expect(waiting).not.toContain('class="toast"');
      expect(waiting).not.toContain("Mail is also forwarded");

      world.destinations.verify("me@example.net");
      const verified = yield* post(world, `${path}/forwarding`, { email: "me@example.net" });
      expect(verified.headers.get("location")).toBe(`${path}?forwarding=verified`);

      const invalid = yield* post(world, `${path}/forwarding`, { email: "not an address" });
      expect(invalid.status).toBe(400);
      expect(yield* readText(invalid)).toContain("“not an address” is not an email address.");

      const removed = yield* post(world, `${path}/forwarding`, { remove: "1" });
      expect(removed.headers.get("location")).toBe(`${path}?forwarding=removed`);
      const addresses = yield* world.account.listAddresses();
      expect(addresses.find((address) => address.localPart === "support")?.forwardTo).toBeNull();
    }),
  );

  it.effect("explains a reserved name under the field, and a Cloudflare fault as a flash", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const reserved = yield* post(world, "/mailboxes", { localPart: "postmaster" });
      expect(reserved.status).toBe(400);
      const reservedBody = yield* readText(reserved);
      expect(reservedBody).toContain(
        "&quot;postmaster&quot; is reserved for mail-system use. Choose another name.",
      );
      expect(reservedBody).toContain('<p class="error" role="alert">');

      const path = yield* createMailbox(world, "support");
      world.destinations.failNext(
        new Unavailable({
          code: "cloudflare_misconfigured",
          message: "Cloudflare refused CF_EMAIL_ROUTING_TOKEN.",
        }),
      );
      const refused = yield* post(world, `${path}/forwarding`, { email: "me@example.net" });
      expect(refused.status).toBe(502);
      const refusedBody = yield* readText(refused);
      expect(refusedBody).toContain(
        "Forwarding was not changed. Cloudflare refused CF_EMAIL_ROUTING_TOKEN.",
      );
      // The address itself was fine, so the field is not marked.
      expect(refusedBody).not.toContain('<p class="error" role="alert">');
      expect(refusedBody).toContain('value="me@example.net"');
    }),
  );
});
