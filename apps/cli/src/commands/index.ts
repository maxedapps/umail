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
  MailContact,
  PatchAddressPayload,
  ReplySubmissionPayload,
  SubmissionRequestId,
  parseUtcInstant,
  type MailboxAddress,
  UpdateMcpClientPolicyPayload,
  type PrincipalPolicy,
  type ExternalMailAddress,
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

interface IneligibleSendingIdentityErrorFields {
  readonly address: MailboxAddress;
}

class IneligibleSendingIdentityError extends Data.TaggedError(
  "IneligibleSendingIdentityError",
)<IneligibleSendingIdentityErrorFields> {
  override readonly message = `No eligible sending identity matches --from: ${this.address}`;
}

interface InvalidPolicyListErrorFields {
  readonly flag: string;
  readonly detail: string;
}

class InvalidPolicyListError extends Data.TaggedError(
  "InvalidPolicyListError",
)<InvalidPolicyListErrorFields> {
  override readonly message = `--${this.flag}: ${this.detail}`;
}

class MissingMessageBodyError extends Data.TaggedError("MissingMessageBodyError") {
  override readonly message = "A message body is required (--text or --html)";
}

class MissingRecipientsError extends Data.TaggedError("MissingRecipientsError") {
  override readonly message = "--to is required";
}

class ConflictingSinceFlagsError extends Data.TaggedError("ConflictingSinceFlagsError") {
  override readonly message = "--since and --since-hours cannot be used together";
}

class InvalidSinceHoursError extends Data.TaggedError("InvalidSinceHoursError") {
  override readonly message = "--since-hours produced a date outside years 1-9999";
}

type ListThreadsQueryDraft = {
  limit?: number;
  cursor?: string;
};

type ListMessagesQueryDraft = {
  direction?: "inbound" | "outbound";
  addressId?: string;
  since?: string;
  unread?: boolean;
  limit?: number;
  cursor?: string;
};

type ListThreadMessagesQueryDraft = {
  limit?: number;
  cursor?: string;
};

type ListJobsQueryDraft = {
  limit?: number;
  cursor?: string;
};

type ComposeDraft = {
  intent: "compose";
  requestId: SubmissionRequestId;
  fromAddressId: string;
  subject: string;
  to: [MailContact, ...Array<MailContact>];
  cc?: ReadonlyArray<MailContact>;
  text?: string;
  html?: string;
};

type ReplyDraft = {
  intent: "reply";
  requestId: SubmissionRequestId;
  fromAddressId: string;
  subject: string;
  replyToMessageId: string;
  replyMode: "reply" | "reply-all";
  text?: string;
  html?: string;
};

const loginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const env = yield* CliEnvironment;
    yield* login(env);
    yield* printJson({ authenticated: true });
  }),
).pipe(Command.withDescription("Authorize this CLI through the browser device flow"));

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const env = yield* CliEnvironment;
    yield* logout(env);
    yield* printJson({ ok: true });
  }),
).pipe(
  Command.withDescription(
    "Revoke refresh access and remove local OAuth credentials from the owner-only state file",
  ),
);

const addressesList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Addresses.listAddresses({}));
  }),
).pipe(Command.withDescription("List mailbox addresses"));

const addressesCreate = Command.make(
  "create",
  {
    localPart: Flag.string("local-part").pipe(
      Flag.withDescription("Mailbox local part; the server appends its configured domain"),
    ),
    displayName: Flag.optional(
      Flag.string("display-name").pipe(Flag.withDescription("Display name")),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const displayName = optionalValue(config.displayName);
      if (displayName === undefined) {
        yield* printJson(
          yield* client.Addresses.createAddress({
            payload: new CreateAddressPayload({ localPart: config.localPart }),
          }),
        );
        return;
      }
      yield* printJson(
        yield* client.Addresses.createAddress({
          payload: new CreateAddressPayload({
            localPart: config.localPart,
            displayName,
          }),
        }),
      );
    }),
).pipe(Command.withDescription("Create a mailbox address"));

