import { randomUUID } from "node:crypto";

import {
  AssociateForwardingPayload,
  ComposeSubmissionPayload,
  CreateAddressPayload,
  CreateDestinationPayload,
  ListJobsQuery,
  ListMessagesQuery,
  ListThreadMessagesQuery,
  ListThreadsQuery,
  PatchAddressPayload,
  ReplySubmissionPayload,
  SubmissionRequestId,
  parseUtcInstant,
  type MailboxAddress,
  UpdateMcpClientPolicyPayload,
  type PrincipalPolicy,
  requireApprovalSendMode,
  parsePrincipalRecipientAllowlist,
  parsePrincipalMailboxIds,
  parseMailAddressList,
} from "@umail/api-contract";
import type { UmailClientEnvironment } from "@umail/api-contract/client";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { decideApproval } from "../approvals.ts";
import { login, logout } from "../auth.ts";
import { clientFromEnv } from "../client.ts";
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
  activeFlag,
  canAdminFlag,
  canDeleteFlag,
  canReadFlag,
  clientLabelFlag,
  mailboxesFlag,
  preapprovedFlag,
  recipientAllowlistFlag,
  sendModeFlag,
} from "./flags.ts";

const SUBMIT_TRANSPORT_RETRIES = 2;

export class CliEnvironment extends Context.Service<CliEnvironment, UmailClientEnvironment>()(
  "umail/CliEnvironment",
) {}

type UmailClient = Effect.Success<ReturnType<typeof clientFromEnv>>;

class IneligibleSendingIdentityError extends Data.TaggedError("IneligibleSendingIdentityError")<{
  readonly address: MailboxAddress;
}> {
  override readonly message = `No eligible sending identity matches --from: ${this.address}`;
}

