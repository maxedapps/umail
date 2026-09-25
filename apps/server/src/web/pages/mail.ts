import type {
  Address,
  MailContact,
  MailMessageSummary,
  MailThreadSummary,
  Principal,
  ThreadMessage,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import type { ApiDeps } from "../../api/app.ts";
import { attachmentResponseHeaders } from "../../api/attachments.ts";
import {
  getMessage,
  getThread,
  listAddresses,
  listThreads,
  readAttachment,
  setThreadReadState,
  softDeleteVisibleThread,
} from "../../api/operations.ts";
import {
  BODY_FRAME_CSP,
  bodyDocument,
  bodyFrameHeaders,
  htmlResponse,
  redirect,
  type Flash,
  type PageView,
} from "../document.ts";
import {
  bidiAddress,
  bidiText,
  contactListHtml,
  contactName,
  displayText,
  html,
  initials,
  shortTimeHtml,
  timeHtml,
  type Html,
} from "../html.ts";
import { icon } from "../icons.ts";

const PAGE_SIZE = 25;

function subjectText(subject: string | null): string {
  return subject === null || subject.trim().length === 0 ? "(no subject)" : displayText(subject);
}

function threadRow(thread: MailThreadSummary, showMailboxes: boolean): Html {
  return html`<li>
    <a
      class="${thread.unreadCount > 0 ? "thread unread" : "thread"}"
      href="/mail/threads/${encodeURIComponent(thread.threadId)}"
    >
      <span class="dot"></span>
      <span class="who"
        ><b>${bidiText(contactName(thread.latestSender.contact))}</b>${
          thread.messageCount > 1 ? html`<small>${thread.messageCount}</small>` : null
        }</span
      >
      <span class="what"
        >${bidiText(subjectText(thread.subject))}${
          showMailboxes
            ? thread.involvedMailboxIdentities.map(
                (identity) => html`<span class="chip">${identity.address.split("@")[0]}@</span>`,
              )
            : null
        }</span
      >
      ${shortTimeHtml(thread.lastActivityAt)}
    </a>
  </li>`;
}

export function mailListPage(
  addresses: ReadonlyArray<Address>,
  mailbox: Address | undefined,
  threads: ReadonlyArray<MailThreadSummary>,
  olderHref: string | null,
  flash: Flash | undefined,
): PageView {
  return {
    kind: "console",
    section: "mail",
    title: "Mail",
    heading: mailbox === undefined ? "All mailboxes" : mailbox.address,
    flash,
    mailboxes: { addresses, current: mailbox?.id ?? "all" },
    main: html`${
      threads.length === 0
        ? html`<p class="empty">No conversations here yet.</p>`
        : html`<ul class="threads">
            ${threads.map((thread) => threadRow(thread, mailbox === undefined))}
          </ul>`
    }
    ${
      olderHref === null
        ? null
        : html`<div class="pager">
            <a class="button secondary" href="${olderHref}">Older${icon("right")}</a>
          </div>`
    }`,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function namesHtml(contacts: ReadonlyArray<MailContact>): Html {
  return html`${contacts.map(
    (contact, index) => html`${index === 0 ? null : ", "}${bidiText(contactName(contact))}`,
  )}`;
}

function senderName(from: MailContact | undefined): string {
  return from === undefined ? "Unknown sender" : contactName(from);
}

function openMessageHtml(message: ThreadMessage, mailbox: Address | undefined): Html {
  const path = `/mail/messages/${encodeURIComponent(message.id)}`;
  const from = message.from[0];
  const text =
    message.textBody === null ? null : html`<pre class="prose">${message.textBody}</pre>`;
  const attachments = message.attachments;
  const hasInlineImages = attachments.some((attachment) => attachment.isInline);
  const hidesImages = message.hasRemoteImages || hasInlineImages;
  return html`<article class="message" id="open-message" aria-label="Message">
    <div class="message-head">
      <span class="avatar">${bidiText(initials(senderName(from)))}</span>
      <div>
        <span
          ><b>${bidiText(senderName(from))}</b>${
            from === undefined
              ? null
              : html` <span class="mono muted">${bidiAddress(from.address)}</span>`
          }</span
        >
        <small
          >${[
            message.to.length === 0 ? null : html`to ${namesHtml(message.to)}`,
            message.cc.length === 0 ? null : html`cc ${namesHtml(message.cc)}`,
          ]
            .filter((part) => part !== null)
            .map((part, index) => html`${index === 0 ? null : ", "}${part}`)}</small
        >
      </div>
      ${timeHtml(message.occurredAt)}
    </div>
    <details class="more">
      <summary>Details</summary>
      <dl class="meta">
        <dt>From</dt>
        <dd>${contactListHtml(message.from)}</dd>
        <dt>To</dt>
        <dd>${contactListHtml(message.to)}</dd>
        ${
          message.cc.length === 0
            ? null
            : html`<dt>Cc</dt>
                <dd>${contactListHtml(message.cc)}</dd>`
        }
        <dt>Date</dt>
        <dd>${timeHtml(message.occurredAt)}</dd>
        ${
          mailbox === undefined
            ? null
            : html`<dt>Mailbox</dt>
                <dd class="mono">${mailbox.address}</dd>`
        }
      </dl>
    </details>
    ${
      message.htmlBody === null
        ? (text ?? html`<p class="muted">This message has no readable body.</p>`)
        : html`${
              hidesImages
                ? html`<p class="note">
                    ${icon("eye-off")}${
                      hasInlineImages
                        ? "Images are not shown. Inline images are listed as attachments below."
                        : "Images are not shown."
                    }
                  </p>`
                : null
            }
            <iframe
              class="frame"
              title="Message body"
              src="${path}/body"
              sandbox=""
              loading="lazy"
            ></iframe>
            ${
              text === null
                ? null
                : html`<details class="more">
                    <summary>Show plain-text version</summary>
                    ${text}
                  </details>`
            }`
    }
    ${
      attachments.length === 0
        ? null
        : html`<ul class="files" aria-label="Attachments">
            ${attachments.map(
              (attachment) =>
                html`<li>
                  <a href="${path}/attachments/${encodeURIComponent(attachment.id)}" download
                    >${icon("clip")}${bidiText(attachment.filename)}<small
                      >${formatSize(attachment.size)}</small
                    ></a
                  >
                </li>`,
            )}
          </ul>`
    }
  </article>`;
}

function collapsedMessageHtml(threadPath: string, message: MailMessageSummary): Html {
  const name = senderName(message.from[0]);
  return html`<li>
    <a class="message-row" href="${threadPath}?open=${encodeURIComponent(message.id)}">
      <span class="avatar">${bidiText(initials(name))}</span>
      <b>${bidiText(name)}</b>
      ${shortTimeHtml(message.occurredAt)}
    </a>
  </li>`;
}

export function threadPage(
  addresses: ReadonlyArray<Address>,
  threadId: string,
  messages: ReadonlyArray<MailMessageSummary>,
  open: ThreadMessage,
): PageView {
  const threadPath = `/mail/threads/${encodeURIComponent(threadId)}`;
  const reply = `/mail/compose?reply=${encodeURIComponent(open.id)}`;
  const mailbox = addresses.find((address) => address.id === open.addressId);
  return {
    kind: "console",
    section: "mail",
    title: subjectText(open.subject),
    heading: subjectText(open.subject),
    lede: html`${messages.length === 1 ? "1 message" : `${messages.length} messages`}
    ${mailbox === undefined ? null : html`<span class="chip">${mailbox.address}</span>`}`,
    mailboxes: { addresses, current: null },
    toolbar: html`<a class="button quiet" href="/mail"
        >${icon("left")}<span class="label">All mailboxes</span></a
      >
      <a class="button" href="${reply}&mode=reply"
        >${icon("reply")}<span class="label">Reply</span></a
      >
      <a class="button secondary" href="${reply}&mode=reply-all"
        >${icon("reply-all")}<span class="label">Reply all</span></a
      >
      <form method="post" action="${threadPath}/unread">
        <button class="button secondary" type="submit">
          ${icon("mail")}<span class="label">Mark unread</span>
        </button>
      </form>
      <button class="button danger" type="button" popovertarget="delete-dialog">
        ${icon("trash")}<span class="label">Delete…</span>
      </button>`,
    main: html`<div id="delete-dialog" popover>
        <h2>Delete this conversation?</h2>
        <p>It disappears from every mailbox view and from agents.</p>
        <form class="actions" method="post" action="${threadPath}/delete">
          <button class="button danger solid" type="submit">Delete</button>
          <button
            class="button secondary"
            type="button"
            popovertarget="delete-dialog"
            popovertargetaction="hide"
          >
            Cancel
          </button>
        </form>
      </div>
      <ol class="messages">
        ${messages.map((message) =>
          message.id === open.id
            ? html`<li>${openMessageHtml(open, mailbox)}</li>`
            : collapsedMessageHtml(threadPath, message),
        )}
      </ol>`,
  };
}

const MailQuery = Schema.Struct({
  mailbox: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  deleted: Schema.optionalKey(Schema.String),
  unread: Schema.optionalKey(Schema.String),
});

// Reading one mailbox narrows the operator's scope, so the store filters without a new query.
function scopedTo(principal: Principal, mailboxId: string): Principal {
  return { ...principal, policy: { ...principal.policy, mailboxIds: [mailboxId] } };
}

export const mailListRoute = Effect.fn("mailListRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const query = yield* HttpServerRequest.schemaSearchParams(MailQuery);
  const addresses = yield* listAddresses(deps);
  const mailbox = addresses.find((address) => address.id === query.mailbox);
  const scoped = query.mailbox === undefined ? principal : scopedTo(principal, query.mailbox);
  const page = yield* listThreads(deps, scoped, PAGE_SIZE, query.cursor);
  const older = new URLSearchParams();
  if (query.mailbox !== undefined) older.set("mailbox", query.mailbox);
  if (page.nextCursor !== null) older.set("cursor", page.nextCursor);
  const olderHref = page.nextCursor === null ? null : `/mail?${older.toString()}`;
  const flash: Flash | undefined =
    query.deleted !== undefined
      ? { tone: "success", message: "Conversation deleted." }
      : query.unread !== undefined
        ? { tone: "success", message: "Marked as unread." }
        : undefined;
  return yield* htmlResponse(200, mailListPage(addresses, mailbox, page.items, olderHref, flash));
});

const ThreadParams = Schema.Struct({
  threadId: Schema.String,
  open: Schema.optionalKey(Schema.String),
});

// Opening a conversation marks it read; "Mark unread" undoes that.
export const threadRoute = Effect.fn("threadRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const params = yield* HttpRouter.schemaParams(ThreadParams);
  // The store's largest page, so the newest message of any but a huge conversation is on it.
  let thread = yield* getThread(deps, principal, params.threadId, { limit: 200 });
  if (thread.messages.some((message) => message.direction === "inbound" && !message.isRead)) {
    yield* setThreadReadState(deps, principal, params.threadId, true);
    thread = yield* getThread(deps, principal, params.threadId, { limit: 200 });
  }
  const openId = params.open ?? thread.messages.at(-1)?.id;
  if (openId === undefined || !thread.messages.some((message) => message.id === openId)) {
    return yield* new HttpApiError.NotFound();
  }
  const open = yield* getMessage(deps, principal, openId);
  return yield* htmlResponse(
    200,
    threadPage(yield* listAddresses(deps), params.threadId, thread.messages, open),
  );
});

const ThreadIdParams = Schema.Struct({ threadId: Schema.String });

export const markUnreadRoute = Effect.fn("markUnreadRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const { threadId } = yield* HttpRouter.schemaPathParams(ThreadIdParams);
  yield* setThreadReadState(deps, principal, threadId, false);
  return redirect("/mail?unread");
});

