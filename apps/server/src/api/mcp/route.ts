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
  revokedAccess,
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
  // RFC 6750 §3.1: only a Bearer token that was sent can be "invalid"; no token or another
  // scheme gets the plain challenge.
  const tokenSent = /^Bearer\s/i.test(webRequest.headers.get("authorization") ?? "");
  if (Result.isFailure(verified)) {
    return HttpServerResponse.fromWeb(mcpChallengeResponse(verified.failure, resource, tokenSent));
  }

  const principal = yield* mcpPrincipalForAccess(deps, verified.success);
  if (principal === "revoked") {
    return HttpServerResponse.fromWeb(mcpChallengeResponse(revokedAccess(), resource, true));
  }
  if (principal === "no_policy") {
    return HttpServerResponse.fromWeb(
      jsonRpcError(
        403,
        "This client is connected but has no access policy. Ask the operator to configure it under Clients.",
      ),
    );
  }
  return yield* serveAuthenticatedMcp(deps, principal, verified.success, webRequest);
});

// Only the operator's grants count. A token without one (revoked, or from a former operator) is
// answered as an invalid token so the client re-authorizes; a consent still waiting for its policy
// is a plain 403.
const mcpPrincipalForAccess = Effect.fn("mcpPrincipalForAccess")(function* (
  deps: ApiDeps,
  access: OAuthAccess,
) {
  if (access.subject !== deps.operatorId) return "revoked";
  const grant = yield* deps.access.mcpGrant(access.clientId);
  if (grant.kind === "none") return "revoked";
  if (grant.kind === "no_policy") return "no_policy";
  const policy = grant.policy;
  return {
    authority: "mcp",
    identity: {
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

function mcpChallengeResponse(error: unknown, resource: string, tokenSent: boolean): Response {
  const challenge = oauthResourceChallenge(error, resource, [UMAIL_OAUTH_SCOPE], tokenSent);
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