class InvalidPolicyListError extends Data.TaggedError("InvalidPolicyListError")<{
  readonly flag: string;
  readonly detail: string;
}> {
  override readonly message = `--${this.flag}: ${this.detail}`;
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

const pageFlags = { limit: limitFlag, cursor: cursorFlag };

const loginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    yield* login(yield* CliEnvironment);
    yield* printJson({ authenticated: true });
  }),
).pipe(Command.withDescription("Authorize this CLI through the browser device flow"));

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    yield* logout(yield* CliEnvironment);
    yield* printJson({ ok: true });
  }),
).pipe(
  Command.withDescription(
    "Revoke refresh access and remove local OAuth credentials from the owner-only state file",
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

const destinationsCommand = Command.make("destinations").pipe(
  Command.withDescription("Forwarding destinations"),
  Command.withSubcommands([
    Command.make("list", {}, () =>
      callApi((client) => client.Destinations.listDestinations({})),
    ).pipe(Command.withDescription("List forwarding destinations")),
    Command.make(
      "create",
      { email: Flag.string("email").pipe(Flag.withDescription("Destination email")) },
      ({ email }) =>
        callApi((client) =>
          client.Destinations.createDestination({
            payload: new CreateDestinationPayload({ email }),
          }),
        ),
    ).pipe(Command.withDescription("Create a forwarding destination")),
    Command.make("get", { id: idFlag }, ({ id }) =>
      callApi((client) => client.Destinations.getDestination({ params: { id } })),
    ).pipe(Command.withDescription("Get a forwarding destination")),
    Command.make("delete", { id: idFlag }, ({ id }) =>
      callApi((client) =>
        client.Destinations.deleteDestination({ params: { id } }).pipe(Effect.as({ ok: true })),
      ),
    ).pipe(Command.withDescription("Delete a forwarding destination")),
  ]),
);

const addressIdFlag = Flag.string("address-id").pipe(Flag.withDescription("Address id"));

const forwardingCommand = Command.make("forwarding").pipe(
  Command.withDescription("Address forwarding"),
  Command.withSubcommands([
    Command.make(
      "associate",
      {
        addressId: addressIdFlag,
        destinationId: Flag.string("destination-id").pipe(Flag.withDescription("Destination id")),
      },
      ({ addressId, destinationId }) =>
        callApi((client) =>
          client.Addresses.associateForwarding({
            params: { id: addressId },
            payload: new AssociateForwardingPayload({ destinationId }),
          }),
        ),
    ).pipe(Command.withDescription("Associate a destination with an address")),
    Command.make("remove", { addressId: addressIdFlag }, ({ addressId }) =>
      callApi((client) => client.Addresses.removeForwarding({ params: { id: addressId } })),
    ).pipe(Command.withDescription("Remove forwarding from an address")),
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
        client.Threads.listThreadMessages({
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
      yield* printJson(yield* retryTransport(client.Submissions.submitMessage({ payload })));
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
      yield* printJson(yield* retryTransport(client.Submissions.submitMessage({ payload })));
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

const clientsSetPolicy = Command.make(
  "set-policy",
  {
    id: idFlag,
    label: clientLabelFlag,
    sendMode: sendModeFlag,
    preapproved: preapprovedFlag,
    mailboxes: mailboxesFlag,
    recipients: recipientAllowlistFlag,
    active: activeFlag,
    canRead: canReadFlag,
    canDelete: canDeleteFlag,
    canAdmin: canAdminFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const current = yield* client.McpClients.getMcpClient({ params: { id: config.id } });
      const { policy } = current;
      const sendMode = yield* resolveSendMode(policy.sendMode, config.sendMode, config.preapproved);
      const mailboxIds = yield* resolveMailboxIds(policy.mailboxIds, config.mailboxes);
      const recipientAllowlist = yield* resolveRecipientAllowlist(
        policy.recipientAllowlist,
        config.recipients,
      );
      const payload = new UpdateMcpClientPolicyPayload({
        label: Option.getOrElse(config.label, () => current.label),
        active: Option.getOrElse(config.active, () => current.state === "active"),
        policy: {
          mailboxIds,
          canRead: Option.getOrElse(config.canRead, () => policy.canRead),
          canDelete: Option.getOrElse(config.canDelete, () => policy.canDelete),
          sendMode,
          recipientAllowlist,
          canAdmin: Option.getOrElse(config.canAdmin, () => policy.canAdmin),
        },
      });
      yield* printJson(
        yield* client.McpClients.setMcpClientPolicy({ params: { id: config.id }, payload }),
      );
    }),
).pipe(Command.withDescription("Replace one MCP client policy; omitted flags keep their value"));

const clientsCommand = Command.make("clients").pipe(
  Command.withDescription("MCP OAuth clients"),
  Command.withSubcommands([
    Command.make("list", {}, () => callApi((client) => client.McpClients.listMcpClients({}))).pipe(
      Command.withDescription("List MCP OAuth clients and their policies"),
    ),
    Command.make("get", { id: idFlag }, ({ id }) =>
      callApi((client) => client.McpClients.getMcpClient({ params: { id } })),
    ).pipe(Command.withDescription("Get one MCP OAuth client policy")),
    clientsSetPolicy,
  ]),
);

export const umailCommand = Command.make("umail").pipe(
  Command.withDescription("AgentMail command-line client"),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    addressesCommand,
    sendingIdentitiesCommand,
    destinationsCommand,
    forwardingCommand,
    threadsCommand,
    messagesCommand,
    jobsCommand,
    attachmentsCommand,
    approvalsCommand,
    clientsCommand,
  ]),
);

function requireClient() {
  return Effect.gen(function* () {
    const env = yield* CliEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* clientFromEnv(env, httpClient);
  });
}

/** Runs one authenticated API call and prints its result as JSON. */
function callApi<A, E, R>(request: (client: UmailClient) => Effect.Effect<A, E, R>) {
  return requireClient().pipe(Effect.flatMap(request), Effect.flatMap(printJson));
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

function download<E, R>(
  output: string,
  request: (
    client: UmailClient,
  ) => Effect.Effect<
    { readonly body: Uint8Array; readonly headers: { readonly "content-type": string } },
    E,
    R
  >,
) {
  return Effect.gen(function* () {
    const result = yield* request(yield* requireClient());
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(output, result.body);
    yield* printJson({
      output,
      bytes: result.body.byteLength,
      contentType: result.headers["content-type"],
    });
  });
}

function approvalDecisionCommand(decision: "approve" | "deny", description: string) {
  return Command.make(decision, { tokenFile: tokenFileFlag }, ({ tokenFile }) =>
    Effect.gen(function* () {
      const env = yield* CliEnvironment;
      const httpClient = yield* HttpClient.HttpClient;
      yield* printJson(
        yield* decideApproval(decision, Option.getOrUndefined(tokenFile), env, httpClient),
      );
    }),
  ).pipe(Command.withDescription(description));
}

function resolveFromAddressId(client: UmailClient, from: MailboxAddress) {
  return Effect.gen(function* () {
    const identities = yield* client.SendingIdentities.listSendingIdentities({});
    const identity = identities.find((candidate) => candidate.address === from);
    if (identity === undefined) {
      return yield* new IneligibleSendingIdentityError({ address: from });
    }
    return identity.id;
  });
}

function retryTransport<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.retry(effect, {
    times: SUBMIT_TRANSPORT_RETRIES,
    while: (error) =>
      HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError",
  });
}

function resolveMailboxIds(stored: PrincipalPolicy["mailboxIds"], supplied: Option.Option<string>) {
  return Effect.gen(function* () {
    if (Option.isNone(supplied)) return stored;
    const parsed = parsePrincipalMailboxIds(supplied.value);
    if (parsed.kind !== "ok") {
      return yield* new InvalidPolicyListError({
        flag: "mailboxes",
        detail: "expected 'all' or at least one mailbox id",
      });
    }
    return parsed.mailboxIds;
  });
}

function resolveRecipientAllowlist(
  stored: PrincipalPolicy["recipientAllowlist"],
  supplied: Option.Option<string>,
) {
  return Effect.gen(function* () {
    if (Option.isNone(supplied)) return stored;
    const parsed = parsePrincipalRecipientAllowlist(supplied.value);
    if (parsed.kind === "ok") return parsed.recipientAllowlist;
    return yield* new InvalidPolicyListError({
      flag: "recipients",
      detail:
        parsed.kind === "invalid_address"
          ? `'${parsed.value}' is not a valid email address`
          : "expected 'any' or at least one address",
    });
  });
}

function resolveSendMode(
  current: PrincipalPolicy["sendMode"],
  sendMode: Option.Option<"deny" | "allow" | "requireApproval">,
  preapproved: Option.Option<string>,
) {
  return Effect.gen(function* () {
    const mode = Option.getOrElse(sendMode, () => current.kind);
    if (mode !== "requireApproval") return { kind: mode } as const;
    if (Option.isNone(preapproved)) {
      return requireApprovalSendMode(
        current.kind === "requireApproval" ? current.preapprovedRecipients : [],
      );
    }
    const parsed = parseMailAddressList(preapproved.value);
    if (parsed.kind !== "ok") {
      return yield* new InvalidPolicyListError({
        flag: "preapproved",
        detail: `'${parsed.value}' is not a valid email address`,
      });
    }
    return requireApprovalSendMode(parsed.addresses);
  });
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

function instantFromHours(hours: number) {
  const date = new Date(Date.now() - hours * 60 * 60 * 1000);
  const instant = Number.isNaN(date.getTime()) ? null : parseUtcInstant(date.toISOString());
  return instant === null
    ? Effect.fail(new InvalidSinceHoursError())
    : Effect.succeed(Option.some(instant));
}
