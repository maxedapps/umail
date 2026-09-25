import {
  parseMailAddressList,
  SubmitMessagePayload,
  type MailContact,
  type OutboundJobStatus,
  type Principal,
  type SendingIdentity,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import {
  getJob,
  listAddresses,
  listSendingIdentities,
  previewReplyRecipients,
  submitMessage,
} from "../../api/operations.ts";
import { randomId } from "../../crypto.ts";
import { htmlResponse, redirect, type PageView } from "../document.ts";
import { contactHtml, displayText, html, type Html } from "../html.ts";
import { mailboxNav } from "./mail.ts";

type ReplyMode = "reply" | "reply-all";

// A reply's derived parts, shown read-only: the parent's mailbox sends it to these recipients.
type ReplyContext = {
  readonly messageId: string;
  readonly mode: ReplyMode;
  readonly from: string;
  readonly to: ReadonlyArray<MailContact>;
  readonly cc: ReadonlyArray<MailContact>;
};

// The form as typed, so a rejected send re-renders it.
type ComposeState = {
  readonly requestId: string;
  readonly fromAddressId: string;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly text: string;
};

type ComposeField = "from" | "to" | "cc" | "text";

type ComposeErrors = Partial<Record<ComposeField, string>>;

function fieldError(errors: ComposeErrors, field: ComposeField): Html | null {
  const message = errors[field];
  return message === undefined ? null : html`<p class="error" role="alert">${message}</p>`;
}

function invalid(errors: ComposeErrors, field: ComposeField): Html | null {
  return errors[field] === undefined ? null : html`aria-invalid="true"`;
}

function contactsHtml(contacts: ReadonlyArray<MailContact>): Html {
  return contacts.length === 0
    ? html`<span class="muted">Nobody</span>`
    : html`<ul>
        ${contacts.map((contact) => html`<li>${contactHtml(contact)}</li>`)}
      </ul>`;
}

export function composePage(
  identities: ReadonlyArray<SendingIdentity>,
  aside: Html,
  state: ComposeState,
  reply: ReplyContext | null,
  errors: ComposeErrors,
): PageView {
  const recipients =
    reply === null
      ? html`<div class="field">
            <label for="from">From</label>
            <select id="from" name="fromAddressId" required ${invalid(errors, "from")}>
              ${identities.map(
                (identity) =>
                  html`<option
                    value="${identity.id}"
                    ${identity.id === state.fromAddressId ? html`selected` : null}
                  >
                    ${identity.address}
                  </option>`,
              )}
            </select>
            ${fieldError(errors, "from")}
          </div>
          <div class="field">
            <label for="to">To</label>
            <input
              id="to"
              name="to"
              type="text"
              value="${state.to}"
              required
              placeholder="anna@example.net, team@example.net"
              ${invalid(errors, "to")}
            />
            ${fieldError(errors, "to")}
          </div>
          <div class="field">
            <label for="cc">Cc</label>
            <input id="cc" name="cc" type="text" value="${state.cc}" ${invalid(errors, "cc")} />
            ${fieldError(errors, "cc")}
          </div>`
      : html`<input type="hidden" name="reply" value="${reply.messageId}" />
          <input type="hidden" name="mode" value="${reply.mode}" />
          <dl class="meta">
            <dt>From</dt>
            <dd class="mono">${reply.from}</dd>
            <dt>To</dt>
            <dd>${contactsHtml(reply.to)}</dd>
            <dt>Cc</dt>
            <dd>${contactsHtml(reply.cc)}</dd>
          </dl>`;
  return {
    kind: "console",
    section: "mail",
    title: reply === null ? "New message" : "Reply",
    heading: reply === null ? "New message" : reply.mode === "reply" ? "Reply" : "Reply all",
    aside,
    flash:
      Object.keys(errors).length === 0
        ? undefined
        : { tone: "error", message: "Nothing was sent. Fix the marked field." },
    main: html`<form class="stack" method="post" action="/mail/compose">
      <input type="hidden" name="requestId" value="${state.requestId}" />
      ${recipients}
      <div class="field">
        <label for="subject">Subject</label>
        <input id="subject" name="subject" type="text" value="${state.subject}" />
      </div>
      <div class="field">
        <label for="text">Message</label>
        <textarea id="text" name="text" required ${invalid(errors, "text")}>${state.text}</textarea>
        ${fieldError(errors, "text")}
      </div>
      <div class="actions">
        <button type="submit">Send</button>
        <a class="button secondary" href="/mail">Cancel</a>
      </div>
    </form>`,
  };
}

const JOB_STATES = {
  waiting_approval: ["Waiting for approval", "warning"],
  ready: ["Queued", "accent"],
  in_flight: ["Sending", "accent"],
  accepted: ["Accepted by Cloudflare", "success"],
  rejected: ["Not sent", "danger"],
  unknown: ["Outcome unknown", "warning"],
} as const;

function jobExplanation(job: OutboundJobStatus): string {
  switch (job.state) {
    case "waiting_approval":
      return "It waits for approval before it is sent.";
    case "ready":
    case "in_flight":
      return "AgentMail is sending it now. Refresh to see the result.";
    case "accepted":
      return "Cloudflare accepted it for delivery. Delivery to the recipient is not confirmed.";
    case "rejected":
      return job.failureClass === "provider"
        ? `Cloudflare rejected it (${job.failureDetail ?? "no code"}).`
        : `It was not sent (${[job.failureClass, job.failureDetail].filter((part) => part !== null).join(": ")}).`;
    case "unknown":
      return "Whether it was sent is not confirmed. Check the conversation before sending again.";
  }
}

export function sentPage(job: OutboundJobStatus, aside: Html): PageView {
  const [label, tone] = JOB_STATES[job.state];
  return {
    kind: "console",
    section: "mail",
    title: "Send status",
    heading: "Send status",
    lede: html`<span class="badge ${tone}">${label}</span>`,
    aside,
    main: html`<p>${jobExplanation(job)}</p>
      <div class="actions">
        <a class="button" href="/mail/threads/${encodeURIComponent(job.threadId)}"
          >Open conversation</a
        >
        <a class="button secondary" href="/mail/sent/${encodeURIComponent(job.jobId)}">Refresh</a>
      </div>`,
  };
}

const ComposeQuery = Schema.Struct({
  reply: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
});

const ComposeForm = Schema.Struct({
  requestId: Schema.optionalKey(Schema.String),
  fromAddressId: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  cc: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
});

function replyMode(mode: string | undefined): ReplyMode {
  return mode === "reply-all" ? "reply-all" : "reply";
}

function replySubject(subject: string | null): string {
  const base = subject === null ? "" : displayText(subject);
  return /^re:/iu.test(base) ? base : `Re: ${base}`;
}

const replyContext = Effect.fn("replyContext")(function* (
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  mode: ReplyMode,
) {
  const preview = yield* previewReplyRecipients(deps, principal, messageId, mode);
  const addresses = yield* listAddresses(deps);
  const from = addresses.find((address) => address.id === preview.parent.mailboxId);
  const context: ReplyContext = {
    messageId,
    mode,
    from: from?.address ?? "",
    to: preview.to,
    cc: preview.cc,
  };
  return { context, parent: preview.parent };
});

const composeAside = Effect.fn("composeAside")(function* (deps: ApiDeps) {
  return mailboxNav(yield* listAddresses(deps), null);
});

export const composeRoute = Effect.fn("composeRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const query = yield* HttpServerRequest.schemaSearchParams(ComposeQuery);
  const identities = yield* listSendingIdentities(deps, principal);
  const requestId = yield* randomId;
  if (query.reply === undefined) {
    const state = {
      requestId,
      fromAddressId: identities[0]?.id ?? "",
      to: "",
      cc: "",
      subject: "",
      text: "",
    };
    return yield* htmlResponse(
      200,
      composePage(identities, yield* composeAside(deps), state, null, {}),
    );
  }
  const reply = yield* replyContext(deps, principal, query.reply, replyMode(query.mode));
  const state = {
    requestId,
    fromAddressId: reply.parent.mailboxId,
    to: "",
    cc: "",
    subject: replySubject(reply.parent.subject),
    text: "",
  };
  return yield* htmlResponse(
    200,
    composePage(identities, yield* composeAside(deps), state, reply.context, {}),
  );
});

