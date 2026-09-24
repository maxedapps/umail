import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "vitest";

import { cloudflareDestinations } from "../../src/api/destinations.ts";

const destinations = cloudflareDestinations({
  token: Redacted.make("token"),
  accountId: "account",
});

type Listed = { readonly id: string; readonly email: string; readonly verified: string | null };

// A Cloudflare account whose destination addresses come back one per page.
function cloudflare(listed: ReadonlyArray<Listed>, create?: () => Response) {
  const calls: Array<string> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = request.method === "POST" ? await request.json() : null;
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
  };
  return {
    calls,
    ensure: (email: string) =>
      Effect.runPromise(
        destinations.ensure(email).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      ),
  };
}

describe("cloudflare forwarding destinations", () => {
  it("adopts an address listed under different case, past the first page, without creating it", async () => {
    const { calls, ensure } = cloudflare([
      { id: "other", email: "other@example.com", verified: null },
      { id: "forward", email: "Forward@Example.com", verified: "2026-01-01T00:00:00Z" },
    ]);

    expect(await ensure("forward@example.com")).toEqual({
      email: "Forward@Example.com",
      verified: true,
    });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("creates a missing destination, which stays unverified until its owner confirms", async () => {
    const { calls, ensure } = cloudflare([
      { id: "other", email: "other@example.com", verified: null },
    ]);

    expect(await ensure("new@example.com")).toEqual({
      email: "new@example.com",
      verified: false,
    });
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("surfaces Cloudflare's own error message", async () => {
    const { ensure } = cloudflare([], () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 1004, message: "Address is not allowed" }],
          result: null,
        },
        { status: 400 },
      ),
    );

    await expect(ensure("new@example.com")).rejects.toMatchObject({
      _tag: "DestinationError",
      message: "Address is not allowed",
    });
  });
});

// Cloudflare's v4 envelope; list pages also carry `result_info`.
function envelope(
  result: unknown,
  resultInfo?: { readonly page: number; readonly per_page: number },
) {
  const body = { success: true, errors: [], messages: [], result };
  return Response.json(resultInfo === undefined ? body : { ...body, result_info: resultInfo });
}
