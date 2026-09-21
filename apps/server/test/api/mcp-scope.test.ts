import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { registerUmailTools, type UmailMcpClient } from "@umail/mcp-tools";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";

import { provideRequestContext } from "../../src/api/mcp/client.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

describe("MCP tool request Scope", () => {
  it("fails umail_list_sending_identities without provideContext", async () => {
    const client = scopeOracleClient();
    const outcome = await callListSendingIdentities(client).then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "thrown" as const, error }),
    );
    const message =
      outcome.kind === "thrown" ? String(outcome.error) : JSON.stringify(outcome.result);
    expect(message).toContain("Service not found: effect/Scope");
  });

  it("succeeds umail_list_sending_identities when provideRequestContext supplies a live Scope", async () => {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const client = provideRequestContext(scopeOracleClient(), Context.make(Scope.Scope, scope));
      const result = await callListSendingIdentities(client);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ sendingIdentities: [] });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});

function unusedTool() {
  return Effect.die("unused");
}

function eraseServices<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> {
  return effect as Effect.Effect<A, E>;
}

function scopeOracleClient(): UmailMcpClient {
  return {
    listSendingIdentities: eraseServices(Effect.map(Effect.scope, () => [])),
    listThreads: unusedTool,
    listMessages: unusedTool,
    getThread: unusedTool,
    listThreadMessages: unusedTool,
    getMessage: unusedTool,
    getMessageHeaders: unusedTool,
    setThreadReadState: unusedTool,
    sendMessage: unusedTool,
    submitMessage: unusedTool,
    getJob: unusedTool,
  };
}

async function callListSendingIdentities(client: UmailMcpClient) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "umail", version: "0.0.0" },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      );
      registerUmailTools(server, client);
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
    return await mcp.callTool({
      name: "umail_list_sending_identities",
      arguments: {},
    });
  } finally {
    await mcp.close();
    await handler.close();
  }
}
