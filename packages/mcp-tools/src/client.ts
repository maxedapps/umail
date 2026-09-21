import type {
  MailMessagePage,
  MailThreadDetail,
  MailThreadMessagePage,
  MailThreadPage,
  MessageHeaders,
  OutboundJobStatus,
  SendMessagePayload,
  SendingIdentity,
  SubmitMessagePayload,
  ThreadMessage,
} from "@umail/api-contract";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export type UmailMcpClientFailureKind = "forbidden" | "not_found" | "no_source" | "failed";

interface UmailMcpClientFailureFields {
  readonly kind: UmailMcpClientFailureKind;
}

export class UmailMcpClientFailure extends Data.TaggedError(
  "UmailMcpClientFailure",
)<UmailMcpClientFailureFields> {}

export interface UmailListThreadsRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface UmailListMessagesRequest {
  readonly direction?: "inbound" | "outbound";
  readonly addressId?: string;
  readonly since?: string;
  readonly unread?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface UmailMcpClient {
  readonly listSendingIdentities: Effect.Effect<
    ReadonlyArray<SendingIdentity>,
    UmailMcpClientFailure
  >;
  readonly listThreads: (
    request: UmailListThreadsRequest,
  ) => Effect.Effect<MailThreadPage, UmailMcpClientFailure>;
  readonly listMessages: (
    request: UmailListMessagesRequest,
  ) => Effect.Effect<MailMessagePage, UmailMcpClientFailure>;
  readonly getThread: (threadId: string) => Effect.Effect<MailThreadDetail, UmailMcpClientFailure>;
  readonly listThreadMessages: (
    threadId: string,
    request: UmailListThreadsRequest,
  ) => Effect.Effect<MailThreadMessagePage, UmailMcpClientFailure>;
  readonly getMessage: (messageId: string) => Effect.Effect<ThreadMessage, UmailMcpClientFailure>;
  readonly getMessageHeaders: (
    messageId: string,
  ) => Effect.Effect<MessageHeaders, UmailMcpClientFailure>;
  readonly setThreadReadState: (
    threadId: string,
    isRead: boolean,
  ) => Effect.Effect<MailThreadDetail, UmailMcpClientFailure>;
  readonly sendMessage: (
    payload: SendMessagePayload,
  ) => Effect.Effect<OutboundJobStatus, UmailMcpClientFailure>;
  readonly submitMessage: (
    payload: SubmitMessagePayload,
  ) => Effect.Effect<OutboundJobStatus, UmailMcpClientFailure>;
  readonly getJob: (jobId: string) => Effect.Effect<OutboundJobStatus, UmailMcpClientFailure>;
}
