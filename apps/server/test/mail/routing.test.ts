import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import type { ScopedPlanStatusSession } from "alchemy/Report";

import {
  deleteEmailRoutingDomain,
  diffEmailRoutingDomain,
  EmailRoutingDomainNotReady,
  readEmailRoutingDomain,
  reconcileEmailRoutingDomain,
} from "../../src/mail/routing.ts";

const zoneName = "example.com";
const domain = { zoneId: "zone-1", name: "mail.example.com" };
const apex = { zoneId: "zone-1", name: zoneName };
const routingPath = "/client/v4/zones/zone-1/email/routing";
const recordsPath = "/client/v4/zones/zone-1/dns_records";

function record(id: string, name: string, type: string, content: string) {
  return { id, name, type, content, ttl: 1, proxied: false, proxiable: false, meta: {} };
}

// What a zone holds at and around a routed subdomain once its routing records are unlocked.
const records = [
  record("mx-1", domain.name, "MX", "route1.mx.cloudflare.net"),
  record("mx-2", domain.name, "MX", "route2.mx.cloudflare.net"),
  record("spf", domain.name, "TXT", '"v=spf1 include:_spf.mx.cloudflare.net ~all"'),
  record("site", domain.name, "A", "192.0.2.1"),
  record("verify", domain.name, "TXT", '"site-verification=abc"'),
  record("other", `other.${zoneName}`, "MX", "route1.mx.cloudflare.net"),
];

// The deploy's status session: records the notes a waiting reconcile writes.
function recordingSession() {
  const notes: Array<string> = [];
  const session = {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: (note: string) => Effect.sync(() => void notes.push(note)),
  } satisfies ScopedPlanStatusSession;
  return { notes, session };
}

interface FakeReadiness {
  // Each readiness probe takes the next answer; the last one repeats.
  readonly apex?: Array<boolean>;
  readonly subdomain?: Array<boolean>;
}

function envelope(result: unknown) {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

// Fakes the Cloudflare API that the SDK talks to at deploy time.
function fakeCloudflare({ apex = [true], subdomain = [true] }: FakeReadiness) {
  const requests: Array<string> = [];
  const authorizations = new Set<string | undefined>();
  const next = (answers: Array<boolean>) =>
    answers.length > 1 ? answers.shift() === true : answers[0] === true;
  const settings = (ready: boolean) => ({
    id: "settings-1",
    name: zoneName,
    enabled: ready,
    status: ready ? "ready" : "unconfigured",
  });
  const resultFor = (route: string, url: URL) => {
    if (route === `GET ${routingPath}`) return settings(next(apex));
    if (route === `POST ${routingPath}/dns`) return settings(true);
    if (route === `PATCH ${routingPath}/dns`) return { ...settings(true), status: "unlocked" };
    if (route === `GET ${recordsPath}`) return url.searchParams.get("page") === "1" ? records : [];
    if (route.startsWith(`DELETE ${recordsPath}/`)) return { id: route.split("/").at(-1) };
    if (route !== `GET ${routingPath}/dns`) return undefined;
    const missing = {
      code: "missing",
      missing: {
        type: "MX",
        name: url.searchParams.get("subdomain"),
        content: "route1.mx.cloudflare.net",
        priority: 1,
      },
    };
    return { errors: next(subdomain) ? null : [missing], records: [] };
  };

  const http = HttpClient.make((request, url) => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    requests.push(`${request.method} ${url.pathname}${url.search} ${body}`.trim());
    authorizations.add(request.headers.authorization);
    const route = `${request.method} ${url.pathname}`;
    const result = resultFor(route, url);
    if (result === undefined) return Effect.die(`Unexpected Cloudflare request: ${route}`);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(envelope(result), { headers: { "content-type": "application/json" } }),
      ),
    );
  });

  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      Cloudflare.Credentials,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("deploy-token"),
        apiBaseUrl: "https://api.cloudflare.test/client/v4",
      }),
    ),
  );
  return { requests, authorizations, layer };
}

const dnsCheck = `GET ${routingPath}/dns?subdomain=${domain.name}`;
const settingsRead = `GET ${routingPath}`;

