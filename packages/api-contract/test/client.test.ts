import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CreateAddressPayload, ListMessagesQuery, ListThreadsQuery } from "../src/api-spec.ts";
import { configFromEnvironment, makeUmailClient, type UmailClientConfig } from "../src/client.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly accessClientId: string | undefined;
  readonly accessClientSecret: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
  readonly body: string | undefined;
}

function jsonBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag === "Uint8Array") {
    return new TextDecoder().decode(request.body.body);
  }
  return undefined;
}

function testHttpClient(captured: Array<CapturedRequest>) {
  return HttpClient.make((request, url) => {
    captured.push({
      method: request.method,
      url: url.toString(),
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      accessClientId: request.headers["cf-access-client-id"],
      accessClientSecret: request.headers["cf-access-client-secret"],
      origin: request.headers.origin,
      cookie: request.headers.cookie,
      body: jsonBody(request),
    });
    let body = "[]";
    if (request.method === "POST") {
      body = JSON.stringify({
        id: "address-1",
        localPart: "inbox",
        address: "inbox@umail.example.test",
        displayName: null,
        active: true,
        forwardingDestinationId: null,
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:00.000Z",
      });
    } else if (url.pathname === "/threads") {
      body = JSON.stringify({ items: [], nextCursor: "next cursor" });
    } else if (url.pathname === "/messages") {
      body = JSON.stringify({ items: [], nextCursor: "next message cursor" });
    } else if (url.pathname === "/messages/message-1") {
      body = JSON.stringify({
        direction: "inbound",
        id: "message-1",
        threadId: "node:550e8400-e29b-41d4-a716-446655440000",
        parentMessageId: null,
        addressId: "address-1",
        subject: "Hello",
        occurredAt: "2026-08-25T10:00:00.000Z",
        deletedAt: null,
        from: [{ address: "sender@example.com", displayName: null }],
        replyTo: [],
        to: [{ address: "inbox@umail.example.test", displayName: "Inbox" }],
        cc: [],
        textBody: "Hi",
        htmlBody: null,
        hasRemoteImages: false,
        rfcMessageId: "<message-1@example.com>",
        inReplyToRfcMessageId: null,
        references: [],
        attachments: [],
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:00.000Z",
        envelopeFrom: "sender@example.com",
        envelopeTo: "inbox@umail.example.test",
        parsedDate: "2026-08-25T10:00:00.000Z",
        processingState: "indexed",
        processingError: null,
        isRead: false,
        readAt: null,
        forwardOutcome: "none",
        forwardDestination: null,
      });
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { "content-type": "application/json" } }),
      ),
    );
  });
}

