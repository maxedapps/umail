import type { Principal } from "@umail/api-contract";
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
import { clientRoute, clientsRoute, revokeClientRoute, saveClientRoute } from "./pages/clients.ts";
import { composeRoute, sendRoute, sentRoute } from "./pages/compose.ts";
import { consentRoute } from "./pages/consent.ts";
import { deviceDecisionRoute, deviceRoute } from "./pages/device.ts";
import { loginPage } from "./pages/login.ts";
import {
  createMailboxRoute,
  forwardingRoute,
  mailboxesRoute,
  mailboxRoute,
  saveMailboxRoute,
} from "./pages/mailboxes.ts";
import {
  attachmentRoute,
  deleteThreadRoute,
  mailListRoute,
  markUnreadRoute,
  messageBodyRoute,
  threadRoute,
} from "./pages/mail.ts";
import { logout, withOperator } from "./session.ts";

// Every route that is not the REST API: Better Auth, MCP, the icon, and the browser pages.
export function webRoutes(deps: ApiDeps) {
  // A console route: the handler runs as the operator, or the browser is sent to sign in.
  const operator = <E extends { readonly _tag: string }, R>(
    handler: (
      deps: ApiDeps,
      principal: Principal,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => withOperator(deps, (principal) => handler(deps, principal));
  return Layer.mergeAll(
    HttpRouter.add("GET", "/icon.png", agentMailIconResponse),
    HttpRouter.add("GET", "/favicon.png", agentMailIconResponse),
    HttpRouter.add("*", "/mcp", serveMcpRequest(deps)),
    HttpRouter.add("*", "/jwks", serveBetterAuth(deps)),
    HttpRouter.add("*", "/api/auth/*", serveBetterAuth(deps)),
    HttpRouter.add("*", "/.well-known/*", serveBetterAuth(deps)),
    HttpRouter.add("GET", "/login", htmlResponse(200, loginPage())),
    HttpRouter.add("GET", "/consent", operator(consentRoute)),
    HttpRouter.add("POST", "/logout", logout(deps)),
    HttpRouter.add("GET", "/device", operator(deviceRoute)),
    HttpRouter.add(
      "POST",
      "/device/approve",
      operator((deps) => deviceDecisionRoute(deps, "approved")),
    ),
    HttpRouter.add(
      "POST",
      "/device/deny",
      operator((deps) => deviceDecisionRoute(deps, "denied")),
    ),
    HttpRouter.add("GET", "/clients", operator(clientsRoute)),
    HttpRouter.add("GET", "/clients/:clientId", operator(clientRoute)),
    HttpRouter.add("POST", "/clients/:clientId", operator(saveClientRoute)),
    HttpRouter.add("POST", "/clients/:clientId/revoke", operator(revokeClientRoute)),
    HttpRouter.add("GET", "/mail", operator(mailListRoute)),
    HttpRouter.add("GET", "/mailboxes", operator(mailboxesRoute)),
    HttpRouter.add("POST", "/mailboxes", operator(createMailboxRoute)),
    HttpRouter.add("GET", "/mailboxes/:id", operator(mailboxRoute)),
    HttpRouter.add("POST", "/mailboxes/:id", operator(saveMailboxRoute)),
    HttpRouter.add("POST", "/mailboxes/:id/forwarding", operator(forwardingRoute)),
    HttpRouter.add("GET", "/mail/compose", operator(composeRoute)),
    HttpRouter.add("POST", "/mail/compose", operator(sendRoute)),
    HttpRouter.add("GET", "/mail/sent/:jobId", operator(sentRoute)),
    HttpRouter.add("GET", "/mail/threads/:threadId", operator(threadRoute)),
    HttpRouter.add("POST", "/mail/threads/:threadId/unread", operator(markUnreadRoute)),
    HttpRouter.add("POST", "/mail/threads/:threadId/delete", operator(deleteThreadRoute)),
    HttpRouter.add("GET", "/mail/messages/:messageId/body", operator(messageBodyRoute)),
    HttpRouter.add(
      "GET",
      "/mail/messages/:messageId/attachments/:attachmentId",
      operator(attachmentRoute),
    ),
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
