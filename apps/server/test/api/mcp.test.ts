import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, JSONRPC_VERSION } from "@modelcontextprotocol/client";
import {
  MAX_HEADER_BLOCK_BYTES,
  MailMessagePage,
  MailThreadDetail,
  MessageHeaders,
  OutboundJobStatus,
  ThreadMessage,
  headerBlock,
} from "@umail/api-contract";
import { RpcCallError } from "alchemy/Rpc";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { AccountStoreError } from "../../src/account/errors.ts";

import { connectedMcp } from "./mcp-drivers.ts";
import { issueMcpAccessToken, registerMcpClient } from "./oauth-flow.ts";
import {
  createWorld,
  authorized,
  jsonHeaders,
  operatorCookieHeaders,
  seedInboundMessage,
  seedMailbox,
  type World,
} from "./world.ts";

const MCP_TOOL_NAMES = [
  "umail_list_sending_identities",
  "umail_list_threads",
  "umail_list_messages",
  "umail_get_thread",
  "umail_get_message",
  "umail_get_message_headers",
  "umail_set_thread_read_state",
  "umail_send_message",
  "umail_reply_to_message",
  "umail_get_job",
] as const;

const JobToolOutput = Schema.Struct({ job: OutboundJobStatus });
const GetThreadToolOutput = Schema.Struct({ thread: MailThreadDetail });
const ListMessagesToolOutput = Schema.Struct({ page: MailMessagePage });
const GetMessageToolOutput = Schema.Struct({ message: ThreadMessage });
const ToolErrorBody = Schema.Struct({ error: Schema.String });

