import { randomUUID } from "node:crypto";

import {
  ComposeSubmissionPayload,
  CreateAddressPayload,
  ListJobsQuery,
  ListMessagesQuery,
  ListThreadMessagesQuery,
  ListThreadsQuery,
  PatchAddressPayload,
  ReplySubmissionPayload,
  SetForwardingPayload,
  SubmissionRequestId,
  parseUtcInstant,
  type MailboxAddress,
} from "@umail/api-contract";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { decideApproval } from "../approvals.ts";
import { login, logout } from "../auth.ts";
import { apiCall, umailClient } from "../client.ts";
import type { ServerFailed, ServerUnreachable } from "../errors.ts";
import {
  ccFlag,
  cursorFlag,
  directionFlag,
  fromFlag,
  htmlFlag,
  idFlag,
  limitFlag,
  replyAllFlag,
  replyToFlag,
  requestIdFlag,
  sinceFlag,
  sinceHoursFlag,
  subjectFlag,
  textFlag,
  toFlag,
  tokenFileFlag,
  unreadFlag,
  forwardEmailFlag,
} from "./flags.ts";

const SUBMIT_TRANSPORT_RETRIES = 2;

type UmailClient = Effect.Success<ReturnType<typeof umailClient>>;

class IneligibleSendingIdentityError extends Data.TaggedError("IneligibleSendingIdentityError")<{
  readonly address: MailboxAddress;
}> {
  override readonly message = `No eligible sending identity matches --from: ${this.address}`;
}

class MissingMessageBodyError extends Data.TaggedError("MissingMessageBodyError") {
  override readonly message = "A message body is required (--text or --html)";
}

class ConflictingSinceFlagsError extends Data.TaggedError("ConflictingSinceFlagsError") {
  override readonly message = "--since and --since-hours cannot be used together";
}

class InvalidSinceHoursError extends Data.TaggedError("InvalidSinceHoursError") {
  override readonly message = "--since-hours produced a date outside years 1-9999";
}

// The server may have stored the submission before the failure, so the way to find out is to
// resubmit with the same request id, which returns the existing job instead of sending twice.
class SubmissionOutcomeUnknown extends Data.TaggedError("SubmissionOutcomeUnknown")<{
  readonly failure: ServerUnreachable | ServerFailed;
  readonly requestId: string;
}> {
  override readonly message = `${this.failure.message} The submission may have been accepted. Retry with --request-id ${this.requestId} and the same content to get the existing job.`;
}

const pageFlags = { limit: limitFlag, cursor: cursorFlag };

const loginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    yield* login;
    yield* printJson({ authenticated: true });
  }),
).pipe(Command.withDescription("Authorize this CLI through the browser device flow"));

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    yield* logout;
    yield* printJson({ ok: true });
  }),
).pipe(
  Command.withDescription(
    "Revoke this CLI's access on the server, then remove the local OAuth credentials",
  ),
);

const addressesCommand = Command.make("addresses").pipe(
  Command.withDescription("Mailbox addresses"),
  Command.withSubcommands([
    Command.make("list", {}, () => callApi((client) => client.Addresses.listAddresses({}))).pipe(
      Command.withDescription("List mailbox addresses"),
    ),
    Command.make(
      "create",
      {
        localPart: Flag.string("local-part").pipe(
          Flag.withDescription("Mailbox local part; the server appends its configured domain"),
        ),
        displayName: Flag.optional(
          Flag.string("display-name").pipe(Flag.withDescription("Display name")),
        ),
      },
      ({ localPart, displayName }) =>
        callApi((client) =>
          client.Addresses.createAddress({
            payload: new CreateAddressPayload({ localPart, ...presentOptions({ displayName }) }),
          }),
        ),
    ).pipe(Command.withDescription("Create a mailbox address")),
    Command.make("get", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Addresses.getAddress({ params: { id } })),
    ).pipe(Command.withDescription("Get a mailbox address")),
    Command.make(
      "update",
      {
        id: idFlag,
        displayName: Flag.string("display-name").pipe(Flag.withDescription("Display name")),
      },
      ({ id, displayName }) => patchAddress(id, new PatchAddressPayload({ displayName })),
    ).pipe(Command.withDescription("Update a mailbox address")),
    Command.make("enable", { id: idFlag }, ({ id }) =>
      patchAddress(id, new PatchAddressPayload({ active: true })),
    ).pipe(Command.withDescription("Enable a mailbox address")),
    Command.make("disable", { id: idFlag }, ({ id }) =>
      patchAddress(id, new PatchAddressPayload({ active: false })),
    ).pipe(Command.withDescription("Disable a mailbox address")),
  ]),
);

