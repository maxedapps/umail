import type {
  Address,
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
  bidiText,
  contactHtml,
  contactName,
  displayText,
  html,
  timeHtml,
  type Html,
} from "../html.ts";

const PAGE_SIZE = 25;

function subjectText(subject: string | null): string {
  return subject === null || subject.trim().length === 0 ? "(no subject)" : displayText(subject);
}

// The sidebar: every mailbox, with the list being read ("all" or a mailbox id) marked.
export function mailboxNav(addresses: ReadonlyArray<Address>, current: string | null): Html {
  const link = (href: string, label: Html | string, selected: boolean) =>
    html`<li><a href="${href}" aria-current="${selected ? "page" : "false"}">${label}</a></li>`;
  return html`<nav class="stack" aria-label="Mailboxes">
    <a class="button" href="/mail/compose">Write</a>
    <ul class="nav-list">
      ${link("/mail", "All mailboxes", current === "all")}
      ${addresses.map((address) =>
        link(
          `/mail?mailbox=${encodeURIComponent(address.id)}`,
          html`<span class="mono">${address.address}</span>`,
          current === address.id,
        ),
      )}
    </ul>
  </nav>`;
}

function threadRow(thread: MailThreadSummary, showMailboxes: boolean): Html {
  const details = [
    contactName(thread.latestSender.contact),
    ...(showMailboxes ? thread.involvedMailboxIdentities.map((identity) => identity.address) : []),
    ...(thread.messageCount > 1 ? [`${thread.messageCount} messages`] : []),
  ];
  return html`<li>
    <a
      class="row${thread.unreadCount > 0 ? " unread" : ""}"
      href="/mail/threads/${encodeURIComponent(thread.threadId)}"
    >
      <span class="primary">${bidiText(subjectText(thread.subject))}</span>
      <span class="aside">${timeHtml(thread.lastActivityAt)}</span>
      <span class="secondary">${bidiText(details.join(" · "))}</span>
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
    aside: mailboxNav(addresses, mailbox?.id ?? "all"),
    main: html`${
      threads.length === 0
        ? html`<p class="empty">No conversations here yet.</p>`
        : html`<ul class="list">
            ${threads.map((thread) => threadRow(thread, mailbox === undefined))}
          </ul>`
    }
    ${olderHref === null ? null : html`<p><a class="button secondary" href="${olderHref}">Older</a></p>`}`,
  };
}

function contactList(contacts: ThreadMessage["to"]): Html {
  return html`<ul>
    ${contacts.map((contact) => html`<li>${contactHtml(contact)}</li>`)}
  </ul>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openMessageHtml(message: ThreadMessage, addresses: ReadonlyArray<Address>): Html {
  const path = `/mail/messages/${encodeURIComponent(message.id)}`;
  const mailbox = addresses.find((address) => address.id === message.addressId);
  const text =
    message.textBody === null ? null : html`<pre class="prose">${message.textBody}</pre>`;
  const attachments = message.attachments;
  const hidesImages =
    message.hasRemoteImages || attachments.some((attachment) => attachment.isInline);
  return html`<article class="panel" id="open-message" aria-label="Message">
    <dl class="meta">
      <dt>From</dt>
      <dd>${contactList(message.from)}</dd>
      <dt>To</dt>
      <dd>${contactList(message.to)}</dd>
      ${
        message.cc.length === 0
          ? null
          : html`<dt>Cc</dt>
              <dd>${contactList(message.cc)}</dd>`
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
    ${
      message.htmlBody === null
        ? (text ?? html`<p class="muted">This message has no readable body.</p>`)
        : html`${
              hidesImages
                ? html`<p class="note warning" role="note">
                    Images are not shown. Inline images are listed under Attachments.
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
                : html`<details>
                    <summary>Show plain-text version</summary>
                    ${text}
                  </details>`
            }`
    }
    ${
      attachments.length === 0
        ? null
        : html`<section class="stack" aria-label="Attachments">
            <h2>Attachments</h2>
            <ul class="list">
              ${attachments.map(
                (attachment) =>
                  html`<li>
                    <a
                      class="row"
                      href="${path}/attachments/${encodeURIComponent(attachment.id)}"
                      download
                    >
                      <span class="primary">${bidiText(attachment.filename)}</span>
                      <span class="aside">${formatSize(attachment.size)}</span>
                    </a>
                  </li>`,
              )}
            </ul>
          </section>`
    }
  </article>`;
}

function collapsedMessageHtml(threadPath: string, message: MailMessageSummary): Html {
  const from = message.from[0];
  return html`<li>
    <a class="row" href="${threadPath}?open=${encodeURIComponent(message.id)}">
      <span class="primary"
        >${bidiText(from === undefined ? "Unknown sender" : contactName(from))}</span
      >
      <span class="aside">${timeHtml(message.occurredAt)}</span>
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
  return {
    kind: "console",
    section: "mail",
    title: subjectText(open.subject),
    heading: subjectText(open.subject),
    lede: messages.length === 1 ? "1 message" : `${messages.length} messages`,
    aside: mailboxNav(addresses, null),
    main: html`<div class="actions">
        <a class="button" href="${reply}&mode=reply">Reply</a>
        <a class="button secondary" href="${reply}&mode=reply-all">Reply all</a>
        <form method="post" action="${threadPath}/unread">
          <button class="secondary" type="submit">Mark unread</button>
        </form>
        <button class="danger" type="button" popovertarget="delete-dialog">Delete…</button>
      </div>
      <div id="delete-dialog" popover>
        <h2>Delete this conversation?</h2>
        <p>It disappears from every mailbox view and from agents.</p>
        <form class="actions" method="post" action="${threadPath}/delete">
          <button class="danger solid" type="submit">Delete</button>
          <button
            class="secondary"
            type="button"
            popovertarget="delete-dialog"
            popovertargetaction="hide"
          >
            Cancel
          </button>
        </form>
      </div>
      <ol class="list">
        ${messages.map((message) =>
          message.id === open.id
            ? html`<li>${openMessageHtml(open, addresses)}</li>`
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
  let thread = yield* getThread(deps, principal, params.threadId);
  if (thread.messages.some((message) => message.direction === "inbound" && !message.isRead)) {
    thread = yield* setThreadReadState(deps, principal, params.threadId, true);
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