function contactsFrom(
  raw: string,
): { readonly contacts: Array<MailContact> } | { readonly invalid: string } {
  const parsed = parseMailAddressList(raw);
  if (parsed.kind !== "ok") return { invalid: `“${parsed.value}” is not an email address.` };
  return { contacts: parsed.addresses.map((address) => ({ address, displayName: null })) };
}

export const sendRoute = Effect.fn("sendRoute")(function* (deps: ApiDeps, principal: Principal) {
  const form = yield* HttpServerRequest.schemaBodyUrlParams(ComposeForm);
  const reply =
    form.reply === undefined
      ? null
      : yield* replyContext(deps, principal, form.reply, replyMode(form.mode));
  const state: ComposeState = {
    requestId: form.requestId ?? (yield* randomId),
    fromAddressId: reply?.parent.mailboxId ?? form.fromAddressId ?? "",
    to: form.to ?? "",
    cc: form.cc ?? "",
    subject: form.subject ?? "",
    text: form.text ?? "",
  };
  const errors: { -readonly [K in ComposeField]?: string } = {};
  const to = contactsFrom(state.to);
  const cc = contactsFrom(state.cc);
  if (reply === null) {
    if ("invalid" in to) errors.to = to.invalid;
    else if (to.contacts.length === 0) errors.to = "Add at least one recipient.";
    if ("invalid" in cc) errors.cc = cc.invalid;
  }
  if (state.text.trim().length === 0) errors.text = "Write a message.";
  if (Object.keys(errors).length > 0) {
    const identities = yield* listSendingIdentities(deps, principal);
    return yield* htmlResponse(
      400,
      composePage(identities, yield* composeAside(deps), state, reply?.context ?? null, errors),
    );
  }
  const payload = yield* Schema.decodeUnknownEffect(SubmitMessagePayload)(
    reply === null
      ? {
          intent: "compose",
          requestId: state.requestId,
          fromAddressId: state.fromAddressId,
          to: "contacts" in to ? to.contacts : [],
          cc: "contacts" in cc ? cc.contacts : [],
          subject: state.subject,
          text: state.text,
        }
      : {
          intent: "reply",
          requestId: state.requestId,
          fromAddressId: state.fromAddressId,
          replyToMessageId: reply.context.messageId,
          replyMode: reply.context.mode,
          subject: state.subject,
          text: state.text,
        },
  );
  const job = yield* submitMessage(deps, principal, payload);
  return redirect(`/mail/sent/${encodeURIComponent(job.jobId)}`);
});

const JobParams = Schema.Struct({ jobId: Schema.String });

export const sentRoute = Effect.fn("sentRoute")(function* (deps: ApiDeps, principal: Principal) {
  const { jobId } = yield* HttpRouter.schemaPathParams(JobParams);
  const job = yield* getJob(deps, principal, jobId);
  return yield* htmlResponse(200, sentPage(job, yield* composeAside(deps)));
});
