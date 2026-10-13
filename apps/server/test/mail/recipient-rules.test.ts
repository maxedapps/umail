import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { RecipientRules } from "../../src/mail/recipient-rules.ts";
import type { GetRuleResponse } from "@distilled.cloud/cloudflare/email-routing";
import { MailDomain } from "@umail/api-contract";
import { applyAccountSchema } from "../../src/account/commands.ts";
import { createAddress, retireAddress } from "../../src/account/administration.ts";
import { reconcileDueRecipientRoutes } from "../../src/account/recipient-routing.ts";
import { MemoryAccountSqliteStorage } from "../api/memory-account-store.ts";

interface CloudflareFailure {
  readonly code: number;
  readonly message: string;
}

function fixture(status = 200, missingId = false, failure?: CloudflareFailure) {
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const http = HttpClient.make((request, url) => {
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });
    const page = Number(url.searchParams.get("page") ?? "1");
    const rule: GetRuleResponse = { name: `owner-${page}` };
    if (!missingId) rule.id = `page-${page}`;
    const body =
      status === 200
        ? {
            success: true,
            result: page > 2 ? [] : [rule],
            errors: [],
            messages: [],
            result_info: { page, total_pages: 2, count: page > 2 ? 0 : 1, total_count: 2 },
          }
        : {
            success: false,
            errors: [
              failure ?? {
                code: status === 403 ? 9109 : 1015,
                message:
                  status === 403 ? "Unauthorized to access requested resource" : "rate limited",
              },
            ],
            messages: [],
          };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  const layer = RecipientRules.layerNoDeps.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ CF_EMAIL_ROUTING_RULES_TOKEN: "rules-only-secret" }),
        ),
      ),
    ),
  );
  return { requests, layer };
}

describe("scoped recipient rules client", () => {
  it.effect.each([
    { operation: "create", transient: true },
    { operation: "retire", transient: true },
    { operation: "create", transient: false },
    { operation: "retire", transient: false },
  ])(
    "persists SDK-classified auth retry intent: $operation, transient=$transient",
    ({ operation, transient }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const storage = new MemoryAccountSqliteStorage();
          yield* Effect.addFinalizer(() => Effect.sync(() => storage.close()));
          const now = "2026-01-01T00:00:00.000Z";
          const domain = MailDomain.make("mail.example.com");
          applyAccountSchema(storage, now);
          createAddress(storage, "mailbox", "inbox", domain, undefined, now, true);
          if (operation === "retire") {
            storage.sql.exec("UPDATE mailbox_routes SET rule_id = 'owned-rule', zone_id = 'zone'");
            retireAddress(storage, "mailbox", now);
          }
          const f = fixture(
            403,
            false,
            transient
              ? { code: 10000, message: "Authentication error" }
              : { code: 9109, message: "Unauthorized to access requested resource" },
          );
          yield* Effect.gen(function* () {
            const client = yield* RecipientRules;
            yield* reconcileDueRecipientRoutes(
              storage,
              {
                client,
                domains: [{ name: domain, receive: true, send: true, zoneId: "zone" }],
                workerName: "worker",
                ownerPrefix: "umail/uMail/test/",
                legacySeeds: [],
              },
              Date.parse(now),
            );
          }).pipe(Effect.provide(f.layer));
          const row = storage.sql
            .exec("SELECT state, error, retry_after FROM mailbox_routes")
            .toArray()[0];
          expect(row).toMatchObject({
            state: "error",
            retry_after: transient ? "2026-01-01T00:01:00.000Z" : null,
          });
          if (transient) expect(row?.error).not.toContain("Give it Email Routing Rules Write");
          else expect(row?.error).toContain("CF_EMAIL_ROUTING_RULES_TOKEN");
          expect(f.requests).toHaveLength(1);
        }),
      ),
  );

  it.effect("inspects every page through the SDK with the scoped credential", () =>
    Effect.gen(function* () {
      const f = fixture();
      const rules = yield* Effect.gen(function* () {
        return yield* (yield* RecipientRules).list("zone");
      }).pipe(Effect.provide(f.layer));
      expect(rules.map(({ id }) => id)).toEqual(["page-1", "page-2"]);
      expect(f.requests).toHaveLength(3);
      expect(
        f.requests.every(
          (request) =>
            request.method === "GET" &&
            request.path.startsWith("/client/v4/zones/zone/email/routing/rules") &&
            request.authorization === "Bearer rules-only-secret",
        ),
      ).toBe(true);
    }),
  );

  it.effect.each([403, 429])(
    "does not hide retries for status %s and distinguishes credentials from rate limits",
    (status) =>
      Effect.gen(function* () {
        const f = fixture(status);
        const error = yield* Effect.gen(function* () {
          return yield* (yield* RecipientRules).list("zone");
        }).pipe(Effect.provide(f.layer), Effect.catchTag("ConfigError", Effect.die), Effect.flip);
        expect(f.requests).toHaveLength(1);
        expect(error.retryable).toBe(status === 429);
        expect(error.message).not.toContain("rules-only-secret");
        if (status === 403) expect(error.message).toContain("CF_EMAIL_ROUTING_RULES_TOKEN");
      }),
  );

  it.effect("rejects an unidentifiable rule instead of treating absence as ownership", () =>
    Effect.gen(function* () {
      const f = fixture(200, true);
      const error = yield* Effect.gen(function* () {
        return yield* (yield* RecipientRules).list("zone");
      }).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.message).toContain("without an ID");
    }),
  );
});
