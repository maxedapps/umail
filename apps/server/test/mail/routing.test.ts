import * as Cloudflare from "alchemy/Cloudflare";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";

import {
  EmailRoutingDomainApiError,
  EmailRoutingDomainsApi,
  EmailRoutingDomainsApiLive,
  type EmailRoutingDomainIdentity,
  type EmailRoutingDomainInspection,
  type EmailRoutingDomainsApiService,
} from "../../src/mail/routing-api.ts";
import {
  EmailRoutingDomainNotReady,
  EmailRoutingDomainRemovalUnsafe,
  makeEmailRoutingDomainLifecycle,
} from "../../src/mail/routing.ts";

interface CapturedCloudflareRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly body: string | undefined;
}

interface LifecycleMutation {
  readonly operation: "enable" | "enable-apex" | "disable";
  readonly identity: EmailRoutingDomainIdentity;
}

const zoneName = "example.com";

const identity = {
  zoneId: "zone-1",
  name: "dev-mail.umail.example.com",
} as const satisfies EmailRoutingDomainIdentity;

const apexIdentity = {
  zoneId: "zone-1",
  name: zoneName,
} as const satisfies EmailRoutingDomainIdentity;

const readyRegistration = {
  ...identity,
  subdomainId: "routing-domain-1",
  enabled: true,
  status: "ready",
  dnsReady: true,
} as const;

const apexReadyRegistration = {
  ...apexIdentity,
  subdomainId: "routing-settings-1",
  enabled: true,
  status: "ready",
  dnsReady: true,
} as const;

const readyInspection = {
  zoneName,
  apexEnabled: true,
  enabledNames: [identity.name, "sibling-mail.umail.example.com"],
  exact: readyRegistration,
} as const satisfies EmailRoutingDomainInspection;

const apexReadyInspection = {
  zoneName,
  apexEnabled: true,
  enabledNames: [identity.name, "sibling-mail.umail.example.com"],
  exact: apexReadyRegistration,
} as const satisfies EmailRoutingDomainInspection;

const missingInspection = {
  zoneName,
  apexEnabled: true,
  enabledNames: ["sibling-mail.umail.example.com"],
  exact: undefined,
} as const satisfies EmailRoutingDomainInspection;

const disabledInspection = {
  zoneName,
  apexEnabled: true,
  enabledNames: [],
  exact: {
    ...readyRegistration,
    enabled: false,
    dnsReady: false,
  },
} as const satisfies EmailRoutingDomainInspection;

const unreadyInspection = {
  zoneName,
  apexEnabled: true,
  enabledNames: [identity.name],
  exact: {
    ...readyRegistration,
    status: "misconfigured",
    dnsReady: false,
  },
} as const satisfies EmailRoutingDomainInspection;

const apexUnreadyInspection = {
  zoneName,
  apexEnabled: false,
  enabledNames: [identity.name, "sibling-mail.umail.example.com"],
  exact: {
    ...apexReadyRegistration,
    enabled: false,
    status: "unconfigured",
    dnsReady: false,
  },
} as const satisfies EmailRoutingDomainInspection;

const settingsSuccessJson = `{"success":true,"result":{"id":"routing-settings-1","name":"example.com","enabled":true,"status":"ready","subdomains":[{"id":"routing-domain-1","name":"${identity.name}","enabled":true,"status":"ready"},{"id":"routing-domain-2","name":"sibling-mail.umail.example.com","enabled":true,"status":"ready"}]}}`;
const dnsReadyJson = `{"success":true,"result":{"errors":null,"records":[{"content":"route1.mx.cloudflare.net.","name":"${identity.name}","priority":28,"ttl":1,"type":"MX"}]}}`;
// Documented default response: DNS requirements, not a readiness report.
const apexDnsRequirementsJson = JSON.stringify({
  success: true,
  errors: [],
  messages: [],
  result: [
    { type: "MX", name: zoneName, content: "route1.mx.cloudflare.net.", priority: 28, ttl: 1 },
  ],
});
const dnsUnreadyJson = `{"success":true,"result":{"errors":[{"code":"missing","missing":{"content":"route1.mx.cloudflare.net.","name":"${identity.name}","priority":28,"ttl":1,"type":"MX"}}],"records":[]}}`;
const mutationSuccessJson = '{"success":true,"result":{}}';
const emptySubdomainsJson =
  '{"success":true,"result":{"id":"routing-settings-1","name":"example.com","enabled":true,"status":"ready"}}';