describe("Email Routing domain provider", () => {
  it.effect("adopts an existing ready registration", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ subdomain: [true] });

      const observed = yield* readEmailRoutingDomain(domain).pipe(Effect.provide(cloudflare.layer));

      expect(observed).toEqual(domain);
      expect(cloudflare.requests).toEqual([settingsRead, dnsCheck]);
      expect([...cloudflare.authorizations]).toEqual(["Bearer deploy-token"]);
    }),
  );

  it.effect("reports a domain whose DNS is not ready as missing", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ subdomain: [false] });

      const observed = yield* readEmailRoutingDomain(domain).pipe(Effect.provide(cloudflare.layer));

      expect(observed).toBeUndefined();
    }),
  );

  it.effect("leaves a ready domain alone", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ subdomain: [true] });

      const diff = yield* diffEmailRoutingDomain(domain, domain, domain).pipe(
        Effect.provide(cloudflare.layer),
      );
      const result = yield* reconcileEmailRoutingDomain(domain, recordingSession().session).pipe(
        Effect.provide(cloudflare.layer),
      );

      expect(diff).toBeUndefined();
      expect(result).toEqual(domain);
      expect(cloudflare.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    }),
  );

  it.effect("registers a domain that is not ready and waits for its DNS", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ subdomain: [false, false, false, true] });

      const diff = yield* diffEmailRoutingDomain(domain, domain, domain).pipe(
        Effect.provide(cloudflare.layer),
      );
      const fiber = yield* reconcileEmailRoutingDomain(domain, recordingSession().session).pipe(
        Effect.provide(cloudflare.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);

      expect(diff).toEqual({ action: "update" });
      expect(result).toEqual(domain);
      expect(cloudflare.requests.filter((request) => request !== settingsRead)).toEqual([
        dnsCheck,
        dnsCheck,
        `POST ${routingPath}/dns {"name":"${domain.name}"}`,
        dnsCheck,
        dnsCheck,
      ]);
    }),
  );

  it.effect("fails when DNS does not become ready in time", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ subdomain: [false] });
      const { notes, session } = recordingSession();

      const fiber = yield* reconcileEmailRoutingDomain(domain, session).pipe(
        Effect.provide(cloudflare.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(EmailRoutingDomainNotReady);
      // One line that names the record Cloudflare still misses.
      expect(error.message).toBe(
        `Email Routing DNS for ${domain.name} is not ready after 60 s. Missing: MX ${domain.name} → route1.mx.cloudflare.net (priority 1). Check for conflicting MX/TXT records.`,
      );
      expect(notes[0]).toBe(
        `waiting for Email Routing DNS: MX ${domain.name} → route1.mx.cloudflare.net (priority 1)`,
      );
      expect(cloudflare.requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
    }),
  );

  it.effect("takes a subdomain down by unlocking and deleting only its routing records", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({});

      yield* deleteEmailRoutingDomain(domain).pipe(Effect.provide(cloudflare.layer));

      const writes = cloudflare.requests.filter((request) => !request.startsWith("GET"));
      expect(writes).toEqual([
        `PATCH ${routingPath}/dns {"name":"${domain.name}"}`,
        `DELETE ${recordsPath}/mx-1`,
        `DELETE ${recordsPath}/mx-2`,
        `DELETE ${recordsPath}/spf`,
      ]);
    }),
  );

  // The apex carries every stage's routing; its only removal endpoints are zone-wide.
  it.effect("never takes the zone apex down", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({});

      yield* deleteEmailRoutingDomain(apex).pipe(Effect.provide(cloudflare.layer));

      expect(cloudflare.requests).toEqual([settingsRead]);
    }),
  );

  it.effect("enables apex routing from the zone's routing settings", () =>
    Effect.gen(function* () {
      const cloudflare = fakeCloudflare({ apex: [false, false, true] });

      const fiber = yield* reconcileEmailRoutingDomain(apex, recordingSession().session).pipe(
        Effect.provide(cloudflare.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);

      expect(result).toEqual(apex);
      expect(cloudflare.requests).toEqual([
        settingsRead,
        `POST ${routingPath}/dns {}`,
        settingsRead,
        settingsRead,
      ]);
    }),
  );
});