const sendingIdentitiesCommand = Command.make("sending-identities").pipe(
  Command.withDescription("Eligible sending identities"),
  Command.withSubcommands([
    Command.make("list", {}, () =>
      callApi((client) => client.SendingIdentities.listSendingIdentities({})),
    ).pipe(Command.withDescription("List sending identities")),
  ]),
);

const addressIdFlag = Flag.string("address-id").pipe(Flag.withDescription("Address id"));

const forwardingCommand = Command.make("forwarding").pipe(
  Command.withDescription("Forward an address's inbound mail to another inbox"),
  Command.withSubcommands([
    Command.make(
      "set",
      { addressId: addressIdFlag, email: forwardEmailFlag },
      ({ addressId, email }) =>
        callApi((client) =>
          client.Addresses.setForwarding({
            params: { id: addressId },
            payload: new SetForwardingPayload({ email }),
          }),
        ),
    ).pipe(
      Command.withDescription(
        "Forward to an email; Cloudflare forwards once that inbox confirms its verification link",
      ),
    ),
    Command.make("remove", { addressId: addressIdFlag }, ({ addressId }) =>
      callApi((client) => client.Addresses.removeForwarding({ params: { id: addressId } })),
    ).pipe(Command.withDescription("Stop forwarding an address")),
  ]),
);

const threadsCommand = Command.make("threads").pipe(
  Command.withDescription("Conversation threads"),
  Command.withSubcommands([
    Command.make("list", pageFlags, (page) =>
      callApi((client) =>
        client.Threads.listThreads({ query: new ListThreadsQuery(presentOptions(page)) }),
      ),
    ).pipe(Command.withDescription("List threads")),
    Command.make("get", { id: idFlag, ...pageFlags }, ({ id, ...page }) =>
      callApi((client) =>
        client.Threads.getThread({
          params: { id },
          query: new ListThreadMessagesQuery(presentOptions(page)),
        }),
      ),
    ).pipe(Command.withDescription("List one page of messages in a thread")),
    Command.make("read", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Threads.markThreadRead({ params: { id } })),
    ).pipe(Command.withDescription("Mark a thread read")),
    Command.make("unread", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Threads.markThreadUnread({ params: { id } })),
    ).pipe(Command.withDescription("Mark a thread unread")),
    Command.make("delete", { id: idFlag }, ({ id }) =>
      callApi((client) =>
        client.Threads.softDeleteThread({ params: { id } }).pipe(Effect.as({ ok: true })),
      ),
    ).pipe(Command.withDescription("Delete a thread")),
  ]),
);

const messagesList = Command.make(
  "list",
  {
    direction: directionFlag,
    addressId: Flag.optional(
      Flag.string("address-id").pipe(Flag.withDescription("Mailbox address id")),
    ),
    since: sinceFlag,
    sinceHours: sinceHoursFlag,
    unread: unreadFlag,
    ...pageFlags,
  },
  ({ since, sinceHours, unread, ...filters }) =>
    Effect.gen(function* () {
      if (Option.isSome(since) && Option.isSome(sinceHours)) {
        return yield* new ConflictingSinceFlagsError();
      }
      const resolvedSince = Option.isSome(sinceHours)
        ? yield* instantFromHours(sinceHours.value)
        : since;
      return yield* callApi((client) =>
        client.Messages.listMessages({
          query: new ListMessagesQuery(
            presentOptions({
              ...filters,
              since: resolvedSince,
              unread: unread ? Option.some(true) : Option.none<boolean>(),
            }),
          ),
        }),
      );
    }),
).pipe(Command.withDescription("List messages"));

