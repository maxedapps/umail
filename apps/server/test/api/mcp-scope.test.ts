import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { operatorOAuthPrincipal } from "@umail/api-contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";

import type { ApiDeps } from "../../src/api/app.ts";
import { registerTools } from "../../src/api/mcp/tools.ts";
import { createWorld } from "./world.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

describe("MCP tool request services", () => {
  it("runs umail_list_sending_identities with the request Scope passed to registerTools", async () => {
    const deps = await scopeOracleDeps();
    const scope = await Effect.runPromise(Scope.make());
    try {
      const result = await callListSendingIdentities(deps, Context.make(Scope.Scope, scope));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ sendingIdentities: [] });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("answers a generic failure and logs the defect when the request Scope is missing", async () => {
    const deps = await scopeOracleDeps();
    const messages: Array<unknown> = [];
    const capture = Logger.make(({ message }) => {
      messages.push(message);
    });
    const result = await callListSendingIdentities(
      deps,
      Context.make(Logger.CurrentLoggers, new Set([capture])),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("The AgentMail API request failed.");
    expect(JSON.stringify(result)).not.toContain("Service not found");
    expect(messages).toEqual([["MCP tool failed"]]);
  });
});

function eraseServices<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> {
  return effect as Effect.Effect<A, E>;
}

async function scopeOracleDeps(): Promise<ApiDeps> {
  const world = await createWorld({
    account: { listSendingIdentities: () => eraseServices(Effect.map(Effect.scope, () => [])) },
  });
  return world.deps;
}

async function callListSendingIdentities(deps: ApiDeps, services: Context.Context<never>) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "umail", version: "0.0.0" },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      );
      registerTools(server, deps, operatorOAuthPrincipal("operator", "scope-oracle"), services);
      return server;
    },
    { legacy: "reject" },
  );
  const mcp = new Client(
    { name: "umail-scope-oracle", version: "0.0.0" },
    {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://umail.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(String(url), init)),
  });
  await mcp.connect(transport);
  try {
    return await mcp.callTool({ name: "umail_list_sending_identities", arguments: {} });
  } finally {
    await mcp.close();
    await handler.close();
  }
}
