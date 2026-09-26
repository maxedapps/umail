import type { OutboundJobFailureClass, OutboundJobState } from "@umail/api-contract";

import { html, type Html } from "./html.ts";

// The one vocabulary for what happened to an outbound message, shared by the sent page, the
// approval page and the conversation. It never says "delivered": Cloudflare's acceptance is all
// AgentMail knows. And it never says "not sent" when the outcome is uncertain.
const STATES = {
  waiting_approval: ["Waiting for approval", "warning"],
  ready: ["Queued", "accent"],
  in_flight: ["Sending", "accent"],
  accepted: ["Accepted by Cloudflare", "success"],
  rejected: ["Not sent", "danger"],
  unknown: ["Outcome unknown", "warning"],
} as const satisfies Record<OutboundJobState, readonly [string, string]>;

const FAILURES = {
  denied: "The request was denied.",
  expired: "Nobody approved it within 24 hours.",
  cancelled: "It was withdrawn before sending (its conversation was deleted).",
  notification_failed: "The approval email to the operator could not be sent.",
  policy: "It was blocked before sending.",
  provider: "Cloudflare rejected it.",
} as const satisfies Record<OutboundJobFailureClass, string>;

type SendOutcome = {
  readonly state: OutboundJobState;
  readonly failureClass: OutboundJobFailureClass | null;
  readonly failureDetail: string | null;
};

export function sendStateBadge(state: OutboundJobState): Html {
  const [label, tone] = STATES[state];
  return html`<span class="badge ${tone}">${label}</span>`;
}

export function sendStateExplanation(job: SendOutcome): string {
  switch (job.state) {
    case "waiting_approval":
      return "It waits for the operator's approval before it is sent.";
    case "ready":
    case "in_flight":
      return "AgentMail is sending it now. Refresh to see the result.";
    case "accepted":
      return "Cloudflare accepted it for delivery; delivery to the recipient is not confirmed.";
    case "rejected":
      return withDetail(
        job.failureClass === null ? "It was not sent." : FAILURES[job.failureClass],
        job.failureDetail,
      );
    case "unknown":
      return `${withDetail("AgentMail cannot confirm whether it was sent and will not retry it.", job.failureDetail)} Ask the recipient before sending it again.`;
  }
}

// "Cloudflare rejected it (E_VALIDATION_ERROR: bad sender)."
function withDetail(sentence: string, detail: string | null): string {
  return detail === null ? sentence : `${sentence.slice(0, -1)} (${detail}).`;
}
