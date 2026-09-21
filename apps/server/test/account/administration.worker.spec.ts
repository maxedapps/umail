/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseExternalMailAddress, parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "vitest";

import { accountStore } from "./harness.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

const DEFAULT_POLICY = {
  mailboxIds: "all",
  canRead: true,
  canDelete: false,
  sendMode: { kind: "requireApproval", preapprovedRecipients: [] },
  recipientAllowlist: "any",
  canAdmin: false,
} as const;

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

  it("detaches forwarding and deletes a destination in one command", async () => {
    const store = accountStore("admin-destination");
    const address = await store.createAddress("inbox", DOMAIN, "Inbox", NOW);
    const destination = await store.insertDestination(
      "cf-dest-1",
      "forward@example.com",
      LATER,
      NOW,
    );
    expect(destination.verificationStatus).toBe("verified");
    const attached = await store.setAddressForwarding(address?.id ?? "", destination.id, LATER);
    expect(attached?.forwardingDestinationId).toBe(destination.id);
    await store.deleteDestination(destination.id, LATER);
    expect(await store.getDestination(destination.id)).toBeNull();
    expect((await store.getAddress(address?.id ?? ""))?.forwardingDestinationId).toBeNull();
    expect(await store.listDestinations()).toEqual([]);
  });

  it("round-trips MCP policy, persists preapproved recipients, and never reactivates revocation", async () => {
    const store = accountStore("admin-policy");
    const first = await store.ensureMcpOAuthPolicy({
      clientId: "client-1",
      label: "First label",
      createdAt: NOW,
    });
    const repeated = await store.ensureMcpOAuthPolicy({
      clientId: "client-1",
      label: "Replacement label",
      createdAt: LATER,
    });
    expect(first).toMatchObject({ state: "active", policy: DEFAULT_POLICY, label: "First label" });
    expect(repeated).toEqual(first);

    const recipient = requireExternal("exempt@example.com");
    const withExemptions = await store.updateMcpOAuthPolicy({
      clientId: "client-1",
      label: "Mail agent",
      policy: {
        mailboxIds: ["mailbox-1"],
        canRead: true,
        canDelete: true,
        sendMode: { kind: "requireApproval", preapprovedRecipients: [recipient] },
        recipientAllowlist: [requireExternal("recipient@example.com")],
        canAdmin: false,
      },
      updatedAt: LATER,
    });
    expect(withExemptions).toMatchObject({
      label: "Mail agent",
      policy: {
        sendMode: { kind: "requireApproval", preapprovedRecipients: [recipient] },
      },
    });

    const allowed = await store.updateMcpOAuthPolicy({
      clientId: "client-1",
      label: "Mail agent",
      policy: {
        mailboxIds: ["mailbox-1"],
        canRead: true,
        canDelete: true,
        sendMode: { kind: "allow" },
        recipientAllowlist: [requireExternal("recipient@example.com")],
        canAdmin: false,
      },
      updatedAt: LATER,
    });
    expect(allowed?.policy.sendMode).toEqual({ kind: "allow" });

    expect(
      await store.setMcpOAuthPolicyState({
        clientId: "client-1",
        state: "disabled",
        updatedAt: LATER,
      }),
    ).toMatchObject({ state: "disabled" });
    expect(
      await store.setMcpOAuthPolicyState({
        clientId: "client-1",
        state: "active",
        updatedAt: LATER,
      }),
    ).toMatchObject({ state: "active" });
    expect(await store.revokeMcpOAuthPolicy("client-1", LATER)).toMatchObject({
      state: "revoked",
    });
    expect(
      await store.setMcpOAuthPolicyState({
        clientId: "client-1",
        state: "active",
        updatedAt: LATER,
      }),
    ).toMatchObject({ state: "revoked" });
    expect(
      await store.updateMcpOAuthPolicy({
        clientId: "client-1",
        label: "Must not change",
        policy: DEFAULT_POLICY,
        updatedAt: LATER,
      }),
    ).toMatchObject({
      state: "revoked",
      label: "Mail agent",
      policy: {
        mailboxIds: ["mailbox-1"],
        sendMode: { kind: "allow" },
      },
    });
  });
});

function requireMailDomain(raw: string): MailDomain {
  const parsed = parseMailDomain(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected external address");
  }
  return parsed.address;
}
