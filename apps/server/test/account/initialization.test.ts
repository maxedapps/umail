import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AccountConflictError } from "../../src/account/errors.ts";
import type { AccountAddress } from "../../src/account/domain.ts";
import { MailDomain, MailboxAddress } from "@umail/api-contract";
import { seedDevelopmentAddresses } from "../../src/account/worker.ts";
import { layoutForStage } from "../../src/site.ts";
const ROOT = Schema.decodeSync(MailDomain)("umail.example.com");
describe("seedDevelopmentAddresses", () => {
  it("creates preview mailboxes through AccountStore provisioning commands", async () => {
    const store = new MemoryAddressProvisioning();
    const site = layoutForStage(ROOT, "dev");
    if (site.kind !== "preview") {
      throw new Error("expected a preview site");
    }
    const result = await Effect.runPromise(
      seedDevelopmentAddresses(store, {
        mailDomain: site.mailDomain,
        localParts: site.testLocalParts,
        nowIso: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(result).toEqual({ seeded: 2 });
    expect([...store.created].map((address) => address.address)).toEqual([
      "probe@dev-mail.umail.example.com",
      "inbox@dev-mail.umail.example.com",
    ]);
  });

  it("treats already-provisioned addresses as idempotent rather than failing the seed", async () => {
    const store = new MemoryAddressProvisioning();
    const site = layoutForStage(ROOT, "dev");
    if (site.kind !== "preview") {
      throw new Error("expected a preview site");
    }
    const input = {
      mailDomain: site.mailDomain,
      localParts: site.testLocalParts,
      nowIso: "2026-01-01T00:00:00.000Z",
    } as const;
    await Effect.runPromise(seedDevelopmentAddresses(store, input));
    const repeated = await Effect.runPromise(seedDevelopmentAddresses(store, input));

    expect(repeated).toEqual({ seeded: 0 });
    expect(store.created).toHaveLength(2);
  });
});

class MemoryAddressProvisioning {
  readonly created: Array<AccountAddress> = [];

  createAddress(
    localPart: string,
    mailDomain: MailDomain,
    displayName: string | undefined,
    nowIso: string,
  ) {
    return Effect.suspend(() => {
      const address = MailboxAddress.make(`${localPart}@${mailDomain}`);
      if (this.created.some((existing) => existing.address === address)) {
        return Effect.fail(new AccountConflictError({ resource: "address", id: address }));
      }
      const created = {
        id: `addr-${this.created.length + 1}`,
        localPart,
        address,
        displayName: displayName ?? null,
        active: true,
        forwardTo: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      } satisfies AccountAddress;
      this.created.push(created);
      return Effect.succeed(created);
    });
  }
}
