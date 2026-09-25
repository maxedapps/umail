import { OFFLINE_ACCESS_SCOPE, UMAIL_OAUTH_SCOPE } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { productPageTitle } from "../api/brand/identity.ts";
import { renderHumanPageNotice } from "../api/human-pages/notices.ts";
import {
  renderClientsPage,
  renderDeviceAuthorizationPage,
  renderDeviceDecisionPage,
} from "../api/human-pages/oauth-management.ts";
import { humanPageHeaders } from "../api/human-pages/response.ts";
import { policyFromForm, type Access } from "./access.ts";
import { type UmailAuthInstance } from "./options.ts";
import { cookieMutationAllowed } from "./runtime-surface.ts";

const DeviceDecisionForm = Schema.Struct({ userCode: Schema.String });

export type OAuthRouteDependencies = {
  readonly auth: UmailAuthInstance;
  readonly access: Access;
  readonly applicationUrl: URL;
  readonly operatorId: string;
};

export function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === "/device" ||
    pathname === "/device/approve" ||
    pathname === "/device/deny" ||
    pathname === "/clients" ||
    pathname.startsWith("/clients/")
  );
}

export const serveOAuthRoute = Effect.fn("serveOAuthRoute")(function* (
  deps: OAuthRouteDependencies,
  request: Request,
) {
  const url = new URL(request.url);
  const mutation = request.method === "POST";
  const policyMatch = /^\/clients\/([^/]+)\/policy$/.exec(url.pathname);
  const revokeMatch = /^\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
  const route =
    url.pathname === "/device" && request.method === "GET"
      ? deviceRoute(deps, request)
      : url.pathname === "/device/approve" && mutation
        ? deviceDecisionRoute(deps, request, "approved")
        : url.pathname === "/device/deny" && mutation
          ? deviceDecisionRoute(deps, request, "denied")
          : url.pathname === "/clients" && request.method === "GET"
            ? clientsRoute(deps)
            : policyMatch !== null && mutation
              ? updateClientPolicyRoute(deps, request, decodeURIComponent(policyMatch[1] ?? ""))
              : revokeMatch !== null && mutation
                ? revokeClientRoute(deps, decodeURIComponent(revokeMatch[1] ?? ""))
                : null;
  if (route === null) {
    return new Response(null, { status: 405 });
  }
  if (mutation && !cookieMutationAllowed(request, deps.applicationUrl.origin)) {
    return humanError("Forbidden.", 403);
  }
  const session = yield* operatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  return yield* route;
});

// Every OAuth management page belongs to the operator's signed-in session.
const operatorSession = Effect.fn("operatorSession")(function* (
  deps: OAuthRouteDependencies,
  request: Request,
) {
  const auth = yield* deps.auth.auth;
  const session = yield* Effect.promise(() => auth.api.getSession({ headers: request.headers }));
  if (session === null) {
    return { kind: "redirect", response: loginRedirect(request) } as const;
  }
  if (session.user.id !== deps.operatorId) {
    return { kind: "forbidden", response: humanError("Forbidden.", 403) } as const;
  }
  return { kind: "authorized" } as const;
});

const deviceRoute = Effect.fn("deviceRoute")(function* (
  deps: OAuthRouteDependencies,
  request: Request,
) {
  const userCode = new URL(request.url).searchParams.get("user_code");
  if (userCode === null || userCode.length === 0) {
    return humanError("Enter the complete verification URL shown by the CLI.", 400);
  }
  const auth = yield* deps.auth.auth;
  const resource = deps.applicationUrl.origin;
  return yield* Effect.tryPromise(() =>
    auth.api.deviceVerify({ headers: request.headers, query: { user_code: userCode } }),
  ).pipe(
    Effect.filterOrFail((verified) => deviceRequestAdmitted(verified, resource)),
    Effect.map((verified) =>
      humanResponse(
        renderDeviceAuthorizationPage({
          userCode: verified.user_code,
          clientId: verified.client_id,
          scope: verified.scope ?? "",
          resource,
        }),
      ),
    ),
    Effect.orElseSucceed(() =>
      humanError("This device code is invalid, expired, or requests unsupported access.", 400),
    ),
  );
});

