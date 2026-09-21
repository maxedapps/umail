import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { World } from "./world.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export async function connectedMcp(world: World, token: string): Promise<Client> {
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
  await client.connect(transport);
  return client;
}
