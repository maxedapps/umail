import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { ApiDeps } from "../api/app.ts";
import { agentMailIconResponse } from "../api/brand/identity.ts";
import { serveMcpRequest } from "../api/mcp/route.ts";
import { blockedAuthSurfaceResponse } from "../auth/runtime-surface.ts";
import { htmlResponse } from "./document.ts";
import { clientsRoute, revokeClientRoute, updateClientPolicyRoute } from "./pages/clients.ts";
import { consentPage } from "./pages/consent.ts";
import { deviceDecisionRoute, deviceRoute } from "./pages/device.ts";
import { loginPage } from "./pages/login.ts";
import { logout, withOperator } from "./session.ts";

// Every route that is not the REST API: Better Auth, MCP, the icon, and the browser pages.
export function webRoutes(deps: ApiDeps) {
  const operator = <E extends { readonly _tag: string }, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => withOperator(deps, () => handler);
  return Layer.mergeAll(
    HttpRouter.add("GET", "/icon.png", agentMailIconResponse),
    HttpRouter.add("GET", "/favicon.png", agentMailIconResponse),
    HttpRouter.add("*", "/mcp", serveMcpRequest(deps)),
    HttpRouter.add("*", "/jwks", serveBetterAuth(deps)),
    HttpRouter.add("*", "/api/auth/*", serveBetterAuth(deps)),
    HttpRouter.add("*", "/.well-known/*", serveBetterAuth(deps)),
    HttpRouter.add("GET", "/login", htmlResponse(200, loginPage())),
    HttpRouter.add("GET", "/consent", htmlResponse(200, consentPage())),
    HttpRouter.add("POST", "/logout", logout(deps)),
    HttpRouter.add("GET", "/device", operator(deviceRoute(deps))),
    HttpRouter.add("POST", "/device/approve", operator(deviceDecisionRoute(deps, "approved"))),
    HttpRouter.add("POST", "/device/deny", operator(deviceDecisionRoute(deps, "denied"))),
    HttpRouter.add("GET", "/clients", operator(clientsRoute(deps))),
    HttpRouter.add("POST", "/clients/:consentId/policy", operator(updateClientPolicyRoute(deps))),
    HttpRouter.add("POST", "/clients/:clientId/revoke", operator(revokeClientRoute(deps))),
  );
}

const serveBetterAuth = Effect.fn("serveBetterAuth")(function* (deps: ApiDeps) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  const blocked = blockedAuthSurfaceResponse(webRequest);
  if (blocked !== null) {
    return HttpServerResponse.fromWeb(blocked);
  }
  const auth = yield* deps.auth.auth;
  const response = yield* Effect.promise(() => auth.handler(webRequest));
  return HttpServerResponse.fromWeb(response);
});
