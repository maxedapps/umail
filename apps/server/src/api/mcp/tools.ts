import {
  ApiProblem,
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
  type Principal,
} from "@umail/api-contract";
import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import * as Cause from "effect/Cause";
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
const GENERIC_FAILURE = "The AgentMail API request failed.";

// The ApiProblems MCP tools can reach (operations.ts) carry fixed, client-safe messages, so they are passed through.
function failureMessage(error: { readonly _tag: string }): string {
  if (Schema.is(ApiProblem)(error)) {
    return error.message;
  }
  switch (error._tag) {
    case "Forbidden":
      return "The request is not permitted.";
    case "NotFound":
      return "The requested resource was not found.";
    case "Conflict":
      return "requestId reused with different content.";
    case "OutboundMessageHasNoSource":
      return "The message has no archived source; only inbound messages are archived.";
    default:
      return GENERIC_FAILURE;
  }
}

function failureResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
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
    handler: (
      input: In,
    ) => Effect.Effect<Out, { readonly _tag: string }, Crypto.Crypto | Alchemy.RuntimeContext>,
  ) {
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
            Effect.match({
              onSuccess: (output): CallToolResult => ({
                content: [{ type: "text", text: JSON.stringify(output) }],
                structuredContent: output,
              }),
              onFailure: (error) => failureResult(failureMessage(error)),
            }),
            Effect.catchDefect((defect) =>
              Effect.as(
                Effect.logError("MCP tool failed", Cause.die(defect)),
                failureResult(GENERIC_FAILURE),
              ),
            ),
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
        "Send a new message to explicit To/CC recipients. Returns a durable job; poll umail_get_job for provider acceptance. May wait for operator approval.",
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
        "Reply to a message; recipients and threading headers are derived from the parent. Returns a durable job; poll umail_get_job for provider acceptance. May wait for operator approval.",
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
