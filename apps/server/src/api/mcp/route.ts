import { type McpPrincipal, type Principal } from "@umail/api-contract";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { agentMailMcpServerInfo } from "../brand/identity.ts";
import type { ApiDeps } from "../app.ts";
import { UMAIL_OAUTH_SCOPE } from "../../auth/options.ts";
import {
  oauthResourceChallenge,
  verifyOAuthResourceRequest,
  type OAuthAccess,
} from "../../auth/oauth-resource.ts";
import { registerTools } from "./tools.ts";

const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;

export function serveMcpRequest(deps: ApiDeps) {
  return Effect.gen(function* () {
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
    const accessResult = yield* Effect.promise(async () => {
      try {
        const access = await verifyOAuthResourceRequest(deps.auth, webRequest, {
          issuer: `${deps.applicationUrl.origin}/api/auth`,
          audience: resource,
          scopes: [UMAIL_OAUTH_SCOPE],
        });
        return { kind: "verified", access } as const;
      } catch (error) {
        return { kind: "rejected", response: mcpChallengeResponse(error, resource) } as const;
      }
    });
    if (accessResult.kind === "rejected") {
      return HttpServerResponse.fromWeb(accessResult.response);
    }

    const principalResult = yield* Effect.result(mcpPrincipalForAccess(deps, accessResult.access));
    if (Result.isFailure(principalResult)) {
      return HttpServerResponse.fromWeb(jsonRpcError(403, "Forbidden"));
    }
    return yield* serveAuthenticatedMcp(
      deps,
      principalResult.success,
      accessResult.access,
      webRequest,
    );
  });
}

// Only the operator's grants count, and only while the operator's consent for the client has a
// policy; anything else is 403.
function mcpPrincipalForAccess(deps: ApiDeps, access: OAuthAccess) {
  return Effect.gen(function* () {
    const policy =
      access.subject === deps.operatorId ? yield* deps.access.mcpPolicy(access.clientId) : null;
    if (policy === null) return yield* Effect.fail("forbidden" as const);
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
}

function serveAuthenticatedMcp(
  deps: ApiDeps,
  principal: Principal,
  access: OAuthAccess,
  request: Request,
) {
  return Effect.gen(function* () {
    const services = yield* Effect.context();
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
}

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
