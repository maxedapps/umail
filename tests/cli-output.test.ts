import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const CLI_BIN = fileURLToPath(new URL("../apps/cli/src/bin.ts", import.meta.url));

it("writes large JSON output completely to a pipe before exiting 0", async () => {
  const addresses = Array.from({ length: 1_000 }, (_, index) => ({
    id: `address-${index}`,
    localPart: `inbox${index}`,
    address: `inbox${index}@umail.example.test`,
    displayName: "Inbox",
    active: true,
    forwardingDestinationId: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
  }));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(addresses));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stateHome = mkdtempSync(join(tmpdir(), "umail-cli-output-"));
  try {
    mkdirSync(join(stateHome, "umail"), { mode: 0o700 });
    writeFileSync(
      join(stateHome, "umail", "oauth.json"),
      JSON.stringify({
        version: 2,
        kind: "authorized",
        origin,
        issuer: `${origin}/api/auth`,
        resource: origin,
        scope: "umail:access offline_access",
        clientId: "cli-output",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        generation: 0,
      }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [CLI_BIN, "addresses", "list"], {
      env: { XDG_STATE_HOME: stateHome, UMAIL_URL: origin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = await once(child, "close");
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(addresses);
  } finally {
    server.close();
    rmSync(stateHome, { recursive: true, force: true });
  }
}, 15_000);
