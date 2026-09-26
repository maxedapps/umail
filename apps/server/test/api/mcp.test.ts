import { describe, expect, it } from "@effect/vitest";
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

import type { AccountStoreError } from "../../src/account/errors.ts";

import { connectedMcp } from "./mcp-drivers.ts";
import { issueMcpAccessToken, registerMcpClient } from "./oauth-flow.ts";
import {
  createWorld,
  authorized,
  jsonHeaders,
  operatorCookieHeaders,
  seedInboundMessage,
  listMcpPolicyRows,
  readJson,
  readText,
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
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("OAuth-only MCP Streamable HTTP route", () => {
  it.effect.each<readonly [string, string | undefined]>([
    ["missing bearer", undefined],
    ["wrong bearer", "Bearer not-a-valid-credential"],
    ["non-Bearer scheme", "Basic YWJjOmRlZg=="],
    ["bad jwt", "Bearer eyJhbGciOiJub25lIn0.e30."],
  ])("rejects %s with a protected-resource challenge", ([_name, authorization]) =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization !== undefined) headers.set("authorization", authorization);
      const response = yield* world.request("http://umail.test/mcp", {
        method: "POST",
        headers,
        body: toJson({ jsonrpc: JSONRPC_VERSION, id: 1, method: "tools/list" }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
      const body = yield* readText(response);
      expect(body).not.toContain(world.operatorAccessToken);
      expect(yield* listMcpPolicyRows(world)).toEqual([]);
    }),
  );

  it.effect.each(["GET", "DELETE"])("answers %s /mcp with 405", (method) =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/mcp", { method });
      expect(response.status).toBe(405);
    }),
  );

  it.effect("serves the AgentMail PNG icon without authentication", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/icon.png");
      const body = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(body.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect((yield* world.request("http://umail.test/favicon.png")).status).toBe(200);
      // The icon is a GET route; the router answers any other method with 404.
      expect((yield* world.request("http://umail.test/icon.png", { method: "POST" })).status).toBe(
        404,
      );
    }),
  );

  it.effect("advertises AgentMail title, description, and icon URL on initialize", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const response = yield* world.request("http://umail.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: toJson({
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
      const body = yield* readText(response);
      expect(response.status).toBe(200);
      expect(body).toMatch(/"title"\s*:\s*"AgentMail"/u);
      expect(body).toContain("Self-hosted mailbox for AI agents");
      expect(body).toContain("https://umail.test/icon.png");
      expect(body).toMatch(/"mimeType"\s*:\s*"image\/png"/u);
      expect(body).not.toContain("data:image/");
    }),
  );

  it.effect(
    "completes DCR, S256 PKCE, consent-time policy, and the modern 2026-07-28 protocol",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const registered = yield* registerMcpClient(world);
        expect(
          yield* query(
            world,
            "SELECT resourceId FROM oauthClientResource WHERE clientId = ?",
            registered.clientId,
          ),
        ).toEqual([{ resourceId: "https://umail.test/mcp" }]);
        expect(yield* listMcpPolicyRows(world)).toEqual([]);
        const token = yield* issueMcpAccessToken(world, registered);
        expect(yield* listMcpPolicyRows(world)).toHaveLength(1);
        const client = yield* connectedMcp(world, token.access_token);
        const listed = yield* listTools(client);
        expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
      }),
  );

  it.effect(
    "advertises flat object inputs, with exact required fields and no intent for sends",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
        const client = yield* connectedMcp(world, token.access_token);
        const { tools } = yield* listTools(client);
        for (const tool of tools) {
          expect(tool.inputSchema.type, tool.name).toBe("object");
          for (const key of ["anyOf", "oneOf", "$ref"]) {
            expect(tool.inputSchema, tool.name).not.toHaveProperty(key);
          }
        }
        const inputOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
        expect(inputOf("umail_send_message")?.required).toEqual([
          "requestId",
          "fromAddressId",
          "subject",
          "to",
        ]);
        expect(inputOf("umail_reply_to_message")?.required).toEqual([
          "requestId",
          "fromAddressId",
          "subject",
          "replyToMessageId",
          "replyMode",
        ]);
        expect(inputOf("umail_send_message")?.properties).not.toHaveProperty("intent");
        expect(inputOf("umail_reply_to_message")?.properties).not.toHaveProperty("intent");
        expect(inputOf("umail_list_messages")?.properties?.["since"]).toHaveProperty("description");
      }),
  );

  it.effect("serves the legacy 2025-11-25 handshake alongside the modern revision", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const legacy = (id: number, method: string, params: Record<string, unknown>) =>
        world.request("http://umail.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: toJson({ jsonrpc: JSONRPC_VERSION, id, method, params }),
        });

      const handshake = yield* legacy(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1" },
      });
      expect(handshake.status).toBe(200);
      expect(yield* readText(handshake)).toContain('"protocolVersion":"2025-11-25"');

      const called = yield* legacy(2, "tools/call", {
        name: "umail_list_sending_identities",
        arguments: {},
      });
      expect(called.status).toBe(200);
      expect(yield* readText(called)).toContain('"structuredContent"');
    }),
  );

  it.effect("never negotiates below the revision that carries structured tool output", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const response = yield* world.request("http://umail.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: toJson({
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
      const body = yield* readText(response);
      expect(body).toContain('"protocolVersion":"2025-11-25"');
      expect(body).not.toContain('"protocolVersion":"2024-11-05"');
    }),
  );

  it.effect(
    "narrows a live grant, and revoking ends it at once until the operator consents again",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const registered = yield* registerMcpClient(world, { label: "Live policy" });
        const token = yield* issueMcpAccessToken(world, registered);
        const client = yield* connectedMcp(world, token.access_token);
        expect((yield* listTools(client)).tools).toHaveLength(MCP_TOOL_NAMES.length);
        yield* updatePolicy(world, registered.clientId, {
          mailboxes: mailbox.id,
          canRead: false,
          sendMode: "deny",
          recipients: "any",
        });
        const denied = yield* callTool(client, { name: "umail_list_threads", arguments: {} });
        expect(denied.isError).toBe(true);

        const revoked = yield* world.request(
          `http://umail.test/clients/${encodeURIComponent(registered.clientId)}/revoke`,
          {
            method: "POST",
            redirect: "manual",
            headers: operatorCookieHeaders(world.sessionCookie),
          },
        );
        expect(revoked.status).toBe(303);
        expect((yield* rawToolsList(world, token.access_token)).status).toBe(403);
        expect(yield* listMcpPolicyRows(world)).toEqual([]);
        const refreshed = yield* world.request("http://umail.test/api/auth/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token.refresh_token ?? "",
            client_id: registered.clientId,
            resource: "https://umail.test/mcp",
          }).toString(),
        });
        expect(refreshed.status).toBe(400);
        expect(yield* readText(refreshed)).toContain("invalid_grant");

        // The registration stays, so the client can ask again; the consent screen decides anew.
        const again = yield* issueMcpAccessToken(world, registered, { sendMode: "allow" });
        expect((yield* rawToolsList(world, again.access_token)).status).toBe(200);
      }),
  );

  it.effect("returns a durable job from umail_send_message without claiming acceptance", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Sender" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "allow",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "allow",
        recipients: "any",
      });
      const requestId = "aaaaaaaa-1111-4111-8111-11111111111f";
      const send = (args: Record<string, unknown>) =>
        callTool(client, {
          name: "umail_send_message",
          arguments: {
            requestId,
            fromAddressId: mailbox.id,
            to: [{ address: "recipient@example.com" }],
            subject: "Compose job",
            text: "body",
            ...args,
          },
        });
      // An agent may write the UUID upper-case; it is stored lower-case and replays the same job.
      const result = yield* send({ requestId: requestId.toUpperCase() });
      expect(result.isError).not.toBe(true);
      const first = yield* Schema.decodeUnknownEffect(JobToolOutput)(result.structuredContent);
      expect(first.job.state).toBe("ready");
      expect(first.job.state).not.toBe("accepted");
      expect(first.job.requestId).toBe(requestId);

      const replay = yield* Schema.decodeUnknownEffect(JobToolOutput)(
        (yield* send({})).structuredContent,
      );
      expect(replay.job.jobId).toBe(first.job.jobId);
      const conflict = yield* send({ subject: "Changed" });
      expect(conflict.isError).toBe(true);
      expect(yield* toolErrorText(conflict)).toBe(
        `requestId ${requestId} was already used for different content.`,
      );

      const missing = yield* callTool(client, {
        name: "umail_send_message",
        arguments: {
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com" }],
          subject: "No id",
          text: "body",
        },
      });
      expect(missing.isError).toBe(true);
    }),
  );

  it.effect("denies disallowed recipients without sending or persisting outbound mail", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Restricted recipients" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "allow",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "allow",
        recipients: "allowed@example.com",
      });
      const result = yield* callTool(client, {
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
      expect(yield* toolErrorText(result)).toBe("This client may not send this message.");
      const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
      expect(jobs.items).toEqual([]);
    }),
  );

  it.effect("passes the API problem message through when sending from an unknown address", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Sender" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "allow",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "allow",
        recipients: "any",
      });
      const result = yield* callTool(client, {
        name: "umail_send_message",
        arguments: {
          requestId: "11111111-1111-4111-8111-111111111111",
          fromAddressId: "no-such-address",
          to: [{ address: "recipient@example.com" }],
          subject: "Unknown sender",
          text: "body",
        },
      });
      expect(result.isError).toBe(true);
      expect(yield* toolErrorText(result)).toBe(
        "Sending identity no-such-address is unknown or inactive.",
      );
      const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
      expect(jobs.items).toEqual([]);
    }),
  );

  it.effect("keeps MCP clients subject to send, approval, and recipient policy", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Sender" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "allow",
      });
      const client = yield* connectedMcp(world, token.access_token);
      const submit = (
        requestId: string,
        to: ReadonlyArray<string>,
        cc: ReadonlyArray<string> = [],
      ) =>
        callTool(client, {
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
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "requireApproval",
        recipients: "allowed@example.com",
      });
      const pending = yield* submit("11111111-1111-4111-8111-111111111111", [
        "allowed@example.com",
      ]);
      expect(pending.isError).not.toBe(true);
      const pendingJob = (yield* Schema.decodeUnknownEffect(JobToolOutput)(
        pending.structuredContent,
      )).job;
      expect(pendingJob.state).toBe("waiting_approval");
      expect(
        yield* world.account.getOutboundJob(pendingJob.jobId, {
          kind: "mcp",
          clientId: registered.clientId,
        }),
      ).toMatchObject({ requester: { kind: "mcp", clientId: registered.clientId } });

      const blocked = yield* submit(
        "22222222-2222-4222-8222-222222222222",
        ["allowed@example.com"],
        ["blocked@example.com"],
      );
      expect(blocked.isError).toBe(true);

      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "deny",
        recipients: "any",
      });
      const denied = yield* submit("33333333-3333-4333-8333-333333333333", ["allowed@example.com"]);
      expect(denied.isError).toBe(true);
      expect(
        (yield* world.account.listOutboundJobs({ viewer: { kind: "operator" }, limit: 50 })).items,
      ).toHaveLength(2);
    }),
  );

  it.effect("parks require-approval submits with OAuth client provenance", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Approval client" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "requireApproval",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "requireApproval",
        recipients: "any",
      });
      const result = yield* callTool(client, {
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
      const output = yield* Schema.decodeUnknownEffect(JobToolOutput)(result.structuredContent);
      expect(output.job.state).toBe("waiting_approval");
      const job = yield* world.account.getOutboundJob(output.job.jobId, {
        kind: "mcp",
        clientId: registered.clientId,
      });
      expect(job?.requester.clientId).toBe(registered.clientId);
      expect(job?.requester.label).toBe(`OAuth client ${registered.clientId.slice(0, 12)}`);
    }),
  );

  it.effect("submits to a preapproved recipient without approval and parks everyone else", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const registered = yield* registerMcpClient(world, { label: "Preapproved client" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "requireApproval",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "requireApproval",
        recipients: "any",
        preapproved: "trusted@example.com",
      });
      const submit = (to: ReadonlyArray<string>, subject: string, requestId: string) =>
        callTool(client, {
          name: "umail_send_message",
          arguments: {
            requestId,
            fromAddressId: mailbox.id,
            to: to.map((address) => ({ address, displayName: null })),
            subject,
            text: "hello",
          },
        });
      const direct = yield* submit(
        ["trusted@example.com"],
        "Straight through",
        "11111111-1111-4111-8111-111111111111",
      );
      expect(
        (yield* Schema.decodeUnknownEffect(JobToolOutput)(direct.structuredContent)).job.state,
      ).toBe("ready");

      const parked = yield* submit(
        ["someone@example.com"],
        "Needs a human",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(
        (yield* Schema.decodeUnknownEffect(JobToolOutput)(parked.structuredContent)).job.state,
      ).toBe("waiting_approval");

      const mixed = yield* submit(
        ["trusted@example.com", "someone@example.com"],
        "Mixed audience",
        "33333333-3333-4333-8333-333333333333",
      );
      expect(
        (yield* Schema.decodeUnknownEffect(JobToolOutput)(mixed.structuredContent)).job.state,
      ).toBe("waiting_approval");
    }),
  );

  it.effect("lists, gets, and updates read state through real MCP SDK calls", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id, {
        id: "mcp-in",
        from: "header-sender@example.com",
        to: ["visible-recipient@example.com"],
        envelopeFrom: "",
        envelopeTo: "inbox@umail.example.com",
        parsedDate: "2026-08-25T10:00:00.000Z",
        occurredAt: "2026-08-25T11:00:00.000Z",
        forward: { kind: "unknown", destination: "forward@example.net" },
      });
      const registered = yield* registerMcpClient(world, { label: "Reader" });
      const token = yield* issueMcpAccessToken(world, registered);
      const client = yield* connectedMcp(world, token.access_token);
      const listed = yield* callTool(client, { name: "umail_list_threads", arguments: {} });
      expect(listed.isError).not.toBe(true);
      const got = yield* callTool(client, {
        name: "umail_get_thread",
        arguments: { threadId: inbound.threadId },
      });
      const thread = yield* Schema.decodeUnknownEffect(GetThreadToolOutput)(got.structuredContent);
      expect(thread.thread.messages[0]?.id).toBe(inbound.messageId);
      const listedMessages = yield* callTool(client, {
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      const messages = yield* Schema.decodeUnknownEffect(ListMessagesToolOutput)(
        listedMessages.structuredContent,
      );
      const gotMessage = yield* callTool(client, {
        name: "umail_get_message",
        arguments: { messageId: inbound.messageId },
      });
      const message = yield* Schema.decodeUnknownEffect(GetMessageToolOutput)(
        gotMessage.structuredContent,
      );
      const restMessage = yield* Schema.decodeUnknownEffect(ThreadMessage)(
        yield* readJson(
          yield* world.request(
            `http://umail.test/messages/${inbound.messageId}`,
            authorized(world),
          ),
        ),
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
      expect(toJson(messages.page)).not.toContain("textBody");
      yield* callTool(client, {
        name: "umail_set_thread_read_state",
        arguments: { threadId: inbound.threadId, isRead: true },
      });
      const after = yield* callTool(client, {
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      expect(toJson(after.structuredContent)).not.toContain("mcp-in");
    }),
  );

  it.effect("rejects excess fields and body-filter mismatches on MCP tools", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      yield* seedInboundMessage(world, mailbox.id, { id: "filter-in" });
      const registered = yield* registerMcpClient(world, { label: "Filter client" });
      const token = yield* issueMcpAccessToken(world, registered);
      const client = yield* connectedMcp(world, token.access_token);
      const excess = yield* callTool(client, {
        name: "umail_get_thread",
        arguments: { threadId: "filter-in", extra: true },
      });
      expect(excess.isError).toBe(true);
      const bodyless = yield* callTool(client, {
        name: "umail_send_message",
        arguments: {
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com" }],
          subject: "No body",
        },
      });
      expect(bodyless.isError).toBe(true);
      const unread = yield* callTool(client, {
        name: "umail_list_messages",
        arguments: { unread: true },
      });
      expect(toJson(unread.structuredContent)).not.toContain('"direction":"outbound"');
    }),
  );

  it.effect(
    "returns only the scoped header block of an inbound message from umail_get_message_headers",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world, "inbox");
        const probe = yield* seedMailbox(world, "probe");
        const inbound = yield* seedInboundMessage(world, mailbox.id, { id: "headers-in" });
        const outOfScope = yield* seedInboundMessage(world, probe.id, { id: "headers-probe" });
        const headers =
          "From: sender@example.com\r\nSubject: Headers\r\nAuthentication-Results: mx.example; dkim=pass\r\n";
        world.archive.put(
          "raw/headers-in",
          new TextEncoder().encode(`${headers}\r\nBODY-SENTINEL-7f3a\r\n`),
        );
        world.archive.put("raw/headers-probe", new TextEncoder().encode("Subject: probe\r\n\r\n"));
        const submitted = yield* world.request("http://umail.test/submissions", {
          method: "POST",
          headers: jsonHeaders(authorized(world).headers),
          body: toJson({
            intent: "compose",
            requestId: "11111111-1111-4111-8111-111111111111",
            fromAddressId: mailbox.id,
            to: [{ address: "recipient@example.com", displayName: null }],
            subject: "Outbound",
            text: "outbound body",
          }),
        });
        expect(submitted.status).toBe(200);
        const outbound = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
          yield* readJson(submitted),
        );
        const registered = yield* registerMcpClient(world, { label: "Header reader" });
        const token = yield* issueMcpAccessToken(world, registered);
        const client = yield* connectedMcp(world, token.access_token);
        yield* updatePolicy(world, registered.clientId, {
          mailboxes: mailbox.id,
          sendMode: "deny",
          recipients: "any",
        });
        const getHeaders = (args: Record<string, string | boolean>) =>
          callTool(client, { name: "umail_get_message_headers", arguments: args });
        const result = yield* getHeaders({ messageId: inbound.messageId });
        expect(result.isError).not.toBe(true);
        const output = yield* Schema.decodeUnknownEffect(MessageHeaders)(result.structuredContent);
        expect(output).toEqual({ headers, truncated: false });
        const restSource = yield* world.request(
          `http://umail.test/messages/${inbound.messageId}/source`,
          authorized(world),
        );
        expect(output).toEqual(
          headerBlock(new Uint8Array(yield* Effect.promise(() => restSource.arrayBuffer()))),
        );
        expect(toJson(result)).not.toContain("BODY-SENTINEL-7f3a");

        const hidden = yield* getHeaders({ messageId: outOfScope.messageId });
        expect(hidden.isError).toBe(true);
        expect(yield* toolErrorText(hidden)).toBe(
          `Message ${outOfScope.messageId} was not found, or it is outside this client's access.`,
        );

        const noSource = yield* getHeaders({ messageId: outbound.messageId });
        expect(noSource.isError).toBe(true);
        expect(yield* toolErrorText(noSource)).toBe(
          `Message ${outbound.messageId} was sent by AgentMail and has no archived source; only inbound messages are archived.`,
        );

        const excess = yield* getHeaders({ messageId: inbound.messageId, extra: true });
        expect(excess.isError).toBe(true);
      }),
  );

  it.effect("keeps other mailboxes' messages out of a scoped client's thread tools", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      yield* seedInboundMessage(world, inbox.id, {
        id: "shared-root",
        subject: "Visible root",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      yield* seedInboundMessage(world, probe.id, {
        id: "shared-hidden",
        subject: "Hidden reply",
        from: "hidden-sender@example.com",
        inReplyToHeader: "<shared-root@example.com>",
        occurredAt: "2026-01-02T00:00:00.000Z",
      });
      const registered = yield* registerMcpClient(world, { label: "Inbox reader" });
      const token = yield* issueMcpAccessToken(world, registered);
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: inbox.id,
        sendMode: "deny",
        recipients: "any",
      });
      const results = [
        yield* callTool(client, { name: "umail_list_threads", arguments: {} }),
        yield* callTool(client, {
          name: "umail_get_thread",
          arguments: { threadId: "shared-root" },
        }),
        yield* callTool(client, {
          name: "umail_get_thread",
          arguments: { threadId: "shared-hidden" },
        }),
        yield* callTool(client, {
          name: "umail_set_thread_read_state",
          arguments: { threadId: "shared-root", isRead: true },
        }),
      ];
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        const text = toJson(result.structuredContent);
        expect(text).toContain("Visible root");
        expect(text).not.toContain("Hidden reply");
        expect(text).not.toContain("hidden-sender@example.com");
        expect(text).not.toContain(probe.address);
      }
      const thread = yield* Schema.decodeUnknownEffect(GetThreadToolOutput)(
        results[1]?.structuredContent,
      );
      expect(thread.thread.messages.map((message) => message.id)).toEqual(["shared-root"]);
    }),
  );

  it.effect(
    "refuses umail_get_message_headers without read permission before any archive read",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const inbound = yield* seedInboundMessage(world, mailbox.id, { id: "unreadable-in" });
        world.archive.put("raw/unreadable-in", new TextEncoder().encode("Subject: secret\r\n\r\n"));
        const registered = yield* registerMcpClient(world, { label: "No reader" });
        const token = yield* issueMcpAccessToken(world, registered);
        const client = yield* connectedMcp(world, token.access_token);
        yield* updatePolicy(world, registered.clientId, {
          mailboxes: "all",
          canRead: false,
          sendMode: "deny",
          recipients: "any",
        });
        const result = yield* callTool(client, {
          name: "umail_get_message_headers",
          arguments: { messageId: inbound.messageId },
        });
        expect(result.isError).toBe(true);
        expect(yield* toolErrorText(result)).toBe("This client has no read access.");
        expect(world.archive.getCalls).toEqual([]);
      }),
  );

  it.effect("bounds the umail_get_message_headers wire size for a worst-case header block", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id, { id: "huge-headers-in" });
      const source = new Uint8Array(MAX_HEADER_BLOCK_BYTES + 1 + 3).fill(0x01);
      source.set(new TextEncoder().encode("\n\nb"), MAX_HEADER_BLOCK_BYTES + 1);
      world.archive.put("raw/huge-headers-in", source);
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const client = yield* connectedMcp(world, token.access_token);
      const result = yield* callTool(client, {
        name: "umail_get_message_headers",
        arguments: { messageId: inbound.messageId },
      });
      expect(result.isError).not.toBe(true);
      const output = yield* Schema.decodeUnknownEffect(MessageHeaders)(result.structuredContent);
      expect(output.truncated).toBe(true);
      expect(output.headers).toHaveLength(MAX_HEADER_BLOCK_BYTES);
      expect(toJson(result).length).toBeLessThan(3_500_000);
    }),
  );

  it.effect("replies with recipients derived from the parent through umail_reply_to_message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const parent = yield* seedInboundMessage(world, mailbox.id, { id: "reply-parent" });
      const registered = yield* registerMcpClient(world, { label: "Replier" });
      const token = yield* issueMcpAccessToken(world, registered, {
        mailboxes: mailbox.id,
        sendMode: "allow",
      });
      const client = yield* connectedMcp(world, token.access_token);
      yield* updatePolicy(world, registered.clientId, {
        mailboxes: mailbox.id,
        sendMode: "allow",
        recipients: "any",
      });
      const result = yield* callTool(client, {
        name: "umail_reply_to_message",
        arguments: {
          requestId: "11111111-1111-4111-8111-111111111111",
          fromAddressId: mailbox.id,
          replyToMessageId: parent.messageId,
          replyMode: "reply",
          subject: "Re: Subject reply-parent",
          text: "reply body",
        },
      });
      expect(result.isError).not.toBe(true);
      const { job } = yield* Schema.decodeUnknownEffect(JobToolOutput)(result.structuredContent);
      expect(job.state).toBe("ready");
      expect(job.threadId).toBe(parent.threadId);
      const reply = yield* Schema.decodeUnknownEffect(ThreadMessage)(
        yield* readJson(
          yield* world.request(`http://umail.test/messages/${job.messageId}`, authorized(world)),
        ),
      );
      expect(reply.to.map((contact) => contact.address)).toEqual(["sender@example.com"]);
    }),
  );

  it.effect("pages a thread from umail_get_thread given any message id in it", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const root = yield* seedInboundMessage(world, mailbox.id, {
        id: "thread-root",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      const child = yield* seedInboundMessage(world, mailbox.id, {
        id: "thread-child",
        occurredAt: "2026-01-02T00:00:00.000Z",
        inReplyToHeader: "<thread-root@example.com>",
      });
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const client = yield* connectedMcp(world, token.access_token);
      const getThread = Effect.fn("getThread")(function* (args: Record<string, unknown>) {
        const result = yield* callTool(client, { name: "umail_get_thread", arguments: args });
        return (yield* Schema.decodeUnknownEffect(GetThreadToolOutput)(result.structuredContent))
          .thread;
      });
      const first = yield* getThread({ threadId: child.messageId, limit: 1 });
      expect(first.threadId).toBe(root.threadId);
      expect(first.messages.map((message) => message.id)).toEqual(["thread-root"]);
      const second = yield* getThread({
        threadId: child.messageId,
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.messages.map((message) => message.id)).toEqual(["thread-child"]);
      expect(second.nextCursor).toBeNull();
    }),
  );

  it.effect("drops htmlBody from umail_get_message when a text body exists", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const both = yield* seedInboundMessage(world, mailbox.id, {
        id: "text-and-html",
        htmlBody: "<p>html</p>",
      });
      const htmlOnly = yield* seedInboundMessage(world, mailbox.id, {
        id: "html-only",
        textBody: null,
        htmlBody: "<p>only html</p>",
      });
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const client = yield* connectedMcp(world, token.access_token);
      const getMessage = Effect.fn("getMessage")(function* (messageId: string) {
        const result = yield* callTool(client, {
          name: "umail_get_message",
          arguments: { messageId },
        });
        return (yield* Schema.decodeUnknownEffect(GetMessageToolOutput)(result.structuredContent))
          .message;
      });
      expect(yield* getMessage(both.messageId)).toMatchObject({ textBody: "text", htmlBody: null });
      expect(yield* getMessage(htmlOnly.messageId)).toMatchObject({
        textBody: null,
        htmlBody: "<p>only html</p>",
      });
    }),
  );

  it.effect("maps a plain ThreadNotFoundError envelope from the store to the not-found text", () =>
    Effect.gen(function* () {
      const world = yield* createWorld({
        account: {
          listThreadMessageSummaries: () =>
            failOverRpc({ _tag: "ThreadNotFoundError", threadId: "missing" }),
        },
      });
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const client = yield* connectedMcp(world, token.access_token);
      const result = yield* callTool(client, {
        name: "umail_get_thread",
        arguments: { threadId: "missing" },
      });
      expect(result.isError).toBe(true);
      expect(yield* toolErrorText(result)).toBe(
        "Thread missing was not found, or it is outside this client's access.",
      );
    }),
  );

  it.effect("answers a generic failure and logs once in the tool helper for an RpcCallError", () =>
    Effect.gen(function* () {
      const logs: Array<{ readonly message: unknown; readonly defect: unknown }> = [];
      const capture = Logger.make(({ message, cause }) => {
        logs.push({ message, defect: Cause.squash(cause) });
      });
      const world = yield* createWorld({
        account: {
          listSendingIdentities: () =>
            failOverRpc(
              new RpcCallError({ method: "listSendingIdentities", cause: new Error("DO reset") }),
            ),
        },
        requestContext: Context.make(Logger.CurrentLoggers, new Set([capture])),
      });
      const token = yield* issueMcpAccessToken(world, yield* registerMcpClient(world));
      const client = yield* connectedMcp(world, token.access_token);
      logs.length = 0;
      const result = yield* callTool(client, {
        name: "umail_list_sending_identities",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(yield* toolErrorText(result)).toBe("The AgentMail API request failed.");
      expect(toJson(result)).not.toContain("DO reset");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.message).toEqual(["MCP tool failed"]);
      expect(logs[0]?.defect).toBeInstanceOf(RpcCallError);
    }),
  );

  it.effect("serves exact MCP protected-resource metadata without registration discovery", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request(
        "http://umail.test/.well-known/oauth-protected-resource/mcp",
      );
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
        yield* readJson(response),
      );
      expect(body.resource).toBe("https://umail.test/mcp");
      expect(body).not.toHaveProperty("registration_endpoint");
    }),
  );
});

