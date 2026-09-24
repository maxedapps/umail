/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "vitest";

import { accountStore } from "./harness.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

describe("account-store administration commands", () => {
  it("applies only supplied PATCH columns including an explicit-null display name", async () => {
    const store = accountStore("admin-patch");
    const created = await store.createAddress("inbox", DOMAIN, "Inbox", NOW);
    expect(created).toMatchObject({
      localPart: "inbox",
      displayName: "Inbox",
      active: true,
    });
    const renamed = await store.patchAddress(created?.id ?? "", { displayName: "Team" }, LATER);
    expect(renamed).toMatchObject({ displayName: "Team", active: true });
    const deactivated = await store.patchAddress(created?.id ?? "", { active: false }, LATER);
    expect(deactivated).toMatchObject({ displayName: "Team", active: false });
    const cleared = await store.patchAddress(created?.id ?? "", { displayName: null }, LATER);
    expect(cleared).toMatchObject({ displayName: null, active: false });
  });

  it("sets and clears where an address forwards, and only for an existing address", async () => {
    const store = accountStore("admin-forwarding");
    const address = await store.createAddress("inbox", DOMAIN, "Inbox", NOW);
    const id = address?.id ?? "";
    expect(address?.forwardTo).toBeNull();
    expect(await store.setAddressForwarding(id, "forward@example.com", LATER)).toMatchObject({
      forwardTo: "forward@example.com",
      updatedAt: LATER,
    });
    expect((await store.getAddressByMailbox("inbox@umail.example.com"))?.forwardTo).toBe(
      "forward@example.com",
    );
    expect(await store.setAddressForwarding(id, null, LATER)).toMatchObject({ forwardTo: null });
    expect(await store.setAddressForwarding("missing", "forward@example.com", LATER)).toBeNull();
  });
});

function requireMailDomain(raw: string): MailDomain {
  const parsed = parseMailDomain(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}
