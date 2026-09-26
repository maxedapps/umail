import type { ApprovalToken, MailContact, OutboundThreadMessage } from "@umail/api-contract";
import * as DateTime from "effect/DateTime";

import type { OutboundJob, StoredApproval } from "../../account/domain.ts";
import type { PageView } from "../document.ts";
import {
  bidiText,
  contactHtml,
  contactListHtml,
  html,
  initials,
  timeHtml,
  type Html,
} from "../html.ts";
import { icon } from "../icons.ts";
import { sendStateBadge, sendStateExplanation } from "../send-state.ts";
import { noticePage } from "./notice.ts";

type StatePresentation = {
  readonly title: string;
  readonly heading: string;
  readonly lede: string;
  readonly badge: Html;
};

export function approvalReviewPage(
  token: ApprovalToken,
  request: StoredApproval,
  message: OutboundThreadMessage,
  job: OutboundJob,
  nowIso: string,
): PageView {
  const state = statePresentation(request, job);
  return {
    kind: "approval",
    title: state.title,
    heading: state.heading,
    lede: state.lede,
    main: html`${summaryHtml(request, message, state.badge, nowIso)} ${bodyHtml(token, message)}
    ${actionsHtml(token, request)}`,
  };
}

export function approvalNotFoundPage(): PageView {
  return noticePage({
    title: "Review request not found",
    heading: "This review request was not found",
    message: "Check that you opened the complete link from the approval email.",
    tone: "error",
  });
}

export function approvalGonePage(): PageView {
  return noticePage({
    title: "Review request unavailable",
    heading: "This review request is no longer available",
    message:
      "It may have expired or been cancelled, so it can no longer be used to review or decide this email.",
    tone: "error",
  });
}

function statePresentation(request: StoredApproval, job: OutboundJob): StatePresentation {
  if (request.state === "pending") {
    return {
      title: "Review outbound email",
      heading: "Review before sending",
      lede: "Check the message below. Nothing is sent until you approve it.",
      badge: html`<span class="badge warning">Waiting for you</span>`,
    };
  }
  if (request.state === "denied") {
    return {
      title: "Outbound email denied",
      heading: "This email was denied",
      lede: "The denial is final. The email was not sent.",
      badge: html`<span class="badge danger">Denied</span>`,
    };
  }
  return {
    title: "Outbound email approved",
    heading: "You approved this email",
    lede: sendStateExplanation(job),
    badge: sendStateBadge(job.state),
  };
}

// The request at a glance: its state, who asks, the subject, then every header the email carries.
function summaryHtml(
  request: StoredApproval,
  message: OutboundThreadMessage,
  badge: Html,
  nowIso: string,
): Html {
  const from = message.from[0];
  const replyTo = message.replyTo[0];
  const showReplyTo = replyTo !== undefined && (from === undefined || !sameContact(replyTo, from));
  return html`<div class="summary">
    <p>
      ${badge}${
        request.state === "pending"
          ? html`${icon("clock")}expires in ${expiresIn(request.expiresAt, nowIso)}`
          : null
      }
    </p>
    <div class="who">
      <span class="avatar">${bidiText(initials(request.requester.label))}</span>
      <span
        ><b>${bidiText(request.requester.label)}</b>
        ${request.state === "pending" ? "wants to send" : "asked to send"}</span
      >
    </div>
    <h2>${bidiText(subjectOf(message))}</h2>
    <dl class="meta">
      <dt>Requested by</dt>
      <dd>${bidiText(request.requester.label)}</dd>
      <dt>From</dt>
      <dd>${from === undefined ? bidiText("Unavailable") : contactHtml(from)}</dd>
      ${
        showReplyTo
          ? html`<dt>Reply-To</dt>
              <dd>${contactHtml(replyTo)}</dd>`
          : null
      }
      <dt>To</dt>
      <dd>${contactListHtml(message.to)}</dd>
      ${
        message.cc.length === 0
          ? null
          : html`<dt>Cc</dt>
              <dd>${contactListHtml(message.cc)}</dd>`
      }
      <dt>Subject</dt>
      <dd>${bidiText(subjectOf(message))}</dd>
      <dt>Context</dt>
      <dd>
        ${bidiText(message.parentMessageId === null ? "New message" : "Reply to an existing message")}
      </dd>
      <dt>Requested</dt>
      <dd>${timeHtml(request.createdAt)}</dd>
      ${
        request.state === "pending"
          ? html`<dt>Expires</dt>
              <dd>${timeHtml(request.expiresAt)}</dd>`
          : null
      }
    </dl>
  </div>`;
}

function expiresIn(expiresAt: string, nowIso: string): string {
  const millis =
    DateTime.toEpochMillis(DateTime.makeUnsafe(expiresAt)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(nowIso));
  const minutes = Math.max(0, Math.ceil(millis / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

function subjectOf(message: OutboundThreadMessage): string {
  return message.subject === null || message.subject.length === 0
    ? "(no subject)"
    : message.subject;
}

function bodyHtml(token: ApprovalToken, message: OutboundThreadMessage): Html {
  const text =
    message.textBody === null ? null : html`<pre class="prose">${message.textBody}</pre>`;
  return html`<section class="stack" id="message-body" aria-labelledby="message-body-title">
    <h2 class="section-label" id="message-body-title">Message body</h2>
    ${
      message.htmlBody === null
        ? (text ?? html`<p class="muted">No readable body is available.</p>`)
        : html`${
              message.hasRemoteImages
                ? html`<p class="note warning" role="note">
                    ${icon("alert")}This message contains remote images. They are blocked in this
                    preview, but the recipient's mail client will load them, and image URLs can
                    carry data out. Deny unless you expected images.
                  </p>`
                : null
            }
            <iframe
              class="frame"
              title="HTML email preview"
              src="/approvals/${encodeURIComponent(token)}/message"
              sandbox=""
            ></iframe>
            ${
              text === null
                ? null
                : html`<details class="more">
                    <summary>Show plain-text alternative</summary>
                    ${text}
                  </details>`
            }`
    }
  </section>`;
}

// After the body, never pinned, so the reviewer passes the whole message before reaching Approve.
function actionsHtml(token: ApprovalToken, request: StoredApproval): Html | null {
  if (request.state !== "pending") return null;
  const base = `/approvals/${encodeURIComponent(token)}`;
  return html`<section class="decision" id="decision" aria-labelledby="decision-title">
    <h2 class="sr-only" id="decision-title">Choose what happens next</h2>
    <p>Approve only if every detail is correct. Denying is final, and the email is not sent.</p>
    <form method="post" class="actions">
      <button class="button" type="submit" formaction="${base}/approve">Approve &amp; send</button>
      <button class="button secondary" type="submit" formaction="${base}/deny">Deny request</button>
    </form>
  </section>`;
}

function sameContact(left: MailContact, right: MailContact): boolean {
  return left.address === right.address && left.displayName === right.displayName;
}