// Saves a policy through the client's page, as the operator would.
const updatePolicy = Effect.fn("updatePolicy")(function* (
  world: World,
  clientId: string,
  input: {
    readonly mailboxes: string;
    readonly canRead?: boolean;
    readonly sendMode: "deny" | "allow" | "requireApproval";
    readonly recipients: string;
    readonly preapproved?: string;
  },
) {
  const body = new URLSearchParams({
    mailboxScope: input.mailboxes === "all" ? "all" : "some",
    sendMode: input.sendMode,
    recipientScope: input.recipients === "any" ? "any" : "some",
    recipients: input.recipients === "any" ? "" : input.recipients,
    preapproved: input.preapproved ?? "",
  });
  if (input.mailboxes !== "all") {
    for (const id of input.mailboxes.split(",")) body.append("mailbox", id.trim());
  }
  if (input.canRead !== false) {
    body.set("canRead", "on");
  }
  const response = yield* world.request(
    `http://umail.test/clients/${encodeURIComponent(clientId)}`,
    {
      method: "POST",
      redirect: "manual",
      headers: operatorCookieHeaders(world.sessionCookie, {
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: body.toString(),
    },
  );
  expect(response.status, yield* readText(response.clone())).toBe(303);
});

function rawToolsList(world: World, token: string) {
  return world.request("http://umail.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: toJson({ jsonrpc: JSONRPC_VERSION, id: 1, method: "tools/list" }),
  });
}

function failOverRpc(error: unknown): Effect.Effect<never, AccountStoreError> {
  return Effect.fail(error as AccountStoreError);
}

function query(world: World, sql: string, ...params: ReadonlyArray<string>) {
  return Effect.promise(() => world.db.all(sql, ...params));
}

function listTools(client: Client) {
  return Effect.promise(() => client.listTools());
}

function callTool(client: Client, params: Parameters<Client["callTool"]>[0]) {
  return Effect.promise(() => client.callTool(params));
}

const toolErrorText = Effect.fn("toolErrorText")(function* (
  result: Effect.Success<ReturnType<typeof callTool>>,
) {
  const body = yield* Schema.decodeUnknownEffect(ToolErrorBody)(yield* parseTextResult(result));
  return body.error;
});

const parseTextResult = Effect.fn("parseTextResult")(function* (
  result: Effect.Success<ReturnType<typeof callTool>>,
) {
  const content = result.content[0];
  if (content?.type !== "text") return yield* Effect.die("Expected one MCP text result block");
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(content.text);
});
