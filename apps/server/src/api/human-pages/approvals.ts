import type { OutboundJob, StoredApproval } from "../../account/domain.ts";
import type { ApprovalToken, MailContact, OutboundThreadMessage } from "@umail/api-contract";
import type { StoredMailHtml } from "@umail/mail-content";

import { productPageTitle } from "../brand/identity.ts";
import {
  projectApprovalDecisionMetadata,
  renderApprovalDecisionAddress,
  renderApprovalDecisionText,
} from "./metadata.ts";
import { escapeHtmlText, renderHumanPageInternal } from "./internal/page.ts";
import { renderHumanPageNotice } from "./notices.ts";

export type ApprovalMessagePreviewView = {
  readonly storedHtml: StoredMailHtml;
};

export function renderApprovalReviewPage(
  token: ApprovalToken,
  request: StoredApproval,
  message: OutboundThreadMessage,
  job: OutboundJob,
) {
  const statePresentation = approvalStatePresentation(request, job);
  return renderHumanPageInternal({
    status: 200,
    policy: "approvalReview",
    document: {
      title: productPageTitle(statePresentation.title),
      eyebrow: statePresentation.eyebrow,
      heading: statePresentation.heading,
      description: statePresentation.description,
      mainHtml: `${renderApprovalMetadata(request, message)}
${renderApprovalBody(token, message)}
${renderApprovalActions(token, request)}`,
    },
  });
}

export function renderApprovalNotFoundPage() {
  return renderHumanPageNotice({
    status: 404,
    title: productPageTitle("Review request not found"),
    eyebrow: "Review unavailable",
    heading: "This review request was not found",
    description: "The capability may be incomplete or unknown.",
    message: "Check that you opened the complete link from the approval email.",
    tone: "error",
  });
}

export function renderApprovalGonePage() {
  return renderHumanPageNotice({
    status: 410,
    title: productPageTitle("Review request unavailable"),
    eyebrow: "Review unavailable",
    heading: "This review request is no longer available",
    description: "It can no longer be used to inspect or decide the outbound email.",
    message: "The request may have expired, been cancelled, or become unavailable.",
    tone: "error",
  });
}

export function renderApprovalMessagePreview(view: ApprovalMessagePreviewView): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Outbound email preview</title>
</head>
<body>${view.storedHtml.body}</body>
</html>`;
}

type ApprovalStatePresentation = {
  readonly title: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
};

function approvalStatePresentation(
  request: StoredApproval,
  job: OutboundJob,
): ApprovalStatePresentation {
  if (request.state === "pending") {
    return {
      title: "Review outbound email",
      eyebrow: "Decision required",
      heading: "Review before sending",
      description:
        "Inspect the persisted message below. Approving makes the job ready for the mail worker; denying records that no provider call should be made.",
    };
  }
  if (request.state === "denied") {
    return {
      title: "Outbound email denied",
      eyebrow: "Decision recorded",
      heading: "This email was denied",
      description: "The denial is final. No provider call was made for this outbound email.",
    };
  }
  if (job.state === "accepted") {
    return {
      title: "Outbound email approved",
      eyebrow: "Approved · provider accepted",
      heading: "Approved for sending",
      description:
        "Approved; accepted by Cloudflare for delivery. Recipient delivery is not yet confirmed.",
    };
  }
  if (job.state === "rejected" && job.failureClass === "provider") {
    return {
      title: "Outbound approval recorded",
      eyebrow: "Approved · submission failed",
      heading: "Approval recorded",
      description:
        "Approval recorded; Cloudflare did not confirm submission. Do not retry automatically.",
    };
  }
  return {
    title: "Outbound approval recorded",
    eyebrow: "Approved · outcome unconfirmed",
    heading: "Approval recorded",
    description:
      "Approval recorded; submission outcome is not confirmed. Do not retry automatically.",
  };
}

function renderApprovalMetadata(request: StoredApproval, message: OutboundThreadMessage): string {
  const requester = request.requester.label;
  const from = message.from[0];
  const replyTo = message.replyTo[0];
  let replyToHtml = "";
  if (replyTo !== undefined && (from === undefined || !sameContact(replyTo, from))) {
    replyToHtml = renderMetadataRow("Reply-To", renderContact(replyTo));
  }
  const subject =
    message.subject === null || message.subject.length === 0 ? "(no subject)" : message.subject;
  const context = message.parentMessageId === null ? "New message" : "Reply to an existing message";
  return `<section class="review-section" aria-labelledby="message-details-title">
  <h2 id="message-details-title">Message details</h2>
  <dl class="message-details">
    ${renderMetadataRow("Requested by", renderDecisionText(requester))}
    ${renderMetadataRow("From", from === undefined ? renderDecisionText("Unavailable") : renderContact(from))}
    ${replyToHtml}
    ${renderContactListRow("To", message.to)}
    ${message.cc.length === 0 ? "" : renderContactListRow("Cc", message.cc)}
    ${renderMetadataRow("Subject", renderDecisionText(subject))}
    ${renderMetadataRow("Context", renderDecisionText(context))}
    ${renderTimeRow("Requested", request.createdAt)}
    ${renderTimeRow("Expires", request.expiresAt)}
  </dl>