export const deleteThreadRoute = Effect.fn("deleteThreadRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const { threadId } = yield* HttpRouter.schemaPathParams(ThreadIdParams);
  yield* softDeleteVisibleThread(deps, principal, threadId);
  return redirect("/mail?deleted");
});

const MessageParams = Schema.Struct({ messageId: Schema.String });

// The stored HTML, framed in a sandbox that loads nothing. Inline (`cid:`) images stay blocked like
// remote ones, since the sandboxed frame's requests carry no session; they are listed as attachments.
export const messageBodyRoute = Effect.fn("messageBodyRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const { messageId } = yield* HttpRouter.schemaPathParams(MessageParams);
  const message = yield* getMessage(deps, principal, messageId);
  if (message.htmlBody === null) {
    return yield* new HttpApiError.NotFound();
  }
  return HttpServerResponse.text(bodyDocument(message.htmlBody), {
    contentType: "text/html; charset=utf-8",
    headers: bodyFrameHeaders(BODY_FRAME_CSP),
  });
});

const AttachmentParams = Schema.Struct({ messageId: Schema.String, attachmentId: Schema.String });

export const attachmentRoute = Effect.fn("attachmentRoute")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const params = yield* HttpRouter.schemaPathParams(AttachmentParams);
  const { stored, bytes } = yield* readAttachment(
    deps,
    principal,
    params.messageId,
    params.attachmentId,
  );
  return HttpServerResponse.uint8Array(bytes, {
    headers: {
      ...attachmentResponseHeaders(stored.meta.mimeType, stored.meta.filename),
      "cache-control": "private, no-store",
    },
  });
});
