import {
  ListMessagesQuery,
  MailMessagePage,
  MailThreadDetail,
  MailThreadPage,
  MessageHeaders,
  OutboundJobStatus,
  SendingIdentity,
  ThreadMessage,
  composeFields,
  hasMessageBody,
  replyFields,
  type ApiError,
  type Principal,
} from "@umail/api-contract";
import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type * as Alchemy from "alchemy";
import type * as Crypto from "effect/Crypto";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ApiDeps } from "../app.ts";
import {
  getJob,
  getMessage,
  getMessageHeaders,
  getThread,
  listMessages,
  listSendingIdentities,
  listThreads,
  setThreadReadState,
  submitMessage,
} from "../operations.ts";

const threadId = Schema.String.annotate({
  description: "A thread id or any message id in the thread.",
});
const messageId = Schema.String.annotate({ description: "A message id from a list or thread." });
const pageFields = {
  limit: Schema.optionalKey(Schema.Int.annotate({ description: "Page size, 1-200 (default 50)." })),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: "nextCursor from the previous page." }),
  ),
};
const fromAddressId = Schema.String.annotate({
  description: "Sending identity id from umail_list_sending_identities.",
});

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const sends: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
const UNEXPECTED_FAILURE = "The AgentMail tool failed unexpectedly.";
const UNKNOWN_SEND_OUTCOME =
  "The message may or may not have been queued. Resubmit with the same requestId and content to get the existing job; it will never send twice.";

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerTools(
  server: McpServer,
  deps: ApiDeps,
  principal: Principal,
  services: Context.Context<Crypto.Crypto | Alchemy.RuntimeContext>,
) {
  const run = Effect.runPromiseWith(services);

  function tool<In, Out extends Record<string, unknown>>(
    name: string,
    config: {
      readonly description: string;
      readonly annotations: ToolAnnotations;
      readonly input: Schema.ConstraintDecoder<In>;
      readonly output: Schema.ConstraintDecoder<Out>;
    },
    handler: (input: In) => Effect.Effect<Out, ApiError, Crypto.Crypto | Alchemy.RuntimeContext>,
  ) {
    // API errors carry client-safe messages written where the cause is known, so they are passed
    // through. Anything else is logged and answered with a fixed text; for a send, it says how to
    // find out whether the message was queued.
    const unexpected =
      config.annotations.destructiveHint === true
        ? `${UNEXPECTED_FAILURE} ${UNKNOWN_SEND_OUTCOME}`
        : UNEXPECTED_FAILURE;
    server.registerTool(
      name,
      {
        description: config.description,
        annotations: config.annotations,
        inputSchema: Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(config.input, strict)),
        outputSchema: Schema.toStandardJSONSchemaV1(
          Schema.toStandardSchemaV1(config.output, strict),
        ),
      },
      (input, ctx) =>
        run(
          Effect.suspend(() => handler(input)).pipe(
            Effect.map((output): CallToolResult => ({
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            })),
            Effect.catch((error) => Effect.succeed(toolError(error.message))),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logError("MCP tool failed", cause), toolError(unexpected)),
            ),
            Effect.annotateLogs({ tool: name, clientId: principal.identity.clientId }),
          ),
          { signal: ctx.mcpReq.signal },
        ),
    );
  }

  tool(
    "umail_list_sending_identities",
    {
      description: "List mailbox identities this client may send from.",
      annotations: { ...readOnly, openWorldHint: false },
      input: Schema.Record(Schema.String, Schema.Never),
      output: Schema.Struct({ sendingIdentities: Schema.Array(SendingIdentity) }),
    },
    () =>
      Effect.map(listSendingIdentities(deps, principal), (sendingIdentities) => ({
        sendingIdentities,
      })),
  );

  tool(
    "umail_list_threads",
    {
      description: "List threads, newest activity first.",
      annotations: readOnly,
      input: Schema.Struct(pageFields),
      output: Schema.Struct({ page: MailThreadPage }),
    },
    (input) =>
      Effect.map(listThreads(deps, principal, input.limit, input.cursor), (page) => ({ page })),
  );

  tool(
    "umail_list_messages",
    {
      description: "List message summaries (no bodies), newest first.",
      annotations: readOnly,
      input: Schema.Struct({ ...ListMessagesQuery.fields, ...pageFields }),
      output: Schema.Struct({ page: MailMessagePage }),
    },
    (input) => Effect.map(listMessages(deps, principal, input), (page) => ({ page })),
  );

  tool(
    "umail_get_thread",
    {
      description: "Get one page of message summaries (no bodies) in a thread, oldest first.",
      annotations: readOnly,
      input: Schema.Struct({ threadId, ...pageFields }),
      output: Schema.Struct({ thread: MailThreadDetail }),
    },
    ({ threadId, ...query }) =>
      Effect.map(getThread(deps, principal, threadId, query), (thread) => ({ thread })),
  );

  tool(
    "umail_get_message",
    {
      description:
        "Get one message with its body. htmlBody is null whenever textBody is present; it is returned only for HTML-only messages.",
      annotations: readOnly,
      input: Schema.Struct({ messageId }),
      output: Schema.Struct({ message: ThreadMessage }),
    },
    (input) =>
      Effect.map(getMessage(deps, principal, input.messageId), (message) => ({
        message: message.textBody === null ? message : Struct.assign(message, { htmlBody: null }),
      })),
  );

  tool(
    "umail_get_message_headers",
    {
      description:
        "Get the raw header block of one inbound message, decoded and bounded; `truncated` reports when the bound cut it short. Outbound messages have no archived source.",
      annotations: readOnly,
      input: Schema.Struct({ messageId }),
      output: Schema.Struct(MessageHeaders.fields),
    },
    (input) =>
      Effect.map(getMessageHeaders(deps, principal, input.messageId), ({ headers, truncated }) => ({
        headers,
        truncated,
      })),
  );

  tool(
    "umail_set_thread_read_state",
    {
      description: "Mark one thread as read or unread.",
      annotations: { ...readOnly, readOnlyHint: false, openWorldHint: false },
      input: Schema.Struct({ threadId, isRead: Schema.Boolean }),
      output: Schema.Struct({ thread: MailThreadDetail }),
    },
    (input) =>
      Effect.map(setThreadReadState(deps, principal, input.threadId, input.isRead), (thread) => ({
        thread,
      })),
  );

  tool(
    "umail_send_message",
    {
      description:
        "Send a new message to explicit To/CC recipients. requestId is required: a UUID you generate (any case). To retry after an error or a lost response, resend the same requestId with the same content; you get the existing job and the message is never sent twice. Returns a durable job; poll umail_get_job for provider acceptance. May wait for operator approval.",
      annotations: sends,
      input: Schema.Struct({ ...composeFields, fromAddressId }).check(hasMessageBody),
      output: Schema.Struct({ job: OutboundJobStatus }),
    },
    (input) =>
      Effect.map(submitMessage(deps, principal, { intent: "compose", ...input }), (job) => ({
        job,
      })),
  );

  tool(
    "umail_reply_to_message",
    {
      description:
        "Reply to a message; recipients and threading headers are derived from the parent. requestId is required: a UUID you generate (any case). To retry after an error or a lost response, resend the same requestId with the same content; you get the existing job and the message is never sent twice. Returns a durable job; poll umail_get_job for provider acceptance. May wait for operator approval.",
      annotations: sends,
      input: Schema.Struct({ ...replyFields, fromAddressId }).check(hasMessageBody),
      output: Schema.Struct({ job: OutboundJobStatus }),
    },
    (input) =>
      Effect.map(submitMessage(deps, principal, { intent: "reply", ...input }), (job) => ({
        job,
      })),
  );

  tool(
    "umail_get_job",
    {
      description: "Get the status of one outbound job created by this client.",
      annotations: readOnly,
      input: Schema.Struct({ jobId: Schema.String }),
      output: Schema.Struct({ job: OutboundJobStatus }),
    },
    (input) => Effect.map(getJob(deps, principal, input.jobId), (job) => ({ job })),
  );
}