describe("shared AgentMail API client", () => {
  it("constructs root URLs and adds only the exact bearer and JSON headers", async () => {
    const captured: Array<CapturedRequest> = [];
    const config = {
      baseUrl: "https://umail.example.test",
      accessToken: Redacted.make("oauth-access-token"),
    } satisfies UmailClientConfig;
    const client = await Effect.runPromise(makeUmailClient(config, testHttpClient(captured)));

    await Effect.runPromise(client.Addresses.listAddresses({}));
    await Effect.runPromise(
      client.Addresses.createAddress({
        payload: new CreateAddressPayload({ localPart: "inbox" }),
      }),
    );
    const page = await Effect.runPromise(
      client.Threads.listThreads({
        query: new ListThreadsQuery({ limit: 25, cursor: "cursor with +/=" }),
      }),
    );
    const messages = await Effect.runPromise(
      client.Messages.listMessages({
        query: new ListMessagesQuery({
          direction: "inbound",
          addressId: "address-1",
          since: "2026-08-25T00:00:00.000Z",
          unread: true,
          limit: 10,
          cursor: "cursor with +/=",
        }),
      }),
    );
    const message = await Effect.runPromise(
      client.Messages.getMessage({ params: { id: "message-1" } }),
    );

    expect(captured).toHaveLength(5);
    expect(captured[0]).toMatchObject({
      method: "GET",
      url: "https://umail.example.test/addresses",
    });
    expect(captured[1]).toMatchObject({
      method: "POST",
      url: "https://umail.example.test/addresses",
    });
    expect(JSON.parse(captured[1]?.body ?? "")).toEqual({ localPart: "inbox" });
    const threadsUrl = new URL(captured[2]?.url ?? "");
    expect(threadsUrl.pathname).toBe("/threads");
    expect(threadsUrl.searchParams.get("limit")).toBe("25");
    expect(threadsUrl.searchParams.get("cursor")).toBe("cursor with +/=");
    expect(page).toEqual({ items: [], nextCursor: "next cursor" });
    const messagesUrl = new URL(captured[3]?.url ?? "");
    expect(captured[3]?.method).toBe("GET");
    expect(messagesUrl.pathname).toBe("/messages");
    expect(messagesUrl.searchParams.get("direction")).toBe("inbound");
    expect(messagesUrl.searchParams.get("addressId")).toBe("address-1");
    expect(messagesUrl.searchParams.get("since")).toBe("2026-08-25T00:00:00.000Z");
    expect(messagesUrl.searchParams.get("unread")).toBe("true");
    expect(messagesUrl.searchParams.get("limit")).toBe("10");
    expect(messagesUrl.searchParams.get("cursor")).toBe("cursor with +/=");
    expect(messagesUrl.searchParams.has("until")).toBe(false);
    expect(messages).toEqual({ items: [], nextCursor: "next message cursor" });
    expect(captured[4]).toMatchObject({
      method: "GET",
      url: "https://umail.example.test/messages/message-1",
    });
    expect(message.id).toBe("message-1");
    expect(message.textBody).toBe("Hi");
    expect(message.direction).toBe("inbound");
    if (message.direction === "inbound") {
      expect(message).toMatchObject({
        envelopeFrom: "sender@example.com",
        envelopeTo: "inbox@umail.example.test",
        parsedDate: "2026-08-25T10:00:00.000Z",
        processingState: "indexed",
        processingError: null,
        forwardOutcome: "none",
        forwardDestination: null,
      });
    }

    for (const request of captured) {
      expect(request.authorization).toBe("Bearer oauth-access-token");
      expect(request.contentType).toBe("application/json");
      expect(request.accessClientId).toBeUndefined();
      expect(request.accessClientSecret).toBeUndefined();
      expect(request.origin).toBeUndefined();
      expect(request.cookie).toBeUndefined();
    }
  });

  it("keeps the OAuth access token redacted outside the request header boundary", () => {
    const tokenValue = "access-token-that-must-not-render";
    const config = {
      baseUrl: "https://umail.example.test",
      accessToken: Redacted.make(tokenValue),
    } satisfies UmailClientConfig;

    expect(Redacted.isRedacted(config.accessToken)).toBe(true);
    expect(JSON.stringify(config)).not.toContain(tokenValue);
    expect(JSON.stringify(config.accessToken)).not.toContain(tokenValue);
  });
});

describe("shared client configuration", () => {
  it.each([
    "http://umail.example.test",
    "http://192.168.1.2:8787",
    "http://localhost.example.test",
    "http://[2001:db8::1]",
  ])("rejects plaintext non-loopback origin %s", async (origin) => {
    await expect(Effect.runPromise(configFromEnvironment({ UMAIL_URL: origin }))).rejects.toThrow(
      "UMAIL_URL must use HTTPS except on localhost, 127.0.0.1, or [::1]",
    );
  });

  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
    "https://umail.example.test",
    "https://192.168.1.2:8787",
  ])("accepts secure or loopback origin %s", async (origin) => {
    await expect(Effect.runPromise(configFromEnvironment({ UMAIL_URL: origin }))).resolves.toEqual({
      baseUrl: origin,
    });
  });

  it("accepts only a valid configured origin", async () => {
    const configured = await Effect.runPromise(
      configFromEnvironment({ UMAIL_URL: "https://umail.example.test/" }),
    );

    expect(configured.baseUrl).toBe("https://umail.example.test");
  });

  it("reports safe errors for missing or invalid environment values", async () => {
    await expect(Effect.runPromise(configFromEnvironment({}))).rejects.toThrow(
      "UMAIL_URL is required",
    );
    await expect(
      Effect.runPromise(configFromEnvironment({ UMAIL_URL: "not a URL" })),
    ).rejects.toThrow("UMAIL_URL must be a valid HTTP(S) origin");
    await expect(
      Effect.runPromise(configFromEnvironment({ UMAIL_URL: "https://umail.example.test/api" })),
    ).rejects.toThrow("UMAIL_URL must be a valid HTTP(S) origin");
  });
});