const messagesCompose = Command.make(
  "compose",
  {
    from: fromFlag,
    subject: subjectFlag,
    to: toFlag,
    cc: ccFlag,
    text: textFlag,
    html: htmlFlag,
    requestId: requestIdFlag,
  },
  ({ from, subject, to, cc, text, html, requestId }) =>
    Effect.gen(function* () {
      const body = yield* messageBody(text, html);
      const [first, ...rest] = to;
      if (first === undefined) return yield* Effect.die("--to requires at least one recipient");
      const client = yield* requireClient();
      const payload = new ComposeSubmissionPayload({
        intent: "compose",
        requestId: resolveRequestId(requestId),
        fromAddressId: yield* resolveFromAddressId(client, from),
        subject,
        to: [first, ...rest],
        ...presentOptions({ cc: Option.liftPredicate(cc, (list) => list.length > 0) }),
        ...body,
      });
      yield* printJson(yield* submit(client, { payload }));
    }),
).pipe(Command.withDescription("Compose a new message with explicit To/CC"));

const messagesReply = Command.make(
  "reply",
  {
    from: fromFlag,
    subject: subjectFlag,
    replyTo: replyToFlag,
    replyAll: replyAllFlag,
    text: textFlag,
    html: htmlFlag,
    requestId: requestIdFlag,
  },
  ({ from, subject, replyTo, replyAll, text, html, requestId }) =>
    Effect.gen(function* () {
      const body = yield* messageBody(text, html);
      const client = yield* requireClient();
      const payload = new ReplySubmissionPayload({
        intent: "reply",
        requestId: resolveRequestId(requestId),
        fromAddressId: yield* resolveFromAddressId(client, from),
        subject,
        replyToMessageId: replyTo,
        replyMode: replyAll ? "reply-all" : "reply",
        ...body,
      });
      yield* printJson(yield* submit(client, { payload }));
    }),
).pipe(Command.withDescription("Reply to a message; recipients are derived from the parent"));

const outputFlag = Flag.string("output").pipe(Flag.withDescription("File to write"));

const messagesCommand = Command.make("messages").pipe(
  Command.withDescription("Messages"),
  Command.withSubcommands([
    messagesList,
    Command.make("get", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Messages.getMessage({ params: { id } })),
    ).pipe(Command.withDescription("Get a message")),
    messagesCompose,
    messagesReply,
    Command.make("source", { id: idFlag, output: outputFlag }, ({ id, output }) =>
      download(output, (client) => client.Messages.getMessageSource({ params: { id } })),
    ).pipe(Command.withDescription("Download the archived source of an inbound message")),
  ]),
);

const jobsCommand = Command.make("jobs").pipe(
  Command.withDescription("Outbound submission jobs"),
  Command.withSubcommands([
    Command.make("list", pageFlags, (page) =>
      callApi((client) => client.Jobs.listJobs({ query: new ListJobsQuery(presentOptions(page)) })),
    ).pipe(Command.withDescription("List outbound jobs")),
    Command.make("get", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Jobs.getJob({ params: { id } })),
    ).pipe(Command.withDescription("Get outbound job status")),
  ]),
);

const attachmentsCommand = Command.make("attachments").pipe(
  Command.withDescription("Message attachments"),
  Command.withSubcommands([
    Command.make(
      "get",
      {
        id: idFlag,
        attachmentId: Flag.string("attachment-id").pipe(Flag.withDescription("Attachment id")),
        output: outputFlag,
      },
      ({ id, attachmentId, output }) =>
        download(output, (client) =>
          client.Messages.getAttachment({ params: { id, attachmentId } }),
        ),
    ).pipe(Command.withDescription("Download an attachment")),
  ]),
);

const approvalsCommand = Command.make("approvals").pipe(
  Command.withDescription("Public approval decisions"),
  Command.withSubcommands([
    approvalDecisionCommand("approve", "Approve a pending send"),
    approvalDecisionCommand("deny", "Deny a pending send"),
  ]),
);