const invalidSubdomainsJson =
  '{"success":true,"result":{"id":"routing-settings-1","name":"example.com","enabled":true,"status":"ready","subdomains":"not-a-list"}}';
const routingDomainMutationJson = `{"name":"${identity.name}"}`;
const deploymentToken = "deployment-token";

type TestCredentialsResolver = Effect.Success<typeof Cloudflare.Credentials>;

const deploymentTokenCredentials = Effect.succeed({
  type: "apiToken" as const,
  apiToken: Redacted.make(deploymentToken),
  apiBaseUrl: "https://api.cloudflare.test/client/v4",
});

function requestBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") return undefined;
  return new TextDecoder().decode(request.body.body);
}

function cloudflareHttpClient(
  captured: Array<CapturedCloudflareRequest>,
  responseFor: (request: HttpClientRequest.HttpClientRequest, url: URL) => Response,
) {
  return HttpClient.make((request, url) => {
    captured.push({
      method: request.method,
      url: url.toString(),
      authorization: request.headers.authorization,
      apiKey: request.headers["x-auth-key"],
      body: requestBody(request),
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseFor(request, url)));
  });
}

function jsonResponse(encodedBody: string, status = 200) {
  return new Response(encodedBody, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runLiveApi<A>(
  effect: Effect.Effect<A, EmailRoutingDomainApiError, EmailRoutingDomainsApi>,
  http: HttpClient.HttpClient,
  credentials: TestCredentialsResolver = deploymentTokenCredentials,
) {
  return effect.pipe(
    Effect.provide(EmailRoutingDomainsApiLive),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(Cloudflare.Credentials, credentials),
  );
}

function fakeApi(
  observations: Array<EmailRoutingDomainInspection>,
  mutations: Array<LifecycleMutation>,
): EmailRoutingDomainsApiService {
  return {
    inspect: () => {
      const observation = observations.shift();
      return observation === undefined
        ? Effect.die("Unexpected Email Routing inspection")
        : Effect.succeed(observation);
    },
    enableApex: (target) => {
      mutations.push({ operation: "enable-apex", identity: target });
      return Effect.void;
    },
    enable: (target) => {
      mutations.push({ operation: "enable", identity: target });
      return Effect.void;
    },
    disableExact: (target) => {
      mutations.push({ operation: "disable", identity: target });
      return Effect.void;
    },
  };
}

describe("Email Routing domain Cloudflare API adapter", () => {
  it.effect(
    "uses the exact documented read/create routes and targeted deprecated removal route",
    () =>
      Effect.gen(function* () {
        const captured: Array<CapturedCloudflareRequest> = [];
        const http = cloudflareHttpClient(captured, (request, url) => {
          if (request.method === "GET" && url.pathname.endsWith("/email/routing")) {
            return jsonResponse(settingsSuccessJson);
          }
          if (request.method === "GET" && url.pathname.endsWith("/email/routing/dns")) {
            return jsonResponse(dnsReadyJson);
          }
          return jsonResponse(mutationSuccessJson);
        });

        const inspection = yield* runLiveApi(
          Effect.gen(function* () {
            const api = yield* EmailRoutingDomainsApi;
            const current = yield* api.inspect(identity);
            yield* api.enable(identity);
            yield* api.disableExact(identity);
            return current;
          }),
          http,
        );

        expect(inspection).toEqual({
          zoneName,
          apexEnabled: true,
          enabledNames: [identity.name, "sibling-mail.umail.example.com"],
          exact: readyRegistration,
        });
        expect(captured.map(({ method }) => method)).toEqual(["GET", "GET", "POST", "POST"]);
        expect(captured.every(({ method }) => method !== "DELETE")).toBe(true);
        expect(new URL(captured[0]?.url ?? "").pathname).toBe(
          "/client/v4/zones/zone-1/email/routing",
        );
        const dnsUrl = new URL(captured[1]?.url ?? "");
        expect(dnsUrl.pathname).toBe("/client/v4/zones/zone-1/email/routing/dns");
        expect(dnsUrl.searchParams.get("subdomain")).toBe(identity.name);
        expect(new URL(captured[2]?.url ?? "").pathname).toBe(
          "/client/v4/zones/zone-1/email/routing/dns",
        );
        expect(new URL(captured[3]?.url ?? "").pathname).toBe(
          "/client/v4/zones/zone-1/email/routing/disable",
        );
        expect(captured[2]?.body).toBe(routingDomainMutationJson);
        expect(captured[3]?.body).toBe(routingDomainMutationJson);
        for (const request of captured) {
          expect(request.authorization).toBe(`Bearer ${deploymentToken}`);
        }
      }),
  );

  it.effect("normalizes Cloudflare's omitted zero-subdomain field to an empty collection", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, () => jsonResponse(emptySubdomainsJson));
      const inspection = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.inspect(identity);
        }),
        http,
      );

      expect(inspection).toEqual({
        zoneName,
        apexEnabled: true,
        enabledNames: [],
        exact: undefined,
      });
    }),
  );

  it.effect(
    "reports the exact registration unready when Cloudflare lists missing DNS records",
    () =>
      Effect.gen(function* () {
        const captured: Array<CapturedCloudflareRequest> = [];
        const http = cloudflareHttpClient(captured, (request, url) =>
          request.method === "GET" && url.pathname.endsWith("/email/routing/dns")
            ? jsonResponse(dnsUnreadyJson)
            : jsonResponse(settingsSuccessJson),
        );
        const inspection = yield* runLiveApi(
          Effect.gen(function* () {
            const api = yield* EmailRoutingDomainsApi;
            return yield* api.inspect(identity);
          }),
          http,
        );

        expect(inspection.exact).toEqual({
          ...readyRegistration,
          dnsReady: false,
        });
      }),
  );

  it.effect("fails closed when the undocumented subdomains contract is malformed", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, () => jsonResponse(invalidSubdomainsJson));
      const error = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.inspect(identity);
        }),
        http,
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "EmailRoutingDomainApiError",
        operation: "read-routing-settings",
        status: 200,
        reason: "invalid-success-response",
      });
    }),
  );

  it.effect("treats the resolved zone name as apex routing, not a missing child", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, (request, url) => {
        if (request.method === "GET" && url.pathname.endsWith("/email/routing")) {
          return jsonResponse(settingsSuccessJson);
        }
        if (request.method === "GET" && url.pathname.endsWith("/email/routing/dns")) {
          return jsonResponse(apexDnsRequirementsJson);
        }
        return jsonResponse(mutationSuccessJson);
      });
      const inspection = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.inspect(apexIdentity);
        }),
        http,
      );

      expect(inspection).toEqual(apexReadyInspection);
      expect(captured.map(({ method }) => method)).toEqual(["GET", "GET"]);
      const dnsUrl = new URL(captured[1]?.url ?? "");
      expect(dnsUrl.pathname).toBe("/client/v4/zones/zone-1/email/routing/dns");
      expect(dnsUrl.searchParams.get("subdomain")).toBeNull();
    }),
  );

  it.effect("does not treat DNS requirements as evidence that apex routing is ready", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, (_request, url) => {
        if (url.pathname.endsWith("/email/routing")) {
          return jsonResponse(
            JSON.stringify({
              success: true,
              result: { id: "settings-1", name: zoneName, enabled: true, status: "misconfigured" },
            }),
          );
        }
        return jsonResponse(apexDnsRequirementsJson);
      });
      const inspection = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.inspect(apexIdentity);
        }),
        http,
      );
      expect(inspection.exact?.dnsReady).toBe(false);
      expect(inspection.exact?.status).toBe("misconfigured");
    }),
  );

  it.effect("rejects malformed apex DNS requirement responses", () =>
    Effect.gen(function* () {
      const http = cloudflareHttpClient([], (_request, url) =>
        jsonResponse(
          url.pathname.endsWith("/dns")
            ? '{"success":true,"result":{"errors":null}}'
            : settingsSuccessJson,
        ),
      );
      const result = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.inspect(apexIdentity);
        }),
        http,
      ).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-success-response" },
      });
    }),
  );

  it.effect("enables apex routing without child-domain registration semantics", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, () => jsonResponse(mutationSuccessJson));
      yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          yield* api.enableApex(apexIdentity);
        }),
        http,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.method).toBe("POST");
      expect(new URL(captured[0]?.url ?? "").pathname).toBe(
        "/client/v4/zones/zone-1/email/routing/dns",
      );
      expect(captured[0]?.body).toBeUndefined();
    }),
  );

  it.effect("rejects HTTP 200 success:false envelopes as Cloudflare failures", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedCloudflareRequest> = [];
      const http = cloudflareHttpClient(captured, () =>
        jsonResponse(
          '{"success":false,"errors":[{"code":2007,"message":"must be a subdomains of example.com"}]}',
        ),
      );
      const error = yield* runLiveApi(
        Effect.gen(function* () {
          const api = yield* EmailRoutingDomainsApi;
          return yield* api.enable(identity);
        }),
        http,
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "EmailRoutingDomainApiError",
        operation: "enable-routing-domain",
        status: 200,
        reason: "cloudflare-rejected-request",
        message: "must be a subdomains of example.com",
      });
    }),
  );

  it.effect("never retains bearer or global API-key credentials in adapter errors", () =>
    Effect.gen(function* () {
      const bearerRequests: Array<CapturedCloudflareRequest> = [];
      const bearerHttp = cloudflareHttpClient(bearerRequests, () => jsonResponse("{}"));
      const inspect = Effect.gen(function* () {
        const api = yield* EmailRoutingDomainsApi;
        return yield* api.inspect(identity);
      });
      const bearerError = yield* runLiveApi(inspect, bearerHttp).pipe(Effect.flip);

      expect(bearerRequests[0]?.authorization).toBe(`Bearer ${deploymentToken}`);
      const bearerErrorJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        bearerError,
      );
      expect(bearerErrorJson).not.toContain(deploymentToken);
      expect(bearerError.reason).toBe("invalid-success-response");

      const globalApiKey = "global-api-key-secret";
      const apiKeyRequests: Array<CapturedCloudflareRequest> = [];
      const apiKeyHttp = cloudflareHttpClient(apiKeyRequests, () => jsonResponse("{}"));
      const apiKeyCredentials = Effect.succeed({
        type: "apiKey" as const,
        apiKey: Redacted.make(globalApiKey),
        email: "operator@example.com",
        apiBaseUrl: "https://api.cloudflare.test/client/v4",
      });
      const apiKeyError = yield* runLiveApi(inspect, apiKeyHttp, apiKeyCredentials).pipe(
        Effect.flip,
      );

      expect(apiKeyRequests[0]?.apiKey).toBe(globalApiKey);
      const apiKeyErrorJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        apiKeyError,
      );
      expect(apiKeyErrorJson).not.toContain(globalApiKey);
      expect(apiKeyError.reason).toBe("invalid-success-response");
    }),
  );
});

