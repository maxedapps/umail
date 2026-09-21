import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";

import {
  cloudflareDestinationsClient,
  createStoredDestination,
  deleteStoredDestination,
  type CloudflareDestination,
  type DestinationAccountCommands,
  type StoredForwardingDestination,
} from "../../src/api/destinations.ts";

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

describe("stored destination provider commits", () => {
  it("keeps local destinations and associations intact when the provider refuses delete", async () => {
    const account = memoryAccount();
    const created = await Effect.runPromise(
      withCreateResponse(account, {
        id: "cf-1",
        email: "forward@example.com",
        verified: null,
      }),
    );
    account.associate("address-1", created.id);
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":9109,"message":"Authentication error"}],"result":null}',
        200,
      );

    const result = await Effect.runPromiseExit(
      deleteStoredDestination(client, account, created.id, "2026-01-01T01:00:00.000Z"),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(account.destinations.get(created.id)).toEqual(created);
    expect(account.associations.get("address-1")).toBe(created.id);
  });

  it("persists local detach and delete only after known provider success", async () => {
    const account = memoryAccount();
    const created = await Effect.runPromise(
      withCreateResponse(account, {
        id: "cf-1",
        email: "forward@example.com",
        verified: null,
      }),
    );
    account.associate("address-1", created.id);
    globalThis.fetch = async () => jsonResponse('{"success":true,"result":null}', 200);

    await Effect.runPromise(
      deleteStoredDestination(client, account, created.id, "2026-01-01T01:00:00.000Z"),
    );

    expect(account.destinations.get(created.id)).toBeUndefined();
    expect(account.associations.get("address-1")).toBeNull();
  });

  it("cleans up local records when the provider already removed the destination", async () => {
    const account = memoryAccount();
    const created = await Effect.runPromise(
      withCreateResponse(account, {
        id: "cf-1",
        email: "forward@example.com",
        verified: null,
      }),
    );
    globalThis.fetch = async () =>
      jsonResponse(
        '{"success":false,"errors":[{"code":2015,"message":"Destination address not found"}],"result":null}',
        200,
      );

    await Effect.runPromise(
      deleteStoredDestination(client, account, created.id, "2026-01-01T01:00:00.000Z"),
    );

    expect(account.destinations.get(created.id)).toBeUndefined();
  });
});

function withCreateResponse(
  account: MemoryDestinationAccount,
  address: { readonly id: string; readonly email: string; readonly verified: string | null },
) {
  globalThis.fetch = async () =>
    jsonResponse(
      JSON.stringify({
        success: true,
        result: address,
      }),
      200,
    );
  return createStoredDestination(client, account, address.email, "2026-01-01T00:00:00.000Z");
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MemoryDestinationAccount implements DestinationAccountCommands {
  readonly destinations = new Map<string, StoredForwardingDestination>();
  readonly associations = new Map<string, string | null>();

  getDestination(id: string): Effect.Effect<StoredForwardingDestination | null> {
    return Effect.sync(() => this.destinations.get(id) ?? null);
  }

  insertDestination(
    created: CloudflareDestination,
    nowIso: string,
  ): Effect.Effect<StoredForwardingDestination> {
    return Effect.sync(() => {
      const stored = {
        id: `local-${created.cloudflareId}`,
        cloudflareId: created.cloudflareId,
        nowIso,
      };
      this.destinations.set(stored.id, stored);
      return stored;
    });
  }

  deleteDestination(id: string, _nowIso: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.destinations.delete(id);
      for (const [addressId, destinationId] of this.associations) {
        if (destinationId === id) {
          this.associations.set(addressId, null);
        }
      }
    });
  }

  associate(addressId: string, destinationId: string): void {
    this.associations.set(addressId, destinationId);
  }
}

function memoryAccount(): MemoryDestinationAccount {
  return new MemoryDestinationAccount();
}