export const umailCommand = Command.make("umail").pipe(
  Command.withDescription("AgentMail command-line client"),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    addressesCommand,
    sendingIdentitiesCommand,
    forwardingCommand,
    threadsCommand,
    messagesCommand,
    jobsCommand,
    attachmentsCommand,
    approvalsCommand,
  ]),
);

function requireClient() {
  return Effect.flatMap(HttpClient.HttpClient, umailClient);
}

/** Runs one authenticated API call and prints its result as JSON. */
function callApi<A, E, R>(request: (client: UmailClient) => Effect.Effect<A, E, R>) {
  return requireClient().pipe(
    Effect.flatMap((client) => apiCall(request(client))),
    Effect.flatMap(printJson),
  );
}

function printJson<A>(value: A) {
  return Console.log(JSON.stringify(value, null, 2));
}

/** Keeps only the present options, so optional-key API fields stay absent. */
function presentOptions<const Fields extends Record.ReadonlyRecord<string, Option.Option<unknown>>>(
  fields: Fields,
) {
  return Record.getSomes(fields) as { [K in keyof Fields]?: Option.Option.Value<Fields[K]> };
}

function patchAddress(id: string, payload: PatchAddressPayload) {
  return callApi((client) => client.Addresses.patchAddress({ params: { id }, payload }));
}

const download = Effect.fn("download")(function* <E, R>(
  output: string,
  request: (
    client: UmailClient,
  ) => Effect.Effect<
    { readonly body: Uint8Array; readonly headers: { readonly "content-type": string } },
    E,
    R
  >,
) {
  const result = yield* apiCall(request(yield* requireClient()));
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFile(output, result.body);
  yield* printJson({
    output,
    bytes: result.body.byteLength,
    contentType: result.headers["content-type"],
  });
});

function approvalDecisionCommand(decision: "approve" | "deny", description: string) {
  return Command.make(decision, { tokenFile: tokenFileFlag }, ({ tokenFile }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      yield* printJson(
        yield* decideApproval(decision, Option.getOrUndefined(tokenFile), httpClient),
      );
    }),
  ).pipe(Command.withDescription(description));
}

const resolveFromAddressId = Effect.fn("resolveFromAddressId")(function* (
  client: UmailClient,
  from: MailboxAddress,
) {
  const identities = yield* apiCall(client.SendingIdentities.listSendingIdentities({}));
  const identity = identities.find((candidate) => candidate.address === from);
  if (identity === undefined) {
    return yield* new IneligibleSendingIdentityError({ address: from });
  }
  return identity.id;
});

// Retries a dropped connection with the same request id; when the outcome stays unknown, says how
// to find out safely.
function submit(
  client: UmailClient,
  request: Parameters<UmailClient["Submissions"]["submitMessage"]>[0],
) {
  const requestId = request.payload.requestId;
  return apiCall(client.Submissions.submitMessage(request)).pipe(
    Effect.retry({
      times: SUBMIT_TRANSPORT_RETRIES,
      while: (error) => error._tag === "ServerUnreachable",
    }),
    Effect.catchTags({
      ServerUnreachable: (failure) =>
        Effect.fail(new SubmissionOutcomeUnknown({ failure, requestId })),
      ServerFailed: (failure) => Effect.fail(new SubmissionOutcomeUnknown({ failure, requestId })),
    }),
  );
}

function resolveRequestId(provided: Option.Option<SubmissionRequestId>) {
  return Option.getOrElse(provided, () => Schema.decodeSync(SubmissionRequestId)(randomUUID()));
}

function messageBody(text: Option.Option<string>, html: Option.Option<string>) {
  const body = presentOptions({
    text: Option.filter(text, (value) => value.length > 0),
    html: Option.filter(html, (value) => value.length > 0),
  });
  return body.text === undefined && body.html === undefined
    ? Effect.fail(new MissingMessageBodyError())
    : Effect.succeed(body);
}

const instantFromHours = Effect.fn("instantFromHours")(function* (hours: number) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const instant = DateTime.make(now - hours * 60 * 60 * 1000).pipe(
    Option.flatMapNullishOr((since) => parseUtcInstant(DateTime.formatIso(since))),
  );
  if (Option.isNone(instant)) return yield* new InvalidSinceHoursError();
  return instant;
});
