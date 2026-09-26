import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { cloudflareDestinations } from "../../src/api/destinations.ts";

const destinations = cloudflareDestinations({
  token: Redacted.make("token"),
  accountId: "account",
});

type Listed = { readonly id: string; readonly email: string; readonly verified: string | null };

// A Cloudflare account whose destination addresses come back one per page.
function cloudflare(listed: ReadonlyArray<Listed>, create?: () => Response) {
  const calls: Array<string> = [];
  const respond = Effect.fn("respond")(function* (request: Request) {
    const body: unknown =
      request.method === "POST" ? yield* Effect.promise(() => request.json()) : null;
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    expect(url.pathname).toBe("/client/v4/accounts/account/email/routing/addresses");
    expect(request.headers.get("authorization")).toBe("Bearer token");
    if (request.method === "POST") {
      return (
        create?.() ??
        envelope({
          id: "created",
          email: (body as { readonly email: string }).email,
          verified: null,
        })
      );
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const item = listed[page - 1];
    return envelope(item === undefined ? [] : [item], { page, per_page: 1 });
  });
  const fetch: typeof globalThis.fetch = (input, init) =>
    Effect.runPromise(respond(new Request(input, init)));
  return {
    calls,
    ensure: (email: string) =>
      destinations.ensure(email).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  };
}

describe("cloudflare forwarding destinations", () => {
  it.effect(
    "adopts an address listed under different case, past the first page, without creating it",
    () =>
      Effect.gen(function* () {
        const { calls, ensure } = cloudflare([
          { id: "other", email: "other@example.com", verified: null },
          { id: "forward", email: "Forward@Example.com", verified: "2026-01-01T00:00:00Z" },
        ]);

        expect(yield* ensure("forward@example.com")).toEqual({
          email: "Forward@Example.com",
          verified: true,
        });
        expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
      }),
  );

  it.effect("creates a missing destination, which stays unverified until its owner confirms", () =>
    Effect.gen(function* () {
      const { calls, ensure } = cloudflare([
        { id: "other", email: "other@example.com", verified: null },
      ]);

      expect(yield* ensure("new@example.com")).toEqual({
        email: "new@example.com",
        verified: false,
      });
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    }),
  );

  // Cloudflare's failure envelope for a create, with its HTTP status.
  const refusal = (status: number, code: number, message: string) => () =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

  it.effect.each([
    [
      "an address Cloudflare will not accept",
      refusal(400, 1004, "Address is not allowed"),
      { _tag: "InvalidRequest", code: "forwarding_rejected", message: "Address is not allowed" },
    ],
    [
      "a rate limit, keeping Cloudflare's reason",
      refusal(429, 971, "Verification email has been sent too recently"),
      {
        _tag: "Unavailable",
        code: "cloudflare_unavailable",
        message: "Verification email has been sent too recently. Try again later.",
      },
    ],
    [
      "a token without access",
      refusal(403, 10000, "Authentication error"),
      {
        _tag: "Unavailable",
        code: "cloudflare_misconfigured",
        message:
          "Cloudflare refused CF_EMAIL_ROUTING_TOKEN. Give it Email Routing Addresses edit access on this account and redeploy.",
      },
    ],
    [
      "an outage",
      refusal(503, 1000, "Service unavailable"),
      {
        _tag: "Unavailable",
        code: "cloudflare_unavailable",
        message: "Cloudflare Email Routing is unavailable. Try again.",
      },
    ],
  ] as const)("classifies %s, without retrying", ([_name, create, expected]) =>
    Effect.gen(function* () {
      const { calls, ensure } = cloudflare([], create);
      expect(yield* Effect.flip(ensure("new@example.com"))).toMatchObject(expected);
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    }),
  );
});

// Cloudflare's v4 envelope; list pages also carry `result_info`.
function envelope(
  result: unknown,
  resultInfo?: { readonly page: number; readonly per_page: number },
) {
  const body = { success: true, errors: [], messages: [], result };
  return Response.json(resultInfo === undefined ? body : { ...body, result_info: resultInfo });
}