const deviceDecisionRoute = Effect.fn("deviceDecisionRoute")(function* (
  deps: OAuthRouteDependencies,
  request: Request,
  decision: "approved" | "denied",
) {
  const auth = yield* deps.auth.auth;
  return yield* Effect.gen(function* () {
    const fields = Object.fromEntries(yield* Effect.tryPromise(() => request.formData()));
    const form = yield* Schema.decodeUnknownEffect(DeviceDecisionForm)(fields);
    yield* Effect.tryPromise(() =>
      auth.api.deviceVerify({ headers: request.headers, query: { user_code: form.userCode } }),
    ).pipe(
      Effect.filterOrFail((verified) =>
        deviceRequestAdmitted(verified, deps.applicationUrl.origin),
      ),
    );
    yield* Effect.tryPromise(() =>
      decision === "approved"
        ? auth.api.deviceApprove({ headers: request.headers, body: { userCode: form.userCode } })
        : auth.api.deviceDeny({ headers: request.headers, body: { userCode: form.userCode } }),
    );
    return humanResponse(renderDeviceDecisionPage(decision));
  }).pipe(
    Effect.orElseSucceed(() =>
      humanError("This device code is invalid, expired, or already processed.", 400),
    ),
  );
});

const clientsRoute = Effect.fn("clientsRoute")(function* (deps: OAuthRouteDependencies) {
  return humanResponse(renderClientsPage(yield* deps.access.list()));
});

const updateClientPolicyRoute = Effect.fn("updateClientPolicyRoute")(function* (
  deps: OAuthRouteDependencies,
  request: Request,
  consentId: string,
) {
  const form = yield* Effect.promise(() => request.formData());
  const policy = policyFromForm({
    mailboxes: form.get("mailboxes"),
    sendMode: form.get("sendMode"),
    canRead: form.has("canRead"),
    recipients: form.get("recipients"),
    preapproved: form.get("preapproved"),
  });
  if (policy === null) return humanError("Could not read that policy.", 400);
  const updated = yield* deps.access.setPolicy(consentId, policy);
  if (!updated) return humanError("That client has no consent to update.", 404);
  return redirectResponse("/clients?updated=1");
});

const revokeClientRoute = Effect.fn("revokeClientRoute")(function* (
  deps: OAuthRouteDependencies,
  clientId: string,
) {
  yield* deps.access.revoke(clientId);
  return redirectResponse("/clients?revoked=1");
});

// A device request must target the REST resource with the CLI's scopes, or it is refused.
function deviceRequestAdmitted(
  verified: { readonly resource?: string | string[] | undefined; readonly scope?: string | null },
  expected: string,
): boolean {
  const resource = verified.resource;
  const values = Array.isArray(resource) ? resource : resource === undefined ? [] : [resource];
  const scopes = new Set((verified.scope ?? "").split(" ").filter((value) => value.length > 0));
  return (
    values.length === 1 &&
    values[0] === expected &&
    scopes.has(UMAIL_OAUTH_SCOPE) &&
    scopes.has(OFFLINE_ACCESS_SCOPE)
  );
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return redirectResponse(`/login?next=${encodeURIComponent(next)}`);
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function humanResponse(page: ReturnType<typeof renderClientsPage>): Response {
  return new Response(page.html, { status: page.status, headers: humanPageHeaders(page) });
}

function humanError(message: string, status: 400 | 403 | 404): Response {
  const page = renderHumanPageNotice({
    status,
    title: productPageTitle("OAuth request failed"),
    eyebrow: "OAuth",
    heading: "The request could not be completed",
    description: "AgentMail stopped before granting or changing access.",
    message,
    tone: "error",
  });
  return new Response(page.html, { status, headers: humanPageHeaders(page) });
}
