import { ListMessagesQuery, ListThreadsQuery, type Principal } from "@umail/api-contract";
import {
  UmailMcpClientFailure,
  type UmailListMessagesRequest,
  type UmailListThreadsRequest,
  type UmailMcpClient,
} from "@umail/mcp-tools";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ApiDeps } from "../app.ts";
import {
  getJob,
  getMessage,
  getMessageHeaders,
  getThread,
  listMessages,
  listSendingIdentities,
  listThreadMessages,
  listThreads,
  sendMessage,
  setThreadReadState,
  submitMessage,
} from "../operations.ts";

interface McpMappedFailure {
  readonly _tag: string;
}

type UmailListThreadsQueryFields = {
  limit?: number;
  cursor?: string;
};

type UmailListMessagesQueryFields = {
  direction?: "inbound" | "outbound";
  addressId?: string;
  since?: string;
  unread?: boolean;
  limit?: number;
  cursor?: string;
};

function failureKindFromTag(tag: string) {
  switch (tag) {
    case "Forbidden":
      return "forbidden" as const;
    case "NotFound":
      return "not_found" as const;
    case "OutboundMessageHasNoSource":
      return "no_source" as const;
    case "ApiProblem":
      return "failed" as const;
    case "Conflict":
      return "failed" as const;
    default:
      return "failed" as const;
  }
}

function asClientFailure<A, E extends McpMappedFailure, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.mapError(
    effect,
    (error) => new UmailMcpClientFailure({ kind: failureKindFromTag(error._tag) }),
  );
}

export function makeInProcessUmailMcpClient(deps: ApiDeps, principal: Principal): UmailMcpClient {
  const mcpClient = {
    listSendingIdentities: asClientFailure(listSendingIdentities(deps, principal)),
    listThreads: (request: UmailListThreadsRequest) => {
      const queryFields: UmailListThreadsQueryFields = {};
      if (request.limit !== undefined) {
        queryFields.limit = request.limit;
      }
      if (request.cursor !== undefined) {
        queryFields.cursor = request.cursor;
      }
      const query = new ListThreadsQuery(queryFields);
      return asClientFailure(listThreads(deps, principal, query.limit, query.cursor));
    },
    listMessages: (request: UmailListMessagesRequest) => {
      const queryFields: UmailListMessagesQueryFields = {};
      if (request.direction !== undefined) {
        queryFields.direction = request.direction;
      }
      if (request.addressId !== undefined) {
        queryFields.addressId = request.addressId;
      }
      if (request.since !== undefined) {
        queryFields.since = request.since;
      }
      if (request.unread !== undefined) {
        queryFields.unread = request.unread;
      }
      if (request.limit !== undefined) {
        queryFields.limit = request.limit;
      }
      if (request.cursor !== undefined) {
        queryFields.cursor = request.cursor;
      }
      return asClientFailure(listMessages(deps, principal, new ListMessagesQuery(queryFields)));
    },
    getThread: (threadId: string) => asClientFailure(getThread(deps, principal, threadId)),
    listThreadMessages: (threadId: string, request: UmailListThreadsRequest) => {
      const queryFields: UmailListThreadsQueryFields = {};
      if (request.limit !== undefined) {
        queryFields.limit = request.limit;
      }
      if (request.cursor !== undefined) {
        queryFields.cursor = request.cursor;
      }
      return asClientFailure(
        listThreadMessages(deps, principal, threadId, new ListThreadsQuery(queryFields)),
      );
    },
    getMessage: (messageId: string) => asClientFailure(getMessage(deps, principal, messageId)),
    getMessageHeaders: (messageId: string) =>
      asClientFailure(getMessageHeaders(deps, principal, messageId)),
    setThreadReadState: (threadId: string, isRead: boolean) =>
      asClientFailure(setThreadReadState(deps, principal, threadId, isRead)),
    sendMessage: (payload) => asClientFailure(sendMessage(deps, principal, payload)),
    submitMessage: (payload) => asClientFailure(submitMessage(deps, principal, payload)),
    getJob: (jobId: string) => asClientFailure(getJob(deps, principal, jobId)),
  } satisfies UmailMcpClient;
  return mcpClient;
}

export function provideRequestContext<R>(
  client: UmailMcpClient,
  services: Context.Context<R>,
): UmailMcpClient {
  return {
    listSendingIdentities: Effect.provideContext(client.listSendingIdentities, services),
    listThreads: (request) => Effect.provideContext(client.listThreads(request), services),
    listMessages: (request) => Effect.provideContext(client.listMessages(request), services),
    getThread: (threadId) => Effect.provideContext(client.getThread(threadId), services),
    listThreadMessages: (threadId, request) =>
      Effect.provideContext(client.listThreadMessages(threadId, request), services),
    getMessage: (messageId) => Effect.provideContext(client.getMessage(messageId), services),
    getMessageHeaders: (messageId) =>
      Effect.provideContext(client.getMessageHeaders(messageId), services),
    setThreadReadState: (threadId, isRead) =>
      Effect.provideContext(client.setThreadReadState(threadId, isRead), services),
    sendMessage: (payload) => Effect.provideContext(client.sendMessage(payload), services),
    submitMessage: (payload) => Effect.provideContext(client.submitMessage(payload), services),
    getJob: (jobId) => Effect.provideContext(client.getJob(jobId), services),
  } satisfies UmailMcpClient;
}