const addressesGet = Command.make("get", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Addresses.getAddress({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Get a mailbox address"));

const addressesUpdate = Command.make(
  "update",
  {
    id: idFlag,
    displayName: Flag.string("display-name").pipe(Flag.withDescription("Display name")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      yield* printJson(
        yield* client.Addresses.patchAddress({
          params: { id: config.id },
          payload: new PatchAddressPayload({ displayName: config.displayName }),
        }),
      );
    }),
).pipe(Command.withDescription("Update a mailbox address"));

const addressesEnable = Command.make("enable", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(
      yield* client.Addresses.patchAddress({
        params: { id: config.id },
        payload: new PatchAddressPayload({ active: true }),
      }),
    );
  }),
).pipe(Command.withDescription("Enable a mailbox address"));

const addressesDisable = Command.make("disable", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(
      yield* client.Addresses.patchAddress({
        params: { id: config.id },
        payload: new PatchAddressPayload({ active: false }),
      }),
    );
  }),
).pipe(Command.withDescription("Disable a mailbox address"));

const addressesCommand = Command.make("addresses").pipe(
  Command.withDescription("Mailbox addresses"),
  Command.withSubcommands([
    addressesList,
    addressesCreate,
    addressesGet,
    addressesUpdate,
    addressesEnable,
    addressesDisable,
  ]),
);

const sendingIdentitiesList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.SendingIdentities.listSendingIdentities({}));
  }),
).pipe(Command.withDescription("List sending identities"));

const sendingIdentitiesCommand = Command.make("sending-identities").pipe(
  Command.withDescription("Eligible sending identities"),
  Command.withSubcommands([sendingIdentitiesList]),
);

const destinationsList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Destinations.listDestinations({}));
  }),
).pipe(Command.withDescription("List forwarding destinations"));

const destinationsCreate = Command.make(
  "create",
  {
    email: Flag.string("email").pipe(Flag.withDescription("Destination email")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      yield* printJson(
        yield* client.Destinations.createDestination({
          payload: new CreateDestinationPayload({ email: config.email }),
        }),
      );
    }),
).pipe(Command.withDescription("Create a forwarding destination"));

const destinationsGet = Command.make("get", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Destinations.getDestination({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Get a forwarding destination"));

const destinationsDelete = Command.make("delete", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* client.Destinations.deleteDestination({ params: { id: config.id } });
    yield* printJson({ ok: true });
  }),
).pipe(Command.withDescription("Delete a forwarding destination"));

const destinationsCommand = Command.make("destinations").pipe(
  Command.withDescription("Forwarding destinations"),
  Command.withSubcommands([
    destinationsList,
    destinationsCreate,
    destinationsGet,
    destinationsDelete,
  ]),
);

const forwardingAssociate = Command.make(
  "associate",
  {
    addressId: Flag.string("address-id").pipe(Flag.withDescription("Address id")),
    destinationId: Flag.string("destination-id").pipe(Flag.withDescription("Destination id")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      yield* printJson(
        yield* client.Addresses.associateForwarding({
          params: { id: config.addressId },
          payload: new AssociateForwardingPayload({ destinationId: config.destinationId }),
        }),
      );
    }),
).pipe(Command.withDescription("Associate a destination with an address"));

const forwardingRemove = Command.make(
  "remove",
  {
    addressId: Flag.string("address-id").pipe(Flag.withDescription("Address id")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      yield* printJson(
        yield* client.Addresses.removeForwarding({ params: { id: config.addressId } }),
      );
    }),
).pipe(Command.withDescription("Remove forwarding from an address"));

const forwardingCommand = Command.make("forwarding").pipe(
  Command.withDescription("Address forwarding"),
  Command.withSubcommands([forwardingAssociate, forwardingRemove]),
);

const threadsList = Command.make(
  "list",
  {
    limit: limitFlag,
    cursor: cursorFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const queryFields: ListThreadsQueryDraft = {};
      const limit = optionalValue(config.limit);
      const cursor = optionalValue(config.cursor);
      if (limit !== undefined) {
        queryFields.limit = limit;
      }
      if (cursor !== undefined) {
        queryFields.cursor = cursor;
      }
      yield* printJson(
        yield* client.Threads.listThreads({
          query: new ListThreadsQuery(queryFields),
        }),
      );
    }),
).pipe(Command.withDescription("List threads"));

const threadsGet = Command.make(
  "get",
  {
    id: idFlag,
    limit: limitFlag,
    cursor: cursorFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const queryFields: ListThreadMessagesQueryDraft = {};
      const limit = optionalValue(config.limit);
      const cursor = optionalValue(config.cursor);
      if (limit !== undefined) {
        queryFields.limit = limit;
      }
      if (cursor !== undefined) {
        queryFields.cursor = cursor;
      }
      yield* printJson(
        yield* client.Threads.listThreadMessages({
          params: { id: config.id },
          query: new ListThreadMessagesQuery(queryFields),
        }),
      );
    }),
).pipe(Command.withDescription("List one page of messages in a thread"));

