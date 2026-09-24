import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  ApprovalPageGone,
  ApprovalPageNotFound,
  PublicApprovalApi,
  UmailApi,
} from "../src/api-spec.ts";
import { makePublicApprovalClient, umailBaseUrl } from "../src/client.ts";

const TOKEN = "a".repeat(64);
const TRUSTED_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "content-type": "text/html; charset=utf-8",
  "permissions-policy": "camera=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

type CapturedApprovalRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
};

function approvalHttpClient(
  captured: Array<CapturedApprovalRequest>,
  responseForPath: (pathname: string) => Response,
) {
  return HttpClient.make((request, url) => {
    captured.push({
      method: request.method,
      pathname: url.pathname,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseForPath(url.pathname)));
  });
}

function redirectServerLayer(observed: Array<string>) {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = new URL(request.url, "http://localhost").pathname;
    observed.push(`${request.method} ${pathname}`);
    if (pathname === "/followed") {
      return HttpServerResponse.text("redirect was followed", { status: 500 });
    }
    return HttpServerResponse.empty({
      status: 303,
      headers: {
        location: "/followed",
        "x-umail-approval-state": "denied",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  });
  return Layer.effectDiscard(HttpServer.serveEffect(handler)).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
}

describe("public approval API contract", () => {
  it("declares only the canonical public GET and POST routes outside the bearer API", () => {
    const endpoints = Object.values(PublicApprovalApi.groups.PublicApprovals.endpoints).map(
      (endpoint) => ({ method: endpoint.method, path: endpoint.path }),
    );

    expect(endpoints).toEqual([
      { method: "GET", path: "/approvals/:token" },
      { method: "GET", path: "/approvals/:token/message" },
      { method: "POST", path: "/approvals/:token/approve" },
      { method: "POST", path: "/approvals/:token/deny" },
    ]);
    expect(UmailApi.groups).not.toHaveProperty("PublicApprovals");
  });

  it("uses only UMAIL_URL and sends neither bearer nor global JSON headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = {
          baseUrl: yield* baseUrlFrom({ UMAIL_URL: "https://umail.example.test/" }),
        };
        const captured: Array<CapturedApprovalRequest> = [];
        const client = yield* makePublicApprovalClient(
          config,
          approvalHttpClient(
            captured,
            (pathname) =>
              new Response(null, {
                status: 303,
                headers: {
                  location: `https://umail.example.test${pathname.slice(0, -"/approve".length)}`,
                  "x-umail-approval-state": "approved",
                  "cache-control": "no-store",
                  "referrer-policy": "no-referrer",
                },
              }),
          ),
        );

        const result = yield* client.PublicApprovals.approveApproval({ params: { token: TOKEN } });

        expect(result.body).toBeUndefined();
        expect(result.headers).toMatchObject({
          location: `https://umail.example.test/approvals/${TOKEN}`,
          "x-umail-approval-state": "approved",
        });
        expect(captured).toEqual([
          {
            method: "POST",
            pathname: `/approvals/${TOKEN}/approve`,
            authorization: undefined,
            contentType: undefined,
          },
        ]);
      }),
    ));

  it("keeps a real Fetch client on the decision 303 and exposes its headers", () => {
    const observed: Array<string> = [];
    return Effect.runPromise(
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = yield* makePublicApprovalClient({ baseUrl: "" }, httpClient);
        const result = yield* client.PublicApprovals.denyApproval({ params: { token: TOKEN } });

        expect(result.headers.location).toBe("/followed");
        expect(result.headers["x-umail-approval-state"]).toBe("denied");
        expect(observed).toEqual([`POST /approvals/${TOKEN}/deny`]);
      }).pipe(Effect.provide(redirectServerLayer(observed))),
    );
  });

  it("decodes styled 404 and 410 responses into owner-specific errors", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const fixture of [
          { status: 404, ErrorType: ApprovalPageNotFound },
          { status: 410, ErrorType: ApprovalPageGone },
        ] as const) {
          const client = yield* makePublicApprovalClient(
            { baseUrl: "https://umail.example.test" },
            approvalHttpClient(
              [],
              () =>
                new Response(`<p>${fixture.status}</p>`, {
                  status: fixture.status,
                  headers: TRUSTED_HEADERS,
                }),
            ),
          );

          const error = yield* Effect.flip(
            client.PublicApprovals.reviewApproval({ params: { token: TOKEN } }),
          );
          const approvalError = yield* Schema.decodeUnknownEffect(
            Schema.Union([ApprovalPageNotFound, ApprovalPageGone]),
          )(error);
          expect(approvalError).toBeInstanceOf(fixture.ErrorType);
          expect(approvalError.html).toBe(`<p>${fixture.status}</p>`);
          expect(approvalError.headers["cache-control"]).toBe("no-store");
        }
      }),
    ));

  it("rejects missing, non-origin, and non-HTTP public client URLs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const missing = yield* Effect.flip(baseUrlFrom({}));
        expect(missing.message).toBe("UMAIL_URL is required");
        const path = yield* Effect.flip(
          baseUrlFrom({
            UMAIL_URL: "https://umail.example.test/api",
          }),
        );
        expect(path.message).toBe("UMAIL_URL must be a valid HTTP(S) origin");
        const protocol = yield* Effect.flip(baseUrlFrom({ UMAIL_URL: "file:///tmp/umail" }));
        expect(protocol.message).toBe("UMAIL_URL must be a valid HTTP(S) origin");
      }),
    ));
});

// Reads UMAIL_URL from the given environment instead of the process's.
function baseUrlFrom(env: Record<string, string>) {
  return umailBaseUrl.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );
}
