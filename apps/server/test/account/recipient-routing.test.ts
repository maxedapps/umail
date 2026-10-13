import { MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createAddress,
  getAddress,
  patchAddress,
  retireAddress,
  retryAddressRouting,
} from "../../src/account/administration.ts";
import { applyAccountSchema } from "../../src/account/commands.ts";
import { accountMigrations } from "../../src/account/migrations.ts";
import {
  reconcileDueRecipientRoutes,
  type RecipientRoutingPorts,
} from "../../src/account/recipient-routing.ts";
import { RecipientRuleError } from "../../src/mail/recipient-rules.ts";
import { MemoryAccountSqliteStorage } from "../api/memory-account-store.ts";
import { MemoryRecipientRules } from "../mail/recipient-fake.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const FIRST = MailDomain.make("mail.first.example");
const SECOND = MailDomain.make("mail.second.example");

function world() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const storage = new MemoryAccountSqliteStorage();
      applyAccountSchema(storage, NOW);
      const client = new MemoryRecipientRules();
      const ports: RecipientRoutingPorts = {
        client,
        domains: [
          { name: FIRST, receive: true, send: true, zoneId: "zone-one" },
          { name: SECOND, receive: true, send: false, zoneId: "zone-two" },
        ],
        ownerPrefix: "umail/uMail/test/",
        workerName: "test-worker",
        legacySeeds: [],
      };
      const create = (id: string, domain = FIRST) =>
        createAddress(storage, id, "inbox", domain, "Inbox", NOW, domain === FIRST);
      const run = (at = NOW_MS) => reconcileDueRecipientRoutes(storage, ports, at);
      return { storage, client, ports, create, run };
    }),
    ({ storage }) => Effect.sync(() => storage.close()),
  );
}