const threadsRead = Command.make("read", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Threads.markThreadRead({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Mark a thread read"));

const threadsUnread = Command.make("unread", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Threads.markThreadUnread({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Mark a thread unread"));

const threadsDelete = Command.make("delete", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* client.Threads.softDeleteThread({ params: { id: config.id } });
    yield* printJson({ ok: true });
  }),
).pipe(Command.withDescription("Delete a thread"));

const threadsCommand = Command.make("threads").pipe(
  Command.withDescription("Conversation threads"),
  Command.withSubcommands([threadsList, threadsGet, threadsRead, threadsUnread, threadsDelete]),
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
    limit: limitFlag,
    cursor: cursorFlag,
  },
  (config) =>
    Effect.gen(function* () {
      if (Option.isSome(config.since) && Option.isSome(config.sinceHours)) {
        return yield* new ConflictingSinceFlagsError();
      }
      let since = optionalValue(config.since);
      if (Option.isSome(config.sinceHours)) {
        const instant = instantFromHours(config.sinceHours.value);
        if (instant === null) {
          return yield* new InvalidSinceHoursError();
        }
        since = instant;
      }
      const client = yield* requireClient();
      const queryFields: ListMessagesQueryDraft = {};
      const direction = optionalValue(config.direction);
      const addressId = optionalValue(config.addressId);
      const limit = optionalValue(config.limit);
      const cursor = optionalValue(config.cursor);
      if (direction !== undefined) {
        queryFields.direction = direction;
      }
      if (addressId !== undefined) {
        queryFields.addressId = addressId;
      }
      if (since !== undefined) {
        queryFields.since = since;
      }
      if (config.unread) {
        queryFields.unread = true;
      }
      if (limit !== undefined) {
        queryFields.limit = limit;
      }
      if (cursor !== undefined) {
        queryFields.cursor = cursor;
      }
      yield* printJson(
        yield* client.Messages.listMessages({
          query: new ListMessagesQuery(queryFields),
        }),
      );
    }),
).pipe(Command.withDescription("List messages"));

const messagesGet = Command.make("get", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Messages.getMessage({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Get a message"));

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
  (config) =>
    Effect.gen(function* () {
      const payload = yield* composePayload(config);
      const client = yield* requireClient();
      const fromAddressId = yield* resolveFromAddressId(client, config.from);
      payload.fromAddressId = fromAddressId;
      const job = yield* retryTransport(
        client.Submissions.submitMessage({
          payload: new ComposeSubmissionPayload(payload),
        }),
      );
      yield* printJson(job);
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
  (config) =>
    Effect.gen(function* () {
      const payload = yield* replyPayload(config);
      const client = yield* requireClient();
      const fromAddressId = yield* resolveFromAddressId(client, config.from);
      payload.fromAddressId = fromAddressId;
      const job = yield* retryTransport(
        client.Submissions.submitMessage({
          payload: new ReplySubmissionPayload(payload),
        }),
      );
      yield* printJson(job);
    }),
).pipe(Command.withDescription("Reply to a message; recipients are derived from the parent"));

const messagesSource = Command.make(
  "source",
  {
    id: idFlag,
    output: Flag.string("output").pipe(Flag.withDescription("File to write")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const result = yield* client.Messages.getMessageSource({ params: { id: config.id } });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(config.output, result.body);
      yield* printJson({
        output: config.output,
        bytes: result.body.byteLength,
        contentType: result.headers["content-type"],
      });
    }),
).pipe(Command.withDescription("Download the archived source of an inbound message"));

const messagesCommand = Command.make("messages").pipe(
  Command.withDescription("Messages"),
  Command.withSubcommands([
    messagesList,
    messagesGet,
    messagesCompose,
    messagesReply,
    messagesSource,
  ]),
);

const jobsList = Command.make(
  "list",
  {
    limit: limitFlag,
    cursor: cursorFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const queryFields: ListJobsQueryDraft = {};
      const limit = optionalValue(config.limit);
      const cursor = optionalValue(config.cursor);
      if (limit !== undefined) {
        queryFields.limit = limit;
      }
      if (cursor !== undefined) {
        queryFields.cursor = cursor;
      }
      yield* printJson(
        yield* client.Jobs.listJobs({
          query: new ListJobsQuery(queryFields),
        }),
      );
    }),
).pipe(Command.withDescription("List outbound jobs"));

const jobsGet = Command.make("get", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.Jobs.getJob({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Get outbound job status"));

const jobsCommand = Command.make("jobs").pipe(
  Command.withDescription("Outbound submission jobs"),
  Command.withSubcommands([jobsList, jobsGet]),
);

const attachmentsGet = Command.make(
  "get",
  {
    id: idFlag,
    attachmentId: Flag.string("attachment-id").pipe(Flag.withDescription("Attachment id")),
    output: Flag.string("output").pipe(Flag.withDescription("File to write")),
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* requireClient();
      const result = yield* client.Messages.getAttachment({
        params: { id: config.id, attachmentId: config.attachmentId },
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(config.output, result.body);
      yield* printJson({
        output: config.output,
        bytes: result.body.byteLength,
        contentType: result.headers["content-type"],
      });
    }),
).pipe(Command.withDescription("Download an attachment"));

const attachmentsCommand = Command.make("attachments").pipe(
  Command.withDescription("Message attachments"),
  Command.withSubcommands([attachmentsGet]),
);

const approvalsApprove = Command.make(
  "approve",
  {
    tokenFile: tokenFileFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const env = yield* CliEnvironment;
      const httpClient = yield* HttpClient.HttpClient;
      yield* printJson(
        yield* decideApproval("approve", optionalValue(config.tokenFile), env, httpClient),
      );
    }),
).pipe(Command.withDescription("Approve a pending send"));

const approvalsDeny = Command.make(
  "deny",
  {
    tokenFile: tokenFileFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const env = yield* CliEnvironment;
      const httpClient = yield* HttpClient.HttpClient;
      yield* printJson(
        yield* decideApproval("deny", optionalValue(config.tokenFile), env, httpClient),
      );
    }),
).pipe(Command.withDescription("Deny a pending send"));

const approvalsCommand = Command.make("approvals").pipe(
  Command.withDescription("Public approval decisions"),
  Command.withSubcommands([approvalsApprove, approvalsDeny]),
);

const clientsList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.McpClients.listMcpClients({}));
  }),
).pipe(Command.withDescription("List MCP OAuth clients and their policies"));

const clientsGet = Command.make("get", { id: idFlag }, (config) =>
  Effect.gen(function* () {
    const client = yield* requireClient();
    yield* printJson(yield* client.McpClients.getMcpClient({ params: { id: config.id } }));
  }),
).pipe(Command.withDescription("Get one MCP OAuth client policy"));

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
      const sendMode = yield* resolveSendMode(current.policy.sendMode, config);
      const mailboxIds = yield* resolveMailboxIds(current.policy.mailboxIds, config.mailboxes);
      const recipientAllowlist = yield* resolveRecipientAllowlist(
        current.policy.recipientAllowlist,
        config.recipients,
      );
      const payload = new UpdateMcpClientPolicyPayload({
        label: Option.getOrElse(config.label, () => current.label),
        active: Option.match(config.active, {
          onNone: () => current.state === "active",
          onSome: (value) => value === "true",
        }),
        policy: {
          mailboxIds,
          canRead: resolveBooleanSetting(config.canRead, current.policy.canRead),
          canDelete: resolveBooleanSetting(config.canDelete, current.policy.canDelete),
          sendMode,
          recipientAllowlist,
          canAdmin: resolveBooleanSetting(config.canAdmin, current.policy.canAdmin),
        },
      });
      yield* printJson(
        yield* client.McpClients.setMcpClientPolicy({ params: { id: config.id }, payload }),
      );
    }),
).pipe(Command.withDescription("Replace one MCP client policy; omitted flags keep their value"));

const clientsCommand = Command.make("clients").pipe(
  Command.withDescription("MCP OAuth clients"),
  Command.withSubcommands([clientsList, clientsGet, clientsSetPolicy]),
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

function resolveBooleanSetting(setting: Option.Option<string>, fallback: boolean): boolean {
  return Option.match(setting, { onNone: () => fallback, onSome: (value) => value === "true" });
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
  config: {
    readonly sendMode: Option.Option<"deny" | "allow" | "requireApproval">;
    readonly preapproved: Option.Option<string>;
  },
) {
  return Effect.gen(function* () {
    const mode = Option.getOrElse(config.sendMode, () => current.kind);
    if (mode !== "requireApproval") {
      return { kind: mode } as const;
    }
    const stored: ReadonlyArray<ExternalMailAddress> =
      current.kind === "requireApproval" ? current.preapprovedRecipients : [];
    if (Option.isNone(config.preapproved)) {
      return requireApprovalSendMode(stored);
    }
    const parsed = parseMailAddressList(config.preapproved.value);
    if (parsed.kind !== "ok") {
      return yield* new InvalidPolicyListError({
        flag: "preapproved",
        detail: `'${parsed.value}' is not a valid email address`,
      });
    }
    return requireApprovalSendMode(parsed.addresses);
  });
}

function requireClient() {
  return Effect.gen(function* () {
    const env = yield* CliEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* clientFromEnv(env, httpClient);
  });
}

function printJson<A>(value: A) {
  return Console.log(JSON.stringify(value, null, 2));
}

function optionalValue<A>(value: Option.Option<A>) {
  if (Option.isSome(value)) {
    return value.value;
  }
  return undefined;
}

function resolveRequestId(provided: Option.Option<SubmissionRequestId>) {
  if (Option.isSome(provided)) {
    return provided.value;
  }
  return Schema.decodeSync(SubmissionRequestId)(randomUUID());
}

function messageBody(text: Option.Option<string>, html: Option.Option<string>) {
  const textValue = optionalValue(text);
  const htmlValue = optionalValue(html);
  const hasText = textValue !== undefined && textValue.length > 0;
  const hasHtml = htmlValue !== undefined && htmlValue.length > 0;
  if (!hasText && !hasHtml) {
    return Effect.fail(new MissingMessageBodyError());
  }
  return Effect.succeed({
    text: hasText ? textValue : undefined,
    html: hasHtml ? htmlValue : undefined,
  });
}

function composePayload(config: {
  readonly from: MailboxAddress;
  readonly subject: string;
  readonly to: ReadonlyArray<MailContact>;
  readonly cc: ReadonlyArray<MailContact>;
  readonly text: Option.Option<string>;
  readonly html: Option.Option<string>;
  readonly requestId: Option.Option<SubmissionRequestId>;
}) {
  return Effect.gen(function* () {
    const body = yield* messageBody(config.text, config.html);
    const firstTo = config.to[0];
    if (firstTo === undefined) {
      return yield* new MissingRecipientsError();
    }
    const payload: ComposeDraft = {
      intent: "compose",
      requestId: resolveRequestId(config.requestId),
      fromAddressId: "",
      subject: config.subject,
      to: [firstTo, ...config.to.slice(1)],
    };
    if (config.cc.length > 0) {
      payload.cc = config.cc;
    }
    if (body.text !== undefined) {
      payload.text = body.text;
    }
    if (body.html !== undefined) {
      payload.html = body.html;
    }
    return payload;
  });
}

function replyPayload(config: {
  readonly from: MailboxAddress;
  readonly subject: string;
  readonly replyTo: string;
  readonly replyAll: boolean;
  readonly text: Option.Option<string>;
  readonly html: Option.Option<string>;
  readonly requestId: Option.Option<SubmissionRequestId>;
}) {
  return Effect.gen(function* () {
    const body = yield* messageBody(config.text, config.html);
    const payload: ReplyDraft = {
      intent: "reply",
      requestId: resolveRequestId(config.requestId),
      fromAddressId: "",
      subject: config.subject,
      replyToMessageId: config.replyTo,
      replyMode: config.replyAll ? "reply-all" : "reply",
    };
    if (body.text !== undefined) {
      payload.text = body.text;
    }
    if (body.html !== undefined) {
      payload.html = body.html;
    }
    return payload;
  });
}

function resolveFromAddressId(
  client: Effect.Success<ReturnType<typeof clientFromEnv>>,
  from: MailboxAddress,
) {
  return Effect.gen(function* () {
    const identities = yield* client.SendingIdentities.listSendingIdentities({});
    const fromIdentity = identities.find((identity) => identity.address === from);
    if (fromIdentity === undefined) {
      return yield* new IneligibleSendingIdentityError({ address: from });
    }
    return fromIdentity.id;
  });
}

function retryTransport<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.retry(effect, {
    times: SUBMIT_TRANSPORT_RETRIES,
    while: (error) => isTransportError(error),
  });
}

function isTransportError(error: unknown) {
  return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";
}

function instantFromHours(hours: number) {
  const millis = Date.now() - hours * 60 * 60 * 1000;
  if (!Number.isFinite(millis)) {
    return null;
  }
  return parseUtcInstant(new Date(millis).toISOString());
}
