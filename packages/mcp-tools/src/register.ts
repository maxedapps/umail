import {
  ListMessagesQuery,
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
import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { UmailListThreadsRequest, UmailMcpClient, UmailMcpClientFailure } from "./client.ts";

const ListSendingIdentitiesInput = Schema.Record(Schema.String, Schema.Never).annotate({
  identifier: "ListSendingIdentitiesInput",
});

class ListSendingIdentitiesOutput extends Schema.Class<ListSendingIdentitiesOutput>(
  "ListSendingIdentitiesOutput",
)({
  sendingIdentities: Schema.Array(SendingIdentity),
}) {}

class ListThreadsInput extends Schema.Class<ListThreadsInput>("ListThreadsInput")({
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

class ListThreadsOutput extends Schema.Class<ListThreadsOutput>("ListThreadsOutput")({
  page: MailThreadPage,
}) {}

class ListMessagesOutput extends Schema.Class<ListMessagesOutput>("ListMessagesOutput")({
  page: MailMessagePage,
}) {}

class GetThreadInput extends Schema.Class<GetThreadInput>("GetThreadInput")({
  threadId: Schema.String,
}) {}

class GetThreadOutput extends Schema.Class<GetThreadOutput>("GetThreadOutput")({
  thread: MailThreadDetail,
}) {}

class ListThreadMessagesInput extends Schema.Class<ListThreadMessagesInput>(
  "ListThreadMessagesInput",
)({
  threadId: Schema.String,
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

class ListThreadMessagesOutput extends Schema.Class<ListThreadMessagesOutput>(
  "ListThreadMessagesOutput",
)({
  page: MailThreadMessagePage,
}) {}

class GetMessageInput extends Schema.Class<GetMessageInput>("GetMessageInput")({
  messageId: Schema.String,
}) {}

class GetMessageOutput extends Schema.Class<GetMessageOutput>("GetMessageOutput")({
  message: ThreadMessage,
}) {}

class GetMessageHeadersInput extends Schema.Class<GetMessageHeadersInput>("GetMessageHeadersInput")(
  {
    messageId: Schema.String,
  },
) {}

class GetMessageHeadersOutput extends Schema.Class<GetMessageHeadersOutput>(
  "GetMessageHeadersOutput",
)(MessageHeaders.fields) {}

class SetThreadReadStateInput extends Schema.Class<SetThreadReadStateInput>(
  "SetThreadReadStateInput",
)({
  threadId: Schema.String,
  isRead: Schema.Boolean,
}) {}

class SetThreadReadStateOutput extends Schema.Class<SetThreadReadStateOutput>(
  "SetThreadReadStateOutput",
)({
  thread: MailThreadDetail,
}) {}

class SendMessageOutput extends Schema.Class<SendMessageOutput>("SendMessageOutput")({
  job: OutboundJobStatus,
}) {}

class SubmitMessageOutput extends Schema.Class<SubmitMessageOutput>("SubmitMessageOutput")({
  job: OutboundJobStatus,
}) {}

class GetJobInput extends Schema.Class<GetJobInput>("GetJobInput")({
  jobId: Schema.String,
}) {}

class GetJobOutput extends Schema.Class<GetJobOutput>("GetJobOutput")({
  job: OutboundJobStatus,
}) {}

type UmailMcpToolOutput =
  | ListSendingIdentitiesOutput
  | ListThreadsOutput
  | ListMessagesOutput
  | GetThreadOutput
  | ListThreadMessagesOutput
  | GetMessageOutput
  | GetMessageHeadersOutput
  | SetThreadReadStateOutput
  | SendMessageOutput
  | SubmitMessageOutput
  | GetJobOutput;

const strictMcpParseOptions = {
  parseOptions: { onExcessProperty: "error" },
} as const;

const listSendingIdentitiesInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListSendingIdentitiesInput, strictMcpParseOptions),
);
const listSendingIdentitiesOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListSendingIdentitiesOutput, strictMcpParseOptions),
);
const listThreadsInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListThreadsInput, strictMcpParseOptions),
);
const listThreadsOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListThreadsOutput, strictMcpParseOptions),
);
const listMessagesInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListMessagesQuery, strictMcpParseOptions),
);
const listMessagesOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListMessagesOutput, strictMcpParseOptions),
);
const getThreadInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetThreadInput, strictMcpParseOptions),
);
const getThreadOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetThreadOutput, strictMcpParseOptions),
);
const listThreadMessagesInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListThreadMessagesInput, strictMcpParseOptions),
);
const listThreadMessagesOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(ListThreadMessagesOutput, strictMcpParseOptions),
);
const getMessageInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetMessageInput, strictMcpParseOptions),
);
const getMessageOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetMessageOutput, strictMcpParseOptions),
);
const getMessageHeadersInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetMessageHeadersInput, strictMcpParseOptions),
);
const getMessageHeadersOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetMessageHeadersOutput, strictMcpParseOptions),
);
const setThreadReadStateInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SetThreadReadStateInput, strictMcpParseOptions),
);
const setThreadReadStateOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SetThreadReadStateOutput, strictMcpParseOptions),
);
const sendMessageInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SendMessagePayload, strictMcpParseOptions),
);
const sendMessageOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SendMessageOutput, strictMcpParseOptions),
);
const submitMessageInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SubmitMessagePayload, strictMcpParseOptions),
);
const submitMessageOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(SubmitMessageOutput, strictMcpParseOptions),
);
const getJobInput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetJobInput, strictMcpParseOptions),
);
const getJobOutput = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(GetJobOutput, strictMcpParseOptions),
);