describe("durable recipient routing", () => {
  it.effect("persists intent before I/O and routes identical local parts independently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const w = yield* world();
        expect(w.create("one")?.routing.state).toBe("pending");
        expect(w.create("two", SECOND)).toMatchObject({
          address: `inbox@${SECOND}`,
          canSend: false,
          routing: { state: "pending" },
        });
        expect(w.client.writes).toEqual([]);
        yield* w.run();
        expect(getAddress(w.storage, "one")).toMatchObject({
          routing: { state: "ready", zoneId: "zone-one" },
        });
        expect(getAddress(w.storage, "two")).toMatchObject({
          routing: { state: "ready", zoneId: "zone-two" },
        });
        expect(w.client.writes.map(({ zoneId }) => zoneId)).toEqual(["zone-one", "zone-two"]);
      }),
    ),
  );

  it.effect(
    "recovers a created rule after an uncertain response without creating a duplicate",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const w = yield* world();
          w.create("one");
          w.client.afterSave = () => {
            throw new RecipientRuleError({ message: "response lost", retryable: true });
          };
          yield* w.run();
          expect(getAddress(w.storage, "one")).toMatchObject({
            routing: { state: "error", zoneId: "zone-one", ruleId: null },
          });
          expect(w.storage.sql.exec("SELECT retry_after FROM mailbox_routes").toArray()).toEqual([
            { retry_after: "2026-01-01T00:01:00.000Z" },
          ]);
          w.client.afterSave = undefined;
          yield* w.run(NOW_MS + 59_999);
          expect(getAddress(w.storage, "one")?.routing.state).toBe("error");
          yield* w.run(NOW_MS + 60_000);
          expect(getAddress(w.storage, "one")).toMatchObject({
            routing: { state: "ready", ruleId: "rule-1" },
          });
          expect(w.client.writes).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "keeps paused recipients routed and removes only the retired rule while retaining its archive",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const w = yield* world();
          w.create("one");
          patchAddress(w.storage, "one", { active: false }, NOW);
          yield* w.run();
          expect([...w.client.rows.values()][0]?.rule.enabled).toBe(true);
          w.storage.sql.exec(
            "INSERT INTO messages (id, thread_id, mailbox_id, direction, occurred_at, created_at, updated_at, subject) VALUES ('archive', 'archive', 'one', 'inbound', ?, ?, ?, 'Kept')",
            NOW,
            NOW,
            NOW,
          );
          retireAddress(w.storage, "one", NOW);
          yield* w.run();
          expect(w.client.rows.size).toBe(0);
          expect(getAddress(w.storage, "one")).toMatchObject({
            active: false,
            retiredAt: NOW,
            routing: { state: "ready", ruleId: null },
          });
          expect(w.storage.sql.exec("SELECT subject FROM messages").toArray()).toEqual([
            { subject: "Kept" },
          ]);
          expect(patchAddress(w.storage, "one", { active: true }, NOW)).toBeNull();
        }),
      ),
  );

  it.effect("retains the returned rule ID when retirement races creation, then deletes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const w = yield* world();
        w.create("one");
        w.client.afterSave = () => {
          retireAddress(w.storage, "one", NOW);
        };
        yield* w.run();
        expect(getAddress(w.storage, "one")).toMatchObject({
          retiredAt: NOW,
          routing: { state: "pending", ruleId: "rule-1" },
        });
        w.client.afterSave = undefined;
        yield* w.run();
        expect(w.client.writes.map(({ operation }) => operation)).toEqual(["save", "remove"]);
        expect(w.client.rows.size).toBe(0);
      }),
    ),
  );

  it.effect("refuses a foreign literal rule even when its Worker target looks right", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const w = yield* world();
        w.create("one");
        yield* w.client.save(
          "zone-one",
          `inbox@${FIRST}`,
          "test-worker",
          "somebody-else",
          "foreign",
        );
        w.client.writes.length = 0;
        yield* w.run();
        expect(getAddress(w.storage, "one")?.routing).toMatchObject({
          state: "error",
          error: expect.stringContaining("will not take it over"),
        });
        expect(w.client.writes).toEqual([]);
        expect(w.storage.sql.exec("SELECT retry_after FROM mailbox_routes").toArray()).toEqual([
          { retry_after: null },
        ]);
      }),
    ),
  );

  it.effect("stops on credential errors and resumes only when explicitly retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const w = yield* world();
        w.create("one");
        w.client.failure = new RecipientRuleError({
          message: "permission denied",
          retryable: false,
        });
        yield* w.run();
        w.client.failure = null;
        yield* w.run(NOW_MS + 3_600_000);
        expect(w.client.writes).toEqual([]);
        retryAddressRouting(w.storage, "one", NOW);
        yield* w.run();
        expect(getAddress(w.storage, "one")?.routing.state).toBe("ready");
      }),
    ),
  );

  it.effect("transfers only a seed rule named explicitly by stored deployment state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const w = yield* world();
        w.create("one");
        yield* w.client.save(
          "zone-one",
          `inbox@${FIRST}`,
          "test-worker",
          "old Alchemy seed",
          "seed",
        );
        w.client.writes.length = 0;
        yield* reconcileDueRecipientRoutes(
          w.storage,
          {
            ...w.ports,
            legacySeeds: [{ id: "seed", zoneId: "zone-one", address: `inbox@${FIRST}` }],
          },
          NOW_MS,
        );
        expect(getAddress(w.storage, "one")?.routing).toMatchObject({
          state: "ready",
          ruleId: "seed",
        });
        expect(w.client.rows.get("seed")?.rule.name).toBe("umail/uMail/test/one");
        expect(w.client.writes).toEqual([{ operation: "save", zoneId: "zone-one", id: "seed" }]);
      }),
    ),
  );
});

it("backfills old active and paused mailboxes without changing their identity or lifecycle", () => {
  const storage = new MemoryAccountSqliteStorage();
  try {
    applyAccountSchema(storage, NOW, accountMigrations.slice(0, 1));
    storage.sql.exec(
      "INSERT INTO addresses (id, local_part, address, active, created_at, updated_at) VALUES ('old', 'inbox', ?, 0, ?, ?)",
      `inbox@${FIRST}`,
      NOW,
      NOW,
    );
    applyAccountSchema(storage, NOW);
    expect(getAddress(storage, "old")).toMatchObject({
      id: "old",
      address: `inbox@${FIRST}`,
      active: false,
      canSend: true,
      retiredAt: null,
      routing: { state: "pending", ruleId: null },
    });
  } finally {
    storage.close();
  }
});