</section>`;
}

function renderApprovalBody(token: ApprovalToken, message: OutboundThreadMessage): string {
  const textPreview =
    message.textBody === null
      ? ""
      : `<pre class="message-text">${escapeHtmlText(message.textBody)}</pre>`;
  if (message.htmlBody === null) {
    return `<section class="review-section message-preview" aria-labelledby="message-body-title">
  <h2 id="message-body-title">Message body</h2>
  ${textPreview.length === 0 ? '<p class="empty-value">No readable body is available.</p>' : textPreview}
</section>`;
  }
  const previewPath = `/approvals/${encodeURIComponent(token)}/message`;
  const htmlPreview = `<iframe class="message-frame" title="HTML email preview" src="${escapeHtmlText(previewPath)}" sandbox=""></iframe>`;
  const alternative =
    textPreview.length === 0
      ? ""
      : `<details class="text-alternative"><summary>Show plain-text alternative</summary>${textPreview}</details>`;
  return `<section class="review-section message-preview" aria-labelledby="message-body-title">
  <h2 id="message-body-title">Message body</h2>
  ${htmlPreview}
  ${alternative}
</section>`;
}

function renderApprovalActions(token: ApprovalToken, request: StoredApproval): string {
  if (request.state !== "pending") {
    return "";
  }
  const base = `/approvals/${encodeURIComponent(token)}`;
  return `<section class="review-section decision-panel" aria-labelledby="decision-title">
  <h2 id="decision-title">Choose what happens next</h2>
  <p>Approve only if every detail is correct. Denying records a final decision without calling the email provider.</p>
  <form method="post" class="form-actions">
    <button type="submit" formaction="${escapeHtmlText(`${base}/approve`)}">Approve &amp; send</button>
    <button type="submit" class="button--secondary" formaction="${escapeHtmlText(`${base}/deny`)}">Deny request</button>
  </form>
</section>`;
}

function renderMetadataRow(label: string, valueHtml: string): string {
  return `<dt>${escapeHtmlText(label)}</dt><dd>${valueHtml}</dd>`;
}

function renderTimeRow(label: string, value: string): string {
  return renderMetadataRow(
    label,
    `<time datetime="${escapeHtmlText(value)}">${renderDecisionText(value)}</time>`,
  );
}

function renderContactListRow(label: string, contacts: ReadonlyArray<MailContact>): string {
  const items = contacts.map((contact) => `<li>${renderContact(contact)}</li>`).join("");
  return renderMetadataRow(label, `<ul class="contact-list">${items}</ul>`);
}

function renderContact(contact: MailContact): string {
  const address = renderApprovalDecisionAddress(
    projectApprovalDecisionMetadata(contact.address),
  ).html;
  if (contact.displayName === null || contact.displayName.length === 0) {
    return address;
  }
  return `<span class="contact">${renderDecisionText(contact.displayName)} <span aria-hidden="true">&lt;</span>${address}<span aria-hidden="true">&gt;</span></span>`;
}

function renderDecisionText(value: string): string {
  return renderApprovalDecisionText(projectApprovalDecisionMetadata(value)).html;
}

function sameContact(left: MailContact, right: MailContact): boolean {
  return left.address === right.address && left.displayName === right.displayName;
}
