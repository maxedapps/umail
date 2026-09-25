import { type McpPrincipal, type Principal, UMAIL_OAUTH_SCOPE } from "@umail/api-contract";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type * as Alchemy from "alchemy";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { agentMailMcpServerInfo } from "../brand/identity.ts";
import type { ApiDeps } from "../app.ts";
import {
  oauthResourceChallenge,
  verifyOAuthResourceRequest,
  type OAuthAccess,
} from "../../auth/oauth-resource.ts";
import { registerTools } from "./tools.ts";

const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;

export const serveMcpRequest = Effect.fn("serveMcpRequest")(function* (deps: ApiDeps) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequestResult = HttpServerRequest.toWebResult(request);
  if (Result.isFailure(webRequestResult)) {
    return yield* new HttpServerError({ reason: webRequestResult.failure });
  }
  const webRequest = webRequestResult.success;
  if (webRequest.method !== "POST") {
    return HttpServerResponse.fromWeb(new Response(null, { status: 405 }));
  }

  const resource = `${deps.applicationUrl.origin}/mcp`;
  const verified = yield* Effect.result(
    verifyOAuthResourceRequest(deps.auth, webRequest, {
      issuer: `${deps.applicationUrl.origin}/api/auth`,
      audience: resource,
      scopes: [UMAIL_OAUTH_SCOPE],
    }),
  );
  if (Result.isFailure(verified)) {
    return HttpServerResponse.fromWeb(mcpChallengeResponse(verified.failure, resource));
  }

  const principal = yield* mcpPrincipalForAccess(deps, verified.success);
  if (principal === null) {
    return HttpServerResponse.fromWeb(jsonRpcError(403, "Forbidden"));
  }
  return yield* serveAuthenticatedMcp(deps, principal, verified.success, webRequest);
});

// Only the operator's grants count, and only while the operator's consent for the client has a
// policy; anything else is no principal.
const mcpPrincipalForAccess = Effect.fn("mcpPrincipalForAccess")(function* (
  deps: ApiDeps,
  access: OAuthAccess,
) {
  if (access.subject !== deps.operatorId) return null;
  const policy = yield* deps.access.mcpPolicy(access.clientId);
  if (policy === null) return null;
  return {
    authority: "mcp",
    identity: {
      kind: "oauth",
      userId: access.subject,
      clientId: access.clientId,
      clientLabel: `OAuth client ${access.clientId.slice(0, 12)}`,
    },
    policy,
  } satisfies McpPrincipal;
});

const serveAuthenticatedMcp = Effect.fn("serveAuthenticatedMcp")(function* (
  deps: ApiDeps,
  principal: Principal,
  access: OAuthAccess,
  request: Request,
) {
  const services = yield* Effect.context<Crypto.Crypto | Alchemy.RuntimeContext>();
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(agentMailMcpServerInfo(deps.applicationUrl.origin), {
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS],
      });
      registerTools(server, deps, principal, services);
      return server;
    },
    { legacy: "stateless" },
  );
  const response = yield* Effect.promise(() =>
    handler.fetch(request, {
      authInfo: {
        token: access.clientId,
        clientId: access.clientId,
        scopes: Array.from(access.scopes),
      } satisfies AuthInfo,
    }),
  ).pipe(Effect.ensuring(Effect.promise(() => handler.close())));
  return HttpServerResponse.fromWeb(response);
});

function mcpChallengeResponse(error: unknown, resource: string): Response {
  const challenge = oauthResourceChallenge(error, resource, [UMAIL_OAUTH_SCOPE]);
  if (challenge === undefined) return jsonRpcError(401, "Unauthorized");
  return jsonRpcError(challenge.statusCode, challenge.message, new Headers(challenge.headers));
}

function jsonRpcError(status: number, message: string, headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status, headers },
  );
}