describe("OAuth-only MCP Streamable HTTP route", () => {
  it.each([
    ["missing bearer", undefined],
    ["wrong bearer", "Bearer not-a-valid-credential"],
    ["non-Bearer scheme", "Basic YWJjOmRlZg=="],
    ["bad jwt", "Bearer eyJhbGciOiJub25lIn0.e30."],
  ])("rejects %s with a protected-resource challenge", async (_name, authorization) => {
    const world = await createWorld();
    const headers = new Headers({ "content-type": "application/json" });
    if (authorization !== undefined) headers.set("authorization", authorization);
    const response = await world.fetch("http://umail.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    const body = await response.text();
    expect(body).not.toContain(world.operatorAccessToken);
    expect(await Effect.runPromise(world.account.listMcpOAuthPolicies())).toEqual([]);
  });

  it.each(["GET", "DELETE"])("answers %s /mcp with 405", async (method) => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/mcp", { method });
    expect(response.status).toBe(405);
  });

  it("serves the AgentMail PNG icon without authentication", async () => {
    const world = await createWorld();
    const expected = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/api/brand/icon.png"),
    );
    const response = await world.fetch("http://umail.test/icon.png");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(body.equals(expected)).toBe(true);
    expect((await world.fetch("http://umail.test/favicon.png")).status).toBe(200);
    expect((await world.fetch("http://umail.test/icon.png", { method: "POST" })).status).toBe(405);
  });

  it("advertises AgentMail title, description, and icon URL on initialize", async () => {
    const world = await createWorld();
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const response = await world.fetch("http://umail.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "brand-client", version: "1" },
        },
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toMatch(/"title"\s*:\s*"AgentMail"/u);
    expect(body).toContain("Self-hosted mailbox for AI agents");
    expect(body).toContain("https://umail.test/icon.png");
    expect(body).toMatch(/"mimeType"\s*:\s*"image\/png"/u);
    expect(body).not.toContain("data:image/");
  });

  it("completes DCR, S256 PKCE, first-use policy, and the modern 2026-07-28 protocol", async () => {
    const world = await createWorld();
    const registered = await registerMcpClient(world);
    expect(
      await world.db.all(
        "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
        registered.clientId,
      ),
    ).toEqual([{ resourceId: "https://umail.test/mcp" }]);
    expect(await Effect.runPromise(world.account.listMcpOAuthPolicies())).toEqual([]);
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    } finally {
      await client.close();
    }
  });

  it("advertises flat object inputs, with exact required fields and no intent for sends", async () => {
    const world = await createWorld();
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        for (const key of ["anyOf", "oneOf", "$ref"]) {
          expect(tool.inputSchema, tool.name).not.toHaveProperty(key);
        }
      }
      const inputOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
      expect(inputOf("umail_send_message")?.required).toEqual(["fromAddressId", "subject", "to"]);
      expect(inputOf("umail_reply_to_message")?.required).toEqual([
        "fromAddressId",
        "subject",
        "replyToMessageId",
        "replyMode",
      ]);
      expect(inputOf("umail_send_message")?.properties).not.toHaveProperty("intent");
      expect(inputOf("umail_reply_to_message")?.properties).not.toHaveProperty("intent");
      expect(inputOf("umail_list_messages")?.properties?.["since"]).toHaveProperty("description");
    } finally {
      await client.close();
    }
  });

  it("serves the legacy 2025-11-25 handshake alongside the modern revision", async () => {
    const world = await createWorld();
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const legacy = (id: number, method: string, params: Record<string, unknown>) =>
      world.fetch("http://umail.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }),
      });

    const handshake = await legacy(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy-client", version: "1" },
    });
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toContain('"protocolVersion":"2025-11-25"');

    const called = await legacy(2, "tools/call", {
      name: "umail_list_sending_identities",
      arguments: {},
    });
    expect(called.status).toBe(200);
    expect(await called.text()).toContain('"structuredContent"');
  });

  it("never negotiates below the revision that carries structured tool output", async () => {
    const world = await createWorld();
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const response = await world.fetch("http://umail.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ancient-client", version: "1" },
        },
      }),
    });
    const body = await response.text();
    expect(body).toContain('"protocolVersion":"2025-11-25"');
    expect(body).not.toContain('"protocolVersion":"2024-11-05"');
  });

  it("applies policy disablement to the next request carrying the same JWT", async () => {
    const world = await createWorld();
    const registered = await registerMcpClient(world, { label: "Live policy" });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
    } finally {
      await client.close();
    }

    const disabled = await world.fetch(
      `http://umail.test/clients/${encodeURIComponent(registered.clientId)}/policy`,
      {
        method: "POST",
        redirect: "manual",
        headers: operatorCookieHeaders(world.sessionCookie, {
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: new URLSearchParams({
          label: "Live policy",
          mailboxIds: "all",
          canRead: "on",
          sendMode: "deny",
          recipientAllowlist: "any",
        }).toString(),
      },
    );
    expect(disabled.status).toBe(303);

    const rejected = await rawToolsList(world, token.access_token);
    expect(rejected.status).toBe(403);

    const revoked = await world.fetch(
      `http://umail.test/clients/${encodeURIComponent(registered.clientId)}/revoke`,
      {
        method: "POST",
        redirect: "manual",
        headers: operatorCookieHeaders(world.sessionCookie),
      },
    );
    expect(revoked.status).toBe(303);
    expect(
      (await Effect.runPromise(world.account.getMcpOAuthPolicy(registered.clientId)))?.state,
    ).toBe("revoked");
    expect((await rawToolsList(world, token.access_token)).status).toBe(403);
    expect(
      (await Effect.runPromise(world.account.getMcpOAuthPolicy(registered.clientId)))?.state,
    ).toBe("revoked");

    const independent = await registerMcpClient(world, { label: "Independent client" });
    const independentToken = await issueMcpAccessToken(world, independent);
    const independentClient = await connectedMcp(world, independentToken.access_token);
    try {
      expect((await independentClient.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
    } finally {
      await independentClient.close();
    }
  });

  it("returns a durable job from umail_send_message without claiming acceptance", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Sender",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "allow",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Sender",
      mailboxIds: mailbox.id,
      sendMode: "allow",
      recipientAllowlist: "any",
    });
    const send = (args: Record<string, unknown>) =>
      client.callTool({
        name: "umail_send_message",
        arguments: {
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com" }],
          subject: "Compose job",
          text: "body",
          ...args,
        },
      });
    try {
      const result = await send({});
      expect(result.isError).not.toBe(true);
      const output = Schema.decodeUnknownSync(JobToolOutput)(result.structuredContent);
      expect(output.job.state).toBe("ready");
      expect(output.job.state).not.toBe("accepted");
      expect(output.job.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));

      const requestId = "11111111-1111-4111-8111-111111111111";
      const first = Schema.decodeUnknownSync(JobToolOutput)(
        (await send({ requestId })).structuredContent,
      );
      const replay = Schema.decodeUnknownSync(JobToolOutput)(
        (await send({ requestId })).structuredContent,
      );
      expect(replay.job.jobId).toBe(first.job.jobId);
      const conflict = await send({ requestId, subject: "Changed" });
      expect(conflict.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(conflict))).toEqual({
        error: "requestId reused with different content.",
      });
    } finally {
      await client.close();
    }
  });

  it("denies disallowed recipients without sending or persisting outbound mail", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Restricted recipients",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "allow",
      recipientAllowlist: "allowed@example.com",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Restricted recipients",
      mailboxIds: mailbox.id,
      sendMode: "allow",
      recipientAllowlist: "allowed@example.com",
    });
    try {
      const result = await client.callTool({
        name: "umail_send_message",
        arguments: {
          requestId: "11111111-1111-4111-8111-111111111111",
          fromAddressId: mailbox.id,
          to: [{ address: "blocked@example.com", displayName: null }],
          subject: "Blocked",
          text: "should not send",
        },
      });
      expect(result.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(result))).toEqual({
        error: "The request is not permitted.",
      });
      const jobs = await Effect.runPromise(
        world.account.listOutboundJobs({ viewer: { kind: "operator" } }),
      );
      expect(jobs.items).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("passes the API problem message through when sending from an unknown address", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Sender",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "allow",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Sender",
      mailboxIds: mailbox.id,
      sendMode: "allow",
      recipientAllowlist: "any",
    });
    try {
      const result = await client.callTool({
        name: "umail_send_message",
        arguments: {
          fromAddressId: "no-such-address",
          to: [{ address: "recipient@example.com" }],
          subject: "Unknown sender",
          text: "body",
        },
      });
      expect(result.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(result))).toEqual({
        error: "The from address is unknown or inactive.",
      });
      const jobs = await Effect.runPromise(
        world.account.listOutboundJobs({ viewer: { kind: "operator" } }),
      );
      expect(jobs.items).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("keeps administrative MCP clients subject to send, approval, and recipient policy", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Administrative sender",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "allow",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    const submit = (requestId: string, to: ReadonlyArray<string>, cc: ReadonlyArray<string> = []) =>
      client.callTool({
        name: "umail_send_message",
        arguments: {
          requestId,
          fromAddressId: mailbox.id,
          to: to.map((address) => ({ address, displayName: null })),
          cc: cc.map((address) => ({ address, displayName: null })),
          subject: "Authority boundary",
          text: "body",
        },
      });
    try {
      await updatePolicy(world, registered.clientId, {
        label: "Administrative sender",
        mailboxIds: mailbox.id,
        sendMode: "requireApproval",
        recipientAllowlist: "allowed@example.com",
        canAdmin: true,
      });
      const pending = await submit("11111111-1111-4111-8111-111111111111", ["allowed@example.com"]);
      expect(pending.isError).not.toBe(true);
      const pendingJob = Schema.decodeUnknownSync(JobToolOutput)(pending.structuredContent).job;
      expect(pendingJob.state).toBe("waiting_approval");
      expect(
        await Effect.runPromise(
          world.account.getOutboundJob(pendingJob.jobId, {
            kind: "mcp",
            clientId: registered.clientId,
          }),
        ),
      ).toMatchObject({ requester: { kind: "mcp", clientId: registered.clientId } });

      const blocked = await submit(
        "22222222-2222-4222-8222-222222222222",
        ["allowed@example.com"],
        ["blocked@example.com"],
      );
      expect(blocked.isError).toBe(true);

      await updatePolicy(world, registered.clientId, {
        label: "Administrative sender",
        mailboxIds: mailbox.id,
        sendMode: "deny",
        recipientAllowlist: "any",
        canAdmin: true,
      });
      const denied = await submit("33333333-3333-4333-8333-333333333333", ["allowed@example.com"]);
      expect(denied.isError).toBe(true);
      expect(
        (
          await Effect.runPromise(
            world.account.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 }),
          )
        ).items,
      ).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("parks require-approval submits with OAuth client provenance", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Approval client",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "requireApproval",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Approval client",
      mailboxIds: mailbox.id,
      sendMode: "requireApproval",
      recipientAllowlist: "any",
    });
    try {
      const result = await client.callTool({
        name: "umail_send_message",
        arguments: {
          requestId: "11111111-1111-4111-8111-111111111111",
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "Needs a human",
          text: "please approve",
        },
      });
      expect(result.isError).not.toBe(true);
      const output = Schema.decodeUnknownSync(JobToolOutput)(result.structuredContent);
      expect(output.job.state).toBe("waiting_approval");
      const job = await Effect.runPromise(
        world.account.getOutboundJob(output.job.jobId, {
          kind: "mcp",
          clientId: registered.clientId,
        }),
      );
      expect(job?.requester.clientId).toBe(registered.clientId);
      expect(job?.requester.label).toBe("Approval client");
    } finally {
      await client.close();
    }
  });

  it("submits to a preapproved recipient without approval and parks everyone else", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const registered = await registerMcpClient(world, {
      label: "Preapproved client",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "requireApproval",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Preapproved client",
      mailboxIds: mailbox.id,
      sendMode: "requireApproval",
      recipientAllowlist: "any",
      preapprovedRecipients: "trusted@example.com",
    });
    const submit = (to: ReadonlyArray<string>, subject: string, requestId: string) =>
      client.callTool({
        name: "umail_send_message",
        arguments: {
          requestId,
          fromAddressId: mailbox.id,
          to: to.map((address) => ({ address, displayName: null })),
          subject,
          text: "hello",
        },
      });
    try {
      const direct = await submit(
        ["trusted@example.com"],
        "Straight through",
        "11111111-1111-4111-8111-111111111111",
      );
      expect(Schema.decodeUnknownSync(JobToolOutput)(direct.structuredContent).job.state).toBe(
        "ready",
      );

      const parked = await submit(
        ["someone@example.com"],
        "Needs a human",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(Schema.decodeUnknownSync(JobToolOutput)(parked.structuredContent).job.state).toBe(
        "waiting_approval",
      );

      const mixed = await submit(
        ["trusted@example.com", "someone@example.com"],
        "Mixed audience",
        "33333333-3333-4333-8333-333333333333",
      );
      expect(Schema.decodeUnknownSync(JobToolOutput)(mixed.structuredContent).job.state).toBe(
        "waiting_approval",
      );
    } finally {
      await client.close();
    }
  });

  it("lists, gets, and updates read state through real MCP SDK calls", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, {
      id: "mcp-in",
      from: "header-sender@example.com",
      to: ["visible-recipient@example.com"],
      envelopeFrom: "",
      envelopeTo: "inbox@umail.example.com",
      parsedDate: "2026-08-25T10:00:00.000Z",
      occurredAt: "2026-08-25T11:00:00.000Z",
      forward: { kind: "unknown", destination: "forward@example.net" },
    });
    const registered = await registerMcpClient(world, { label: "Reader" });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    try {
      const listed = await client.callTool({ name: "umail_list_threads", arguments: {} });
      expect(listed.isError).not.toBe(true);
      const got = await client.callTool({
        name: "umail_get_thread",
        arguments: { threadId: inbound.threadId },
      });
      const thread = Schema.decodeUnknownSync(GetThreadToolOutput)(got.structuredContent);
      expect(thread.thread.messages[0]?.id).toBe(inbound.messageId);
      const listedMessages = await client.callTool({
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      const messages = Schema.decodeUnknownSync(ListMessagesToolOutput)(
        listedMessages.structuredContent,
      );
      const gotMessage = await client.callTool({
        name: "umail_get_message",
        arguments: { messageId: inbound.messageId },
      });
      const message = Schema.decodeUnknownSync(GetMessageToolOutput)(gotMessage.structuredContent);
      const restMessage = await Schema.decodeUnknownPromise(ThreadMessage)(
        await (
          await world.fetch(`http://umail.test/messages/${inbound.messageId}`, authorized(world))
        ).json(),
      );
      const summaries = [
        thread.thread.messages[0],
        messages.page.items[0],
        message.message,
        restMessage,
      ];
      for (const summary of summaries) {
        expect(summary?.direction).toBe("inbound");
        if (summary?.direction === "inbound") {
          expect(summary).toMatchObject({
            id: "mcp-in",
            envelopeFrom: "",
            envelopeTo: "inbox@umail.example.com",
            parsedDate: "2026-08-25T10:00:00.000Z",
            occurredAt: "2026-08-25T11:00:00.000Z",
            forwardOutcome: "unknown",
            forwardDestination: "forward@example.net",
          });
        }
      }
      expect(JSON.stringify(messages.page)).not.toContain("textBody");
      await client.callTool({
        name: "umail_set_thread_read_state",
        arguments: { threadId: inbound.threadId, isRead: true },
      });
      const after = await client.callTool({
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      expect(JSON.stringify(after.structuredContent)).not.toContain("mcp-in");
    } finally {
      await client.close();
    }
  });

  it("rejects excess fields and body-filter mismatches on MCP tools", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    await seedInboundMessage(world, mailbox.id, { id: "filter-in" });
    const registered = await registerMcpClient(world, { label: "Filter client" });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    try {
      const excess = await client.callTool({
        name: "umail_get_thread",
        arguments: { threadId: "filter-in", extra: true },
      });
      expect(excess.isError).toBe(true);
      const bodyless = await client.callTool({
        name: "umail_send_message",
        arguments: {
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com" }],
          subject: "No body",
        },
      });
      expect(bodyless.isError).toBe(true);
      const unread = await client.callTool({
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      expect(JSON.stringify(unread.structuredContent)).not.toContain('"direction":"outbound"');
    } finally {
      await client.close();
    }
  });

  it("returns only the scoped header block of an inbound message from umail_get_message_headers", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world, "inbox");
    const probe = await seedMailbox(world, "probe");
    const inbound = await seedInboundMessage(world, mailbox.id, { id: "headers-in" });
    const outOfScope = await seedInboundMessage(world, probe.id, { id: "headers-probe" });
    const headers =
      "From: sender@example.com\r\nSubject: Headers\r\nAuthentication-Results: mx.example; dkim=pass\r\n";
    world.archive.put(
      "raw/headers-in",
      new TextEncoder().encode(`${headers}\r\nBODY-SENTINEL-7f3a\r\n`),
    );
    world.archive.put("raw/headers-probe", new TextEncoder().encode("Subject: probe\r\n\r\n"));
    const submitted = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        requestId: "11111111-1111-4111-8111-111111111111",
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Outbound",
        text: "outbound body",
      }),
    });
    expect(submitted.status).toBe(200);
    const outbound = await Schema.decodeUnknownPromise(OutboundJobStatus)(await submitted.json());
    const registered = await registerMcpClient(world, { label: "Header reader" });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Header reader",
      mailboxIds: mailbox.id,
      sendMode: "deny",
      recipientAllowlist: "any",
    });
    const getHeaders = (args: Record<string, string | boolean>) =>
      client.callTool({ name: "umail_get_message_headers", arguments: args });
    try {
      const result = await getHeaders({ messageId: inbound.messageId });
      expect(result.isError).not.toBe(true);
      const output = Schema.decodeUnknownSync(MessageHeaders)(result.structuredContent);
      expect(output).toEqual({ headers, truncated: false });
      const restSource = await world.fetch(
        `http://umail.test/messages/${inbound.messageId}/source`,
        authorized(world),
      );
      expect(output).toEqual(headerBlock(new Uint8Array(await restSource.arrayBuffer())));
      expect(JSON.stringify(result)).not.toContain("BODY-SENTINEL-7f3a");

      const hidden = await getHeaders({ messageId: outOfScope.messageId });
      expect(hidden.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(hidden))).toEqual({
        error: "The requested resource was not found.",
      });

      const noSource = await getHeaders({ messageId: outbound.messageId });
      expect(noSource.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(noSource))).toEqual({
        error: "The message has no archived source; only inbound messages are archived.",
      });

      const excess = await getHeaders({ messageId: inbound.messageId, extra: true });
      expect(excess.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("refuses umail_get_message_headers without read permission before any archive read", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, { id: "unreadable-in" });
    world.archive.put("raw/unreadable-in", new TextEncoder().encode("Subject: secret\r\n\r\n"));
    const registered = await registerMcpClient(world, { label: "No reader" });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "No reader",
      mailboxIds: "all",
      canRead: false,
      sendMode: "deny",
      recipientAllowlist: "any",
    });
    try {
      const result = await client.callTool({
        name: "umail_get_message_headers",
        arguments: { messageId: inbound.messageId },
      });
      expect(result.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(result))).toEqual({
        error: "The request is not permitted.",
      });
      expect(world.archive.getCalls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("bounds the umail_get_message_headers wire size for a worst-case header block", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, { id: "huge-headers-in" });
    const source = new Uint8Array(MAX_HEADER_BLOCK_BYTES + 1 + 3).fill(0x01);
    source.set(new TextEncoder().encode("\n\nb"), MAX_HEADER_BLOCK_BYTES + 1);
    world.archive.put("raw/huge-headers-in", source);
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    try {
      const result = await client.callTool({
        name: "umail_get_message_headers",
        arguments: { messageId: inbound.messageId },
      });
      expect(result.isError).not.toBe(true);
      const output = Schema.decodeUnknownSync(MessageHeaders)(result.structuredContent);
      expect(output.truncated).toBe(true);
      expect(output.headers).toHaveLength(MAX_HEADER_BLOCK_BYTES);
      expect(JSON.stringify(result).length).toBeLessThan(3_500_000);
    } finally {
      await client.close();
    }
  });

  it("replies with recipients derived from the parent through umail_reply_to_message", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const parent = await seedInboundMessage(world, mailbox.id, { id: "reply-parent" });
    const registered = await registerMcpClient(world, {
      label: "Replier",
      mailboxIds: mailbox.id,
      canRead: true,
      sendMode: "allow",
    });
    const token = await issueMcpAccessToken(world, registered);
    const client = await connectedMcp(world, token.access_token);
    await updatePolicy(world, registered.clientId, {
      label: "Replier",
      mailboxIds: mailbox.id,
      sendMode: "allow",
      recipientAllowlist: "any",
    });
    try {
      const result = await client.callTool({
        name: "umail_reply_to_message",
        arguments: {
          fromAddressId: mailbox.id,
          replyToMessageId: parent.messageId,
          replyMode: "reply",
          subject: "Re: Subject reply-parent",
          text: "reply body",
        },
      });
      expect(result.isError).not.toBe(true);
      const { job } = Schema.decodeUnknownSync(JobToolOutput)(result.structuredContent);
      expect(job.state).toBe("ready");
      expect(job.threadHandle).toBe(parent.threadId);
      const reply = await Schema.decodeUnknownPromise(ThreadMessage)(
        await (
          await world.fetch(`http://umail.test/messages/${job.messageId}`, authorized(world))
        ).json(),
      );
      expect(reply.to.map((contact) => contact.address)).toEqual(["sender@example.com"]);
    } finally {
      await client.close();
    }
  });

  it("pages a thread from umail_get_thread given any message id in it", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const root = await seedInboundMessage(world, mailbox.id, {
      id: "thread-root",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const child = await seedInboundMessage(world, mailbox.id, {
      id: "thread-child",
      occurredAt: "2026-01-02T00:00:00.000Z",
      inReplyToHeader: "<thread-root@example.com>",
    });
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    const getThread = async (args: Record<string, unknown>) =>
      Schema.decodeUnknownSync(GetThreadToolOutput)(
        (await client.callTool({ name: "umail_get_thread", arguments: args })).structuredContent,
      ).thread;
    try {
      const first = await getThread({ threadId: child.messageId, limit: 1 });
      expect(first.threadId).toBe(root.threadId);
      expect(first.messages.map((message) => message.id)).toEqual(["thread-root"]);
      const second = await getThread({
        threadId: child.messageId,
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.messages.map((message) => message.id)).toEqual(["thread-child"]);
      expect(second.nextCursor).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("drops htmlBody from umail_get_message when a text body exists", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const both = await seedInboundMessage(world, mailbox.id, {
      id: "text-and-html",
      htmlBody: "<p>html</p>",
    });
    const htmlOnly = await seedInboundMessage(world, mailbox.id, {
      id: "html-only",
      textBody: null,
      htmlBody: "<p>only html</p>",
    });
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    const getMessage = async (messageId: string) =>
      Schema.decodeUnknownSync(GetMessageToolOutput)(
        (await client.callTool({ name: "umail_get_message", arguments: { messageId } }))
          .structuredContent,
      ).message;
    try {
      expect(await getMessage(both.messageId)).toMatchObject({ textBody: "text", htmlBody: null });
      expect(await getMessage(htmlOnly.messageId)).toMatchObject({
        textBody: null,
        htmlBody: "<p>only html</p>",
      });
    } finally {
      await client.close();
    }
  });

  it("maps a plain ThreadHandleError envelope from the store to the not-found text", async () => {
    const world = await createWorld({
      account: {
        listThreadMessageSummaries: () =>
          failOverRpc({ _tag: "ThreadHandleError", handle: "missing", reason: "not_found" }),
      },
    });
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    try {
      const result = await client.callTool({
        name: "umail_get_thread",
        arguments: { threadId: "missing" },
      });
      expect(result.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(result))).toEqual({
        error: "The requested resource was not found.",
      });
    } finally {
      await client.close();
    }
  });

  it("answers a generic failure and logs once in the tool helper for an RpcCallError", async () => {
    const logs: Array<{ readonly message: unknown; readonly defect: unknown }> = [];
    const capture = Logger.make(({ message, cause }) => {
      logs.push({ message, defect: Cause.squash(cause) });
    });
    const world = await createWorld({
      account: {
        listSendingIdentities: () =>
          failOverRpc(
            new RpcCallError({ method: "listSendingIdentities", cause: new Error("DO reset") }),
          ),
      },
      requestContext: Context.make(Logger.CurrentLoggers, new Set([capture])),
    });
    const token = await issueMcpAccessToken(world, await registerMcpClient(world));
    const client = await connectedMcp(world, token.access_token);
    logs.length = 0;
    try {
      const result = await client.callTool({
        name: "umail_list_sending_identities",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(Schema.decodeUnknownSync(ToolErrorBody)(parseTextResult(result))).toEqual({
        error: "The AgentMail API request failed.",
      });
      expect(JSON.stringify(result)).not.toContain("DO reset");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.message).toEqual(["MCP tool failed"]);
      expect(logs[0]?.defect).toBeInstanceOf(RpcCallError);
    } finally {
      await client.close();
    }
  });

  it("serves exact MCP protected-resource metadata without registration discovery", async () => {
    const world = await createWorld();
    const response = await world.fetch(
      "http://umail.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(response.status).toBe(200);
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      await response.json(),
    );
    expect(body.resource).toBe("https://umail.test/mcp");
    expect(body).not.toHaveProperty("registration_endpoint");
  });
});

async function updatePolicy(
  world: World,
  clientId: string,
  input: {
    readonly label: string;
    readonly mailboxIds: string;
    readonly canRead?: boolean;
    readonly sendMode: "deny" | "allow" | "requireApproval";
    readonly recipientAllowlist: string;
    readonly preapprovedRecipients?: string;
    readonly canAdmin?: boolean;
  },
): Promise<void> {
  const body = new URLSearchParams({
    label: input.label,
    mailboxIds: input.mailboxIds,
    sendMode: input.sendMode,
    recipientAllowlist: input.recipientAllowlist,
    preapprovedRecipients: input.preapprovedRecipients ?? "",
    active: "on",
  });
  if (input.canRead !== false) {
    body.set("canRead", "on");
  }
  if (input.canAdmin === true) {
    body.set("canAdmin", "on");
  }
  const response = await world.fetch(
    `http://umail.test/clients/${encodeURIComponent(clientId)}/policy`,
    {
      method: "POST",
      redirect: "manual",
      headers: operatorCookieHeaders(world.sessionCookie, {
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: body.toString(),
    },
  );
  expect(response.status).toBe(303);
}

async function rawToolsList(world: World, token: string) {
  return world.fetch("http://umail.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 1, method: "tools/list" }),
  });
}

function failOverRpc(error: unknown): Effect.Effect<never, AccountStoreError> {
  return Effect.fail(error as AccountStoreError);
}

function parseTextResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected one MCP text result block");
  return Schema.decodeSync(Schema.fromJsonString(Schema.Json))(content.text);
}
