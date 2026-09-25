import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";

import type { World } from "./world.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

// A connected MCP client, closed when the test's scope ends.
export const connectedMcp = Effect.fn("connectedMcp")(function* (world: World, token: string) {
  const client = new Client(
    { name: "umail-http-test", version: "0.0.0" },
    {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://umail.test/mcp"), {
    fetch: (url, init) => world.fetch(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => client.connect(transport)),
    () => Effect.promise(() => client.close()),
  );
  return client;
});
