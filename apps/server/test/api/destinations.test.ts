import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";

import { cloudflareDestinationsClient } from "../../src/api/destinations.ts";

const client = cloudflareDestinationsClient({
  token: Redacted.make("token"),
  accountId: "account",
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloudflare destinations errors", () => {
  it("uses Cloudflare errors[0].message on HTTP failure", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":1004,"message":"Address already exists"}],"result":null}',
        400,
      );

    await expect(Effect.runPromise(client.create("forward@example.com"))).rejects.toMatchObject({
      _tag: "DestinationsError",
      reason: "http_failed",
      message: "Address already exists",
    });
  });

  it("falls back when the Cloudflare error envelope has no message", async () => {
    globalThis.fetch = async () => jsonResponse('{"success":false,"result":null}', 400);

    await expect(Effect.runPromise(client.create("forward@example.com"))).rejects.toMatchObject({
      _tag: "DestinationsError",
      reason: "http_failed",
      message: "Could not create the forwarding destination.",
    });
  });

  it("uses the fallback message for transport failures", async () => {
    globalThis.fetch = async () => {
      throw new Error("network");
    };

    await expect(Effect.runPromise(client.create("forward@example.com"))).rejects.toMatchObject({
      _tag: "DestinationsError",
      reason: "request_failed",
      message: "Could not create the forwarding destination.",
    });
  });

  it("rejects HTTP 200 success:false envelopes on create", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":1004,"message":"Address already exists"}],"result":null}',
        200,
      );

    await expect(Effect.runPromise(client.create("forward@example.com"))).rejects.toMatchObject({
      _tag: "DestinationsError",
      reason: "http_failed",
      message: "Address already exists",
    });
  });

  it("rejects HTTP 200 success:false envelopes on delete", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":9109,"message":"Authentication error"}],"result":null}',
        200,
      );

    await expect(Effect.runPromise(client.delete("cf-1"))).rejects.toMatchObject({
      _tag: "DestinationsError",
      reason: "http_failed",
      message: "Authentication error",
    });
  });

  it("treats already-removed provider records as successful deletes", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":2015,"message":"Destination address not found"}],"result":null}',
        404,
      );

    await expect(Effect.runPromise(client.delete("cf-missing"))).resolves.toBeUndefined();
  });

  it("treats HTTP 200 not-found envelopes as already-removed deletes", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":2015,"message":"Destination address not found"}],"result":null}',
        200,
      );

    await expect(Effect.runPromise(client.delete("cf-missing"))).resolves.toBeUndefined();
  });
});

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}
