import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { LegacyCatchAllProvider } from "../../src/mail/legacy-catch-all.ts";

const output: Cloudflare.Email.CatchAll["Attributes"] = {
  ruleId: "catch-all",
  zoneId: "zone",
  name: "existing",
  enabled: true,
  actions: [{ type: "worker", value: ["umail-prod"] }],
  initialName: "",
  initialEnabled: false,
  initialActions: [{ type: "drop" }],
};
const props = { zone: "zone", actions: output.actions };
const session: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  note: () => Effect.void,
  done: () => Effect.void,
};
const input = {
  id: "MailCatchAll",
  fqn: "MailCatchAll",
  instanceId: "instance",
  olds: props,
  news: props,
  output,
  session,
  bindings: [],
};

function fixture(mode: "owned" | "disabled" | "foreign") {
  const requests: Array<string> = [];
  const http = HttpClient.make((request) => {
    requests.push(request.method);
    if (request.method !== "GET")
      return Effect.die("The transitional provider must never write a catch-all");
    const result =
      mode === "disabled"
        ? { enabled: false, actions: [{ type: "drop" }] }
        : {
            enabled: true,
            actions: [{ type: "worker", value: [mode === "owned" ? "umail-prod" : "foreign"] }],
          };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  const layer = LegacyCatchAllProvider.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          Cloudflare.Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("fixture-token"),
            apiBaseUrl: "https://cloudflare.invalid/client/v4",
          }),
        ),
      ),
    ),
  );
  return { layer, requests };
}

describe("transitional catch-all ownership", () => {
  it.effect("preserves an owned route and refuses new catch-all creation", () =>
    Effect.gen(function* () {
      const f = fixture("owned");
      yield* Effect.gen(function* () {
        const provider = yield* Provider.findProvider(Cloudflare.Email.CatchAll);
        expect(yield* provider.reconcile(input)).toEqual(output);
        const failure = yield* provider
          .reconcile({ ...input, output: undefined, olds: undefined })
          .pipe(Effect.flip);
        expect(failure.message).toContain("stored MailCatchAll ownership");
      }).pipe(Effect.provide(f.layer));
      expect(f.requests).toEqual(["GET"]);
    }),
  );

  it.effect(
    "never re-enables a cut-over catch-all and forgets it without restoring old settings",
    () =>
      Effect.gen(function* () {
        const f = fixture("disabled");
        yield* Effect.gen(function* () {
          const provider = yield* Provider.findProvider(Cloudflare.Email.CatchAll);
          if (provider.read === undefined) return yield* Effect.die("Missing provider read");
          expect(yield* provider.read(input)).toMatchObject({ enabled: false });
          yield* provider.reconcile(input);
          yield* provider.delete(input);
        }).pipe(Effect.provide(f.layer));
        expect(f.requests).toEqual(["GET", "GET", "GET"]);
      }),
  );

  it.effect("refuses a foreign catch-all and deletion of a still-active route", () =>
    Effect.gen(function* () {
      for (const mode of ["foreign", "owned"] as const) {
        const f = fixture(mode);
        yield* Effect.gen(function* () {
          const provider = yield* Provider.findProvider(Cloudflare.Email.CatchAll);
          const failure = yield* (
            mode === "foreign" ? provider.reconcile(input) : provider.delete(input)
          ).pipe(Effect.flip);
          expect(failure._tag).toBe("ReceivingDomainUnsafe");
        }).pipe(Effect.provide(f.layer));
        expect(f.requests).toEqual(["GET"]);
      }
    }),
  );
});