function registerRepairTest(description: string, initial: EmailRoutingDomainInspection) {
  it.effect(`repairs a ${description} exact registration`, () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const observations = [initial, initial, readyInspection];
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi(observations, mutations));

      const diff = yield* lifecycle.diff(identity, identity, {
        ...readyRegistration,
        apexEnabled: true,
      });
      const result = yield* lifecycle.reconcile(identity);

      expect(diff).toEqual({ action: "update" });
      expect(result).toEqual({ ...readyRegistration, apexEnabled: true });
      expect(mutations).toEqual([{ operation: "enable", identity }]);
    }),
  );
}

describe("Email Routing domain lifecycle", () => {
  it.effect("brands a cold exact-name match as unowned for explicit adoption", () =>
    Effect.gen(function* () {
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi([readyInspection], []));
      const observed = yield* lifecycle.read(identity, undefined);

      expect(observed).toEqual({ ...readyRegistration, apexEnabled: true });
      expect(Unowned.is(observed)).toBe(true);
    }),
  );

  it.effect("creates a missing domain and waits for exact DNS readiness", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([missingInspection, readyInspection], mutations),
      );

      const result = yield* lifecycle.reconcile(identity);

      expect(result).toEqual({ ...readyRegistration, apexEnabled: true });
      expect(mutations).toEqual([{ operation: "enable", identity }]);
    }),
  );

  registerRepairTest("disabled", disabledInspection);
  registerRepairTest("not DNS-ready", unreadyInspection);

  it.effect("leaves a healthy unchanged registration alone", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([readyInspection, readyInspection], mutations),
      );
      const output = { ...readyRegistration, apexEnabled: true };

      const diff = yield* lifecycle.diff(identity, identity, output);
      const result = yield* lifecycle.reconcile(identity);

      expect(diff).toBeUndefined();
      expect(result).toEqual(output);
      expect(mutations).toEqual([]);
    }),
  );

  it.effect("fails after the bounded readiness window", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const observations = Array.from({ length: 20 }, () => unreadyInspection);
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi(observations, mutations));

      const fiber = yield* lifecycle.reconcile(identity).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(EmailRoutingDomainNotReady);
      expect(mutations).toEqual([{ operation: "enable", identity }]);
    }),
  );

  it.effect("refreshes state when Cloudflare replaces the exact registration id", () =>
    Effect.gen(function* () {
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi([readyInspection], []));
      const staleOutput = {
        ...readyRegistration,
        subdomainId: "stale-routing-domain-id",
        apexEnabled: true,
      };

      const diff = yield* lifecycle.diff(identity, identity, staleOutput);

      expect(diff).toEqual({ action: "update" });
    }),
  );

  it.effect("replaces immutable zone/name identity changes without touching the API", () =>
    Effect.gen(function* () {
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi([], []));
      const output = { ...readyRegistration, apexEnabled: true };

      const renamed = yield* lifecycle.diff(
        identity,
        { ...identity, name: "renamed.umail.example.com" },
        output,
      );
      const moved = yield* lifecycle.diff(identity, { ...identity, zoneId: "zone-2" }, output);

      expect(renamed).toEqual({ action: "replace" });
      expect(moved).toEqual({ action: "replace" });
    }),
  );

  it.effect("disables only the exact domain and verifies apex plus sibling routing survive", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([readyInspection, missingInspection], mutations),
      );

      yield* lifecycle.delete({ ...readyRegistration, apexEnabled: true });

      expect(mutations).toEqual([{ operation: "disable", identity }]);
      expect(missingInspection.apexEnabled).toBe(true);
      expect(missingInspection.enabledNames).toEqual(["sibling-mail.umail.example.com"]);
    }),
  );

  it.effect("treats an already absent exact domain as deleted", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi([missingInspection], mutations));

      yield* lifecycle.delete({ ...readyRegistration, apexEnabled: true });

      expect(mutations).toEqual([]);
    }),
  );

  it.effect("fails removal if Cloudflare disables apex routing", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const apexDisabled = {
        zoneName,
        apexEnabled: false,
        enabledNames: ["sibling-mail.umail.example.com"],
        exact: undefined,
      } as const satisfies EmailRoutingDomainInspection;
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([readyInspection, apexDisabled], mutations),
      );

      const error = yield* lifecycle
        .delete({ ...readyRegistration, apexEnabled: true })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(EmailRoutingDomainRemovalUnsafe);
    }),
  );

  it.effect("fails removal if a sibling routing domain becomes disabled or disappears", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const siblingMissing = {
        zoneName,
        apexEnabled: true,
        enabledNames: [],
        exact: undefined,
      } as const satisfies EmailRoutingDomainInspection;
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([readyInspection, siblingMissing], mutations),
      );

      const error = yield* lifecycle
        .delete({ ...readyRegistration, apexEnabled: true })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(EmailRoutingDomainRemovalUnsafe);
    }),
  );

  it.effect("leaves a ready apex registration in place instead of enabling a child", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([apexReadyInspection, apexReadyInspection], mutations),
      );
      const output = { ...apexReadyRegistration, apexEnabled: true };

      const diff = yield* lifecycle.diff(apexIdentity, apexIdentity, output);
      const result = yield* lifecycle.reconcile(apexIdentity);

      expect(diff).toBeUndefined();
      expect(result).toEqual(output);
      expect(mutations).toEqual([]);
    }),
  );

  it.effect("repairs unready apex routing without child-domain enable or delete", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(
        fakeApi([apexUnreadyInspection, apexUnreadyInspection, apexReadyInspection], mutations),
      );

      const diff = yield* lifecycle.diff(apexIdentity, apexIdentity, {
        ...apexReadyRegistration,
        apexEnabled: true,
      });
      const result = yield* lifecycle.reconcile(apexIdentity);

      expect(diff).toEqual({ action: "update" });
      expect(result).toEqual({ ...apexReadyRegistration, apexEnabled: true });
      expect(mutations).toEqual([{ operation: "enable-apex", identity: apexIdentity }]);
    }),
  );

  it.effect("does not disable retained apex routing on delete", () =>
    Effect.gen(function* () {
      const mutations: Array<LifecycleMutation> = [];
      const lifecycle = makeEmailRoutingDomainLifecycle(fakeApi([apexReadyInspection], mutations));

      yield* lifecycle.delete({ ...apexReadyRegistration, apexEnabled: true });

      expect(mutations).toEqual([]);
    }),
  );
});
