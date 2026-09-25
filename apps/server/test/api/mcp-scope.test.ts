import { describe, expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { operatorOAuthPrincipal } from "@umail/api-contract";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { ApiDeps } from "../../src/api/app.ts";
import { registerTools } from "../../src/api/mcp/tools.ts";
import { MCP_PROTOCOL_VERSION } from "./mcp-drivers.ts";
import { WorkerServices, createWorld } from "./world.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("MCP tool request services", () => {
  it.effect(
    "runs umail_list_sending_identities with the request Scope passed to registerTools",
    () =>
      Effect.gen(function* () {
        const deps = yield* scopeOracleDeps();
        const services = yield* Layer.build(WorkerServices);
        const result = yield* callListSendingIdentities(
          deps,
          Context.add(services, Scope.Scope, yield* Effect.scope),
        );
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ sendingIdentities: [] });
      }),
  );

  it.effect("answers a generic failure and logs the defect when the request Scope is missing", () =>
    Effect.gen(function* () {
      const deps = yield* scopeOracleDeps();
      const messages: Array<unknown> = [];
      const capture = Logger.make(({ message }) => {
        messages.push(message);
      });
      const services = yield* Layer.build(WorkerServices);
      const result = yield* callListSendingIdentities(
        deps,
        Context.add(services, Logger.CurrentLoggers, new Set([capture])),
      );
      expect(result.isError).toBe(true);
      expect(toJson(result.content)).toContain("The AgentMail API request failed.");
      expect(toJson(result)).not.toContain("Service not found");
      expect(messages).toEqual([["MCP tool failed"]]);
    }),
  );
});

// The store answers only when the tool runs with a request Scope among its services, and dies
// the way a missing service would otherwise.
const scopeOracleDeps = Effect.fn("scopeOracleDeps")(function* () {
  const world = yield* createWorld({
    account: {
      listSendingIdentities: () =>
        Effect.flatMap(
          Effect.serviceOption(Scope.Scope),
          Option.match({
            onNone: () => Effect.die("Service not found: Scope"),
            onSome: () => Effect.succeed([]),
          }),
        ),
    },
  });
  return world.deps;
});

const callListSendingIdentities = Effect.fn("callListSendingIdentities")(function* (
  deps: ApiDeps,
  services: Context.Context<Crypto.Crypto | RuntimeContext>,
) {
  const handler = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createMcpHandler(
        () => {
          const server = new McpServer(
            { name: "umail", version: "0.0.0" },
            { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
          );
          registerTools(server, deps, operatorOAuthPrincipal("operator", "scope-oracle"), services);
          return server;
        },
        { legacy: "reject" },
      ),
    ),
    (handler) => Effect.promise(() => handler.close()),
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
  yield* Effect.acquireRelease(
    Effect.promise(() => mcp.connect(transport)),
    () => Effect.promise(() => mcp.close()),
  );
  return yield* Effect.promise(() =>
    mcp.callTool({ name: "umail_list_sending_identities", arguments: {} }),
  );
}, Effect.scoped);
