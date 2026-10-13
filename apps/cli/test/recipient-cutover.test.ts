import { Address, ReceivingDomain, RoutingConfiguration } from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type * as routing from "@distilled.cloud/cloudflare/email-routing";
import { recipientCutover, type CutoverCloudflare } from "../src/recipient-cutover.ts";

const configuration = new RoutingConfiguration({
  workerName: "umail-prod",
  ownerPrefix: "umail/uMail/prod/",
  domains: [
    new ReceivingDomain({ name: "mail.example.com", receive: true, send: true, zoneId: "zone" }),
  ],
});
const mailbox = new Address({
  id: "inbox-id",
  localPart: "inbox",
  address: "inbox@mail.example.com",
  domain: "mail.example.com",
  displayName: "Inbox",
  active: false,
  canSend: true,
  retiredAt: null,
  forwardTo: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  routing: { state: "ready", ruleId: "literal-id", zoneId: "zone", error: null },
});

function cloudflare() {
  let catchAll: routing.GetRuleCatchAllResponse = {
    enabled: true,
    actions: [{ type: "worker", value: [configuration.workerName] }],
    matchers: [{ type: "all" }],
  };
  const literal: routing.GetRuleResponse = {
    id: "literal-id",
    name: `${configuration.ownerPrefix}${mailbox.id}`,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: mailbox.address }],
    actions: [{ type: "worker", value: [configuration.workerName] }],
  };
  const rules = [literal];
  const writes: Array<string> = [];
  const client: CutoverCloudflare = {
    list: () => Effect.succeed(rules),
    catchAll: () => Effect.succeed(catchAll),
    disableCatchAll: (zone) =>
      Effect.sync(() => {
        writes.push(zone);
        catchAll = {
          enabled: false,
          matchers: [{ type: "all" }],
          actions: [{ type: "drop", value: [] }],
        };
        return catchAll;
      }),
  };
  return { client, writes, rules, literal };
}

const input = { zoneId: "zone", execute: false, configuration, mailboxes: [mailbox] };

describe("recipient catch-all cutover", () => {
  it.effect(
    "prints exact verified paused-mailbox coverage and leaves the catch-all unchanged by default",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare();
        const plan = yield* recipientCutover(input, cf.client);
        expect(plan).toMatchObject({
          ready: true,
          mode: "dry-run",
          coverage: [{ address: mailbox.address, ruleId: "literal-id", ready: true }],
          catchAll: { owned: true, change: { enabled: false, actions: [{ type: "drop" }] } },
        });
        expect(cf.writes).toEqual([]);
      }),
  );

  it.effect(
    "disables only the verified owned catch-all on explicit execution, then remains idempotent",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare();
        const plan = yield* recipientCutover({ ...input, execute: true }, cf.client);
        expect(plan).toHaveProperty("nextStep");
        expect(cf.writes).toEqual(["zone"]);
        yield* recipientCutover({ ...input, execute: true }, cf.client);
        expect(cf.writes).toEqual(["zone"]);
        expect(cf.rules[0]?.enabled).toBe(true);
      }),
  );

  it.effect("refuses premature cutover and another Worker's literal rule", () =>
    Effect.gen(function* () {
      for (const ready of [false, true]) {
        const cf = cloudflare();
        if (ready) cf.literal.actions = [{ type: "worker", value: ["another-worker"] }];
        const pending = new Address({
          ...(yield* Schema.encodeEffect(Address)(mailbox)),
          routing: { ...mailbox.routing, state: ready ? "ready" : "pending" },
        });
        const failure = yield* recipientCutover(
          { ...input, execute: true, mailboxes: [pending] },
          cf.client,
        ).pipe(Effect.flip);
        expect(failure.message).toContain("Cutover refused");
        expect(cf.writes).toEqual([]);
      }
    }),
  );

  it.effect("refuses a foreign zone or catch-all without writing", () =>
    Effect.gen(function* () {
      const cf = cloudflare();
      const outside = yield* recipientCutover(
        { ...input, zoneId: "foreign", execute: true },
        cf.client,
      ).pipe(Effect.flip);
      expect(outside.message).toContain("outside");
      const foreign: CutoverCloudflare = {
        ...cf.client,
        catchAll: () =>
          Effect.succeed({
            enabled: true,
            matchers: [{ type: "all" }],
            actions: [{ type: "worker", value: ["foreign"] }],
          }),
      };
      const denied = yield* recipientCutover({ ...input, execute: true }, foreign).pipe(
        Effect.flip,
      );
      expect(denied.message).toContain("Cutover refused");
      expect(cf.writes).toEqual([]);
    }),
  );
});
