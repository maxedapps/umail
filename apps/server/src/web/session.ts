import { operatorPrincipal, type Principal } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { ApiDeps } from "../api/app.ts";
import { cookieMutationAllowed } from "../auth/runtime-surface.ts";
import { htmlResponse, redirect } from "./document.ts";
import { noticePage } from "./pages/notice.ts";

// The client id and label the operator's browser session acts as, e.g. on the jobs it submits.
export const UMAIL_WEB_CLIENT_ID = "umail-web";

// Runs a console handler as the operator: a POST must come from this origin, the browser must be
// signed in (or is sent to the login page and back), and the user must be the operator. The
// handler's expected failures become notice pages.
export function withOperator<E extends { readonly _tag: string }, R>(
  deps: Pick<ApiDeps, "auth" | "applicationUrl" | "operatorId">,
  handler: (principal: Principal) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    if (
      request.method === "POST" &&
      !cookieMutationAllowed(webRequest, deps.applicationUrl.origin)
    ) {
      return yield* failurePage(403, "This form was sent from another site.");
    }
    const auth = yield* deps.auth.auth;
    const session = yield* Effect.promise(() =>
      auth.api.getSession({ headers: webRequest.headers }),
    );
    if (session === null) {
      return redirect(`/login?next=${encodeURIComponent(request.url)}`);
    }
    if (session.user.id !== deps.operatorId) {
      return yield* failurePage(403, "Only the AgentMail operator can use this page.");
    }
    const principal = operatorPrincipal(session.user.id, UMAIL_WEB_CLIENT_ID, "AgentMail web");
    return yield* handler(principal).pipe(Effect.catch((error: E) => failureResponse(error)));
  });
}

function failureResponse(error: { readonly _tag: string; readonly message?: unknown }) {
  switch (error._tag) {
    case "NotFound":
      return failurePage(404, "That page or item does not exist.");
    case "Forbidden":
      return failurePage(403, "That is not allowed.");
    case "Conflict":
      return failurePage(409, "That conflicts with the current state. Reload and try again.");
    case "ApiProblem":
      return failurePage(400, typeof error.message === "string" ? error.message : "That failed.");
    case "BadRequest":
    case "SchemaError":
    case "HttpServerError":
      return failurePage(400, "The request could not be read.");
    default:
      return failurePage(500, "Something went wrong. Try again.");
  }
}

export function failurePage(status: 400 | 403 | 404 | 409 | 500, message: string) {
  return htmlResponse(
    status,
    noticePage({
      title: "Request failed",
      heading: "The request could not be completed",
      message,
      tone: "error",
    }),
  );
}

// Signing out needs no session: without one there is nothing to end.
export const logout = Effect.fn("logout")(function* (
  deps: Pick<ApiDeps, "auth" | "applicationUrl">,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  if (!cookieMutationAllowed(webRequest, deps.applicationUrl.origin)) {
    return yield* failurePage(403, "This form was sent from another site.");
  }
  const auth = yield* deps.auth.auth;
  const signedOut = yield* Effect.promise(() =>
    auth.api.signOut({ headers: webRequest.headers, asResponse: true }),
  );
  const response = new Response(null, {
    status: 303,
    headers: { location: "/login", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  for (const cookie of signedOut.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return HttpServerResponse.fromWeb(response);
});