type ThreadMessageListRequestDraft = {
  limit?: number;
  cursor?: string;
};

function threadMessageListRequest(input: ListThreadMessagesInput): UmailListThreadsRequest {
  const request: ThreadMessageListRequestDraft = {};
  if (input.limit !== undefined) {
    request.limit = input.limit;
  }
  if (input.cursor !== undefined) {
    request.cursor = input.cursor;
  }
  return request;
}

function successResult(output: UmailMcpToolOutput): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function failureMessage(kind: UmailMcpClientFailure["kind"]) {
  switch (kind) {
    case "forbidden":
      return "The request is not permitted.";
    case "not_found":
      return "The requested resource was not found.";
    case "no_source":
      return "The message has no archived source; only inbound messages are archived.";
    case "failed":
      return "The AgentMail API request failed.";
  }
}

function failureResult(failure: UmailMcpClientFailure): CallToolResult {
  const error = { error: failureMessage(failure.kind) };
  return {
    content: [{ type: "text", text: JSON.stringify(error) }],
    isError: true,
  };
}

function runClientEffect(
  effect: Effect.Effect<UmailMcpToolOutput, UmailMcpClientFailure>,
  signal: AbortSignal,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: failureResult,
        onSuccess: successResult,
      }),
    ),
    { signal },
  );
}

export function registerUmailTools(server: McpServer, client: UmailMcpClient) {
  server.registerTool(
    "umail_list_sending_identities",
    {
      description: "List mailbox identities that can send AgentMail messages.",
      inputSchema: listSendingIdentitiesInput,
      outputSchema: listSendingIdentitiesOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_input, ctx) =>
      runClientEffect(
        Effect.map(client.listSendingIdentities, (sendingIdentities) => ({
          sendingIdentities,
        })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_list_threads",
    {
      description: "List AgentMail threads, optionally continuing a paginated result.",
      inputSchema: listThreadsInput,
      outputSchema: listThreadsOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.listThreads(input), (page) => ({ page })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_list_messages",
    {
      description: "List AgentMail messages, optionally continuing a paginated result.",
      inputSchema: listMessagesInput,
      outputSchema: listMessagesOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.listMessages(input), (page) => ({ page })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_get_thread",
    {
      description: "Get one AgentMail thread and its messages.",
      inputSchema: getThreadInput,
      outputSchema: getThreadOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.getThread(input.threadId), (thread) => ({ thread })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_list_thread_messages",
    {
      description: "List one page of messages in a AgentMail thread.",
      inputSchema: listThreadMessagesInput,
      outputSchema: listThreadMessagesOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(
          client.listThreadMessages(input.threadId, threadMessageListRequest(input)),
          (page) => ({ page }),
        ),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_get_message",
    {
      description: "Get one AgentMail message.",
      inputSchema: getMessageInput,
      outputSchema: getMessageOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.getMessage(input.messageId), (message) => ({ message })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_get_message_headers",
    {
      description:
        "Get the raw header block of one inbound AgentMail message, decoded and bounded; `truncated` reports when the bound cut it short. Outbound messages have no archived source.",
      inputSchema: getMessageHeadersInput,
      outputSchema: getMessageHeadersOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) => runClientEffect(client.getMessageHeaders(input.messageId), ctx.mcpReq.signal),
  );

  server.registerTool(
    "umail_set_thread_read_state",
    {
      description: "Mark one AgentMail thread as read or unread.",
      inputSchema: setThreadReadStateInput,
      outputSchema: setThreadReadStateOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.setThreadReadState(input.threadId, input.isRead), (thread) => ({
          thread,
        })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_send_message",
    {
      description:
        "Compose or reply as a durable job. Returns the submission identity; acceptance is recorded later.",
      inputSchema: sendMessageInput,
      outputSchema: sendMessageOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.sendMessage(input), (job) => ({ job })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_submit_message",
    {
      description:
        "Submit a compose or reply job. Returns the durable submission identity; acceptance is recorded later.",
      inputSchema: submitMessageInput,
      outputSchema: submitMessageOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.submitMessage(input), (job) => ({ job })),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "umail_get_job",
    {
      description: "Get the status of one outbound job owned by the caller or operator.",
      inputSchema: getJobInput,
      outputSchema: getJobOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runClientEffect(
        Effect.map(client.getJob(input.jobId), (job) => ({ job })),
        ctx.mcpReq.signal,
      ),
  );
}
