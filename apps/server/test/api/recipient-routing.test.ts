import {
  Address,
  MailDomain,
  RoutingConfiguration,
  type CreateAddressPayload,
} from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { authorized, createWorld, jsonHeaders, readJson } from "./world.ts";

const domains = [
  { name: MailDomain.make("umail.example.com"), receive: true, send: true, zoneId: "first-zone" },
  {
    name: MailDomain.make("mail.other.example"),
    receive: true,
    send: false,
    zoneId: "second-zone",
  },
];

describe("mailbox routing API", () => {
  it.effect(
    "requires domain choice, returns durable pending state and isolates equal local parts",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld({ mailDomains: domains });
        const create = (payload: Pick<CreateAddressPayload, "localPart" | "domain">) =>
          world.request("http://umail.test/addresses", {
            method: "POST",
            headers: jsonHeaders(authorized(world).headers),
            body: JSON.stringify(payload),
          });
        const missing = yield* create({ localPart: "inbox" });
        expect(missing.status).toBe(400);
        expect(yield* readJson(missing)).toMatchObject({ code: "receiving_domain_required" });
        const addresses: Array<Address> = [];
        for (const domain of domains) {
          const response = yield* create({ localPart: "inbox", domain: domain.name });
          expect(response.status).toBe(200);
          const address = yield* Schema.decodeUnknownEffect(Address)(yield* readJson(response));
          addresses.push(address);
          expect(address).toMatchObject({
            address: `inbox@${domain.name}`,
            canSend: domain.send,
            routing: { state: "pending", ruleId: null },
          });
        }
        expect(addresses[0]?.id).not.toBe(addresses[1]?.id);
        const receiveOnly = addresses[1]!;
        const submission = yield* world.request("http://umail.test/submissions", {
          method: "POST",
          headers: jsonHeaders(authorized(world).headers),
          body: JSON.stringify({
            intent: "compose",
            requestId: "af931001-26a9-4e99-8cdb-931000000001",
            fromAddressId: receiveOnly.id,
            to: [{ address: "recipient@example.net", displayName: null }],
            subject: "Must not send",
            text: "Receive-only domains cannot create outbound work.",
          }),
        });
        expect(submission.status).toBe(400);
        expect(yield* readJson(submission)).toMatchObject({ code: "sender_domain_receive_only" });
        const sending = yield* world.request(
          "http://umail.test/sending-identities",
          authorized(world),
        );
        expect(yield* readJson(sending)).toMatchObject([{ address: "inbox@umail.example.com" }]);
        const metadata = yield* world.request(
          "http://umail.test/routing-configuration",
          authorized(world),
        );
        expect(
          yield* Schema.decodeUnknownEffect(RoutingConfiguration)(yield* readJson(metadata)),
        ).toMatchObject({ workerName: "test-worker", ownerPrefix: "umail/uMail/test/", domains });
      }),
  );

  it.effect(
    "retirement preserves the mailbox and prevents reactivation while retry persists removal intent",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const response = yield* world.request("http://umail.test/addresses", {
          method: "POST",
          headers: jsonHeaders(authorized(world).headers),
          body: JSON.stringify({ localPart: "kept" }),
        });
        const address = yield* Schema.decodeUnknownEffect(Address)(yield* readJson(response));
        const retired = yield* world.request(`http://umail.test/addresses/${address.id}/retire`, {
          method: "POST",
          ...authorized(world),
        });
        expect(yield* Schema.decodeUnknownEffect(Address)(yield* readJson(retired))).toMatchObject({
          active: false,
          retiredAt: expect.any(String),
          routing: { state: "pending" },
        });
        const resume = yield* world.request(`http://umail.test/addresses/${address.id}`, {
          method: "PATCH",
          headers: jsonHeaders(authorized(world).headers),
          body: JSON.stringify({ active: true }),
        });
        expect(resume.status).toBe(404);
        const retry = yield* world.request(
          `http://umail.test/addresses/${address.id}/routing/retry`,
          { method: "POST", ...authorized(world) },
        );
        expect(retry.status).toBe(200);
        expect(yield* Schema.decodeUnknownEffect(Address)(yield* readJson(retry))).toMatchObject({
          active: false,
          routing: { state: "pending" },
        });
        const list = yield* world.request("http://umail.test/addresses", authorized(world));
        expect(yield* readJson(list)).toHaveLength(1);
      }),
  );
});
