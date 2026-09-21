import type { McpOAuthPolicy } from "../../account/domain.ts";

import { productPageTitle } from "../brand/identity.ts";
import { escapeHtmlText, renderHumanPageInternal } from "./internal/page.ts";

export type DeviceAuthorizationView = {
  readonly userCode: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
};

export function renderDeviceAuthorizationPage(view: DeviceAuthorizationView) {
  return renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle("Approve device"),
      eyebrow: "Device authorization",
      heading: "Review the CLI request",
      description:
        "Approve only when this code exactly matches the code shown by the AgentMail CLI.",
      mainHtml: `<dl class="consent-details">
  <dt>User code</dt><dd><strong><bdi dir="ltr">${escapeHtmlText(view.userCode)}</bdi></strong></dd>
  <dt>Client</dt><dd><bdi dir="ltr">${escapeHtmlText(view.clientId)}</bdi></dd>
  <dt>Scope</dt><dd><bdi dir="auto">${escapeHtmlText(view.scope)}</bdi></dd>
  <dt>Resource</dt><dd><bdi dir="ltr">${escapeHtmlText(view.resource)}</bdi></dd>
</dl>
<form class="form-actions" method="post">
  <input type="hidden" name="userCode" value="${escapeHtmlText(view.userCode)}">
  <button type="submit" formaction="/device/approve">Approve CLI access</button>
  <button type="submit" class="button--secondary" formaction="/device/deny">Deny request</button>
</form>`,
    },
  });
}

export function renderDeviceDecisionPage(decision: "approved" | "denied") {
  return renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle(`Device ${decision}`),
      eyebrow: "Device authorization",
      heading: decision === "approved" ? "CLI access approved" : "CLI access denied",
      description:
        decision === "approved"
          ? "Return to the terminal. The CLI can now complete OAuth token exchange."
          : "The CLI request was denied and cannot receive tokens.",
      mainHtml: `<div class="notice-panel"><p>You may close this browser tab.</p></div>`,
    },
  });
}

export function renderMcpClientsPage(policies: ReadonlyArray<McpOAuthPolicy>) {
  const items = policies.map(renderPolicy).join("");
  return renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle("MCP access policies"),
      eyebrow: "MCP access",
      heading: "Manage MCP access",
      description:
        "Clients appear after their first verified request. Policy changes affect the next MCP request.",
      mainHtml: `<section class="review-section"><h2>Authorized clients</h2>${items.length === 0 ? '<p class="empty-value">No MCP client has completed authorization.</p>' : items}</section>`,
    },
  });
}

function renderPolicy(policy: McpOAuthPolicy): string {
  const id = escapeHtmlText(policy.clientId);
  const actionId = encodeURIComponent(policy.clientId);
  const revoked = policy.state === "revoked";
  const controls = revoked
    ? '<p class="notice-panel">This revocation is permanent for this client ID. A host that registers dynamically can register again under a new ID; a client with a fixed ID cannot reconnect. To pause access reversibly, clear "Client active" instead of revoking.</p>'
    : `<form class="auth-form" method="post" action="/clients/${actionId}/policy">
    <div class="field"><label class="field__label" for="label-${actionId}">Client label</label><input id="label-${actionId}" name="label" type="text" value="${escapeHtmlText(policy.label)}" required></div>
    ${renderPolicyFields(policy.clientId, policy.policy)}
    <label class="checkbox-field"><input id="active-${actionId}" name="active" type="checkbox"${policy.state === "active" ? " checked" : ""}><span>Client active</span></label>
    <div class="form-actions"><button type="submit">Save policy</button></div>
  </form>
  <form method="post" action="/clients/${actionId}/revoke"><button class="button--secondary" type="submit">Revoke AgentMail access</button></form>`;
  return `<article class="review-section">
  <h2>${escapeHtmlText(policy.label)}</h2>
  <dl class="message-details">
    <dt>Client ID</dt><dd><bdi dir="ltr">${id}</bdi></dd>
    <dt>Status</dt><dd>${escapeHtmlText(policy.state)}</dd>
  </dl>
  ${controls}
</article>`;
}

function renderPolicyFields(clientId: string, policy: McpOAuthPolicy["policy"]): string {
  const actionId = encodeURIComponent(clientId);
  const mailboxIds = policy.mailboxIds === "all" ? "all" : policy.mailboxIds.join(", ");
  const recipients =
    policy.recipientAllowlist === "any" ? "any" : policy.recipientAllowlist.join(", ");
  const preapproved =
    policy.sendMode.kind === "requireApproval"
      ? policy.sendMode.preapprovedRecipients.join(", ")
      : "";
  return `<div class="field"><label class="field__label" for="mailboxIds-${actionId}">Mailbox IDs</label><input id="mailboxIds-${actionId}" name="mailboxIds" type="text" value="${escapeHtmlText(mailboxIds)}" required><p class="field__hint" id="mailboxIds-hint-${actionId}">Comma-separated mailbox IDs for ${escapeHtmlText(clientId)}, or all.</p></div>
<label class="checkbox-field"><input id="canRead-${actionId}" name="canRead" type="checkbox"${policy.canRead ? " checked" : ""}><span>Allow reading mail</span></label>
<label class="checkbox-field"><input id="canDelete-${actionId}" name="canDelete" type="checkbox"${policy.canDelete ? " checked" : ""}><span>Allow deleting mail</span></label>
<div class="field"><label class="field__label" for="sendMode-${actionId}">Send mode</label><select id="sendMode-${actionId}" name="sendMode">
  <option value="deny"${policy.sendMode.kind === "deny" ? " selected" : ""}>Deny</option>
  <option value="requireApproval"${policy.sendMode.kind === "requireApproval" ? " selected" : ""}>Require approval</option>
  <option value="allow"${policy.sendMode.kind === "allow" ? " selected" : ""}>Allow</option>
</select></div>
<div class="field"><label class="field__label" for="preapprovedRecipients-${actionId}">Send without approval to</label><input id="preapprovedRecipients-${actionId}" name="preapprovedRecipients" type="text" value="${escapeHtmlText(preapproved)}" placeholder="Leave empty to approve every message" aria-describedby="preapproved-hint-${actionId}"><p class="field__hint" id="preapproved-hint-${actionId}">Comma-separated addresses for ${escapeHtmlText(clientId)}. Only applies to “Require approval”: a message reaches approval unless every one of its recipients is listed here.</p></div>
<div class="field"><label class="field__label" for="recipientAllowlist-${actionId}">Recipient allowlist</label><input id="recipientAllowlist-${actionId}" name="recipientAllowlist" type="text" value="${escapeHtmlText(recipients)}" required></div>
<label class="checkbox-field"><input id="canAdmin-${actionId}" name="canAdmin" type="checkbox"${policy.canAdmin ? " checked" : ""}><span>Allow mailbox administration</span></label>`;
}
