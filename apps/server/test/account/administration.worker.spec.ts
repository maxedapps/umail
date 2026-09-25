/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { accountStore } from "./harness.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

describe("account-store administration commands", () => {
  it.effect("applies only supplied PATCH columns including an explicit-null display name", () =>
    Effect.gen(function* () {
      const store = accountStore("admin-patch");
      const created = yield* Effect.promise(() =>
        store.createAddress("inbox", DOMAIN, "Inbox", NOW),
      );
      expect(created).toMatchObject({
        localPart: "inbox",
        displayName: "Inbox",
        active: true,
      });
      const id = created?.id ?? "";
      const renamed = yield* Effect.promise(() =>
        store.patchAddress(id, { displayName: "Team" }, LATER),
      );
      expect(renamed).toMatchObject({ displayName: "Team", active: true });
      const deactivated = yield* Effect.promise(() =>
        store.patchAddress(id, { active: false }, LATER),
      );
      expect(deactivated).toMatchObject({ displayName: "Team", active: false });
      const cleared = yield* Effect.promise(() =>
        store.patchAddress(id, { displayName: null }, LATER),
      );
      expect(cleared).toMatchObject({ displayName: null, active: false });
    }),
  );

  it.effect("sets and clears where an address forwards, and only for an existing address", () =>
    Effect.gen(function* () {
      const store = accountStore("admin-forwarding");
      const address = yield* Effect.promise(() =>
        store.createAddress("inbox", DOMAIN, "Inbox", NOW),
      );
      const id = address?.id ?? "";
      expect(address?.forwardTo).toBeNull();
      expect(
        yield* Effect.promise(() => store.setAddressForwarding(id, "forward@example.com", LATER)),
      ).toMatchObject({
        forwardTo: "forward@example.com",
        updatedAt: LATER,
      });
      expect(
        (yield* Effect.promise(() => store.getAddressByMailbox("inbox@umail.example.com")))
          ?.forwardTo,
      ).toBe("forward@example.com");
      expect(
        yield* Effect.promise(() => store.setAddressForwarding(id, null, LATER)),
      ).toMatchObject({ forwardTo: null });
      expect(
        yield* Effect.promise(() =>
          store.setAddressForwarding("missing", "forward@example.com", LATER),
        ),
      ).toBeNull();
    }),
  );
});

function requireMailDomain(raw: string): MailDomain {
  const parsed = parseMailDomain(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}
