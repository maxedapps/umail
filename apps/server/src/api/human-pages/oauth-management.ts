import type { PrincipalPolicy } from "@umail/api-contract";

import type { ClientGrant } from "../../auth/access.ts";
import { productPageTitle } from "../brand/identity.ts";
import { escapeHtmlText, renderHumanPageInternal } from "./internal/page.ts";

type DeviceAuthorizationView = {
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

export function renderClientsPage(grants: ReadonlyArray<ClientGrant>) {
  const items = grants.map(renderGrant).join("");
  return renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle("Client access"),
      eyebrow: "Access",
      heading: "Manage client access",
      description:
        "Every client that can use AgentMail. Policy changes apply to the next request. Revoking ends the client's tokens; it can ask again through the consent screen.",
      mainHtml: `<section class="review-section"><h2>Authorized clients</h2>${items.length === 0 ? '<p class="empty-value">No client has access.</p>' : items}</section>`,
    },
  });
}

function renderGrant(grant: ClientGrant): string {
  const clientId = encodeURIComponent(grant.clientId);
  const access =
    grant.consentId === null
      ? "Operator (CLI)"
      : grant.policy === null
        ? "No access until a policy is saved"
        : "MCP";
  const policyForm =
    grant.consentId === null
      ? ""
      : `<form class="auth-form" method="post" action="/clients/${encodeURIComponent(grant.consentId)}/policy">
    ${renderPolicyFields(grant.clientId, grant.policy)}
    <div class="form-actions"><button type="submit">Save policy</button></div>
  </form>`;
  return `<article class="review-section">
  <h2>${escapeHtmlText(grant.name ?? grant.clientId)}</h2>
  <dl class="message-details">
    <dt>Client ID</dt><dd><bdi dir="ltr">${escapeHtmlText(grant.clientId)}</bdi></dd>
    <dt>Access</dt><dd>${escapeHtmlText(access)}</dd>
  </dl>
  ${policyForm}
  <form method="post" action="/clients/${clientId}/revoke"><button class="button--secondary" type="submit">Revoke access</button></form>
</article>`;
}

// A consent without a policy starts from the consent screen's defaults.
function renderPolicyFields(clientId: string, policy: PrincipalPolicy | null): string {
  const id = encodeURIComponent(clientId);
  const mailboxIds =
    policy === null || policy.mailboxIds === "all" ? "all" : policy.mailboxIds.join(", ");
  const recipients =
    policy === null || policy.recipientAllowlist === "any"
      ? "any"
      : policy.recipientAllowlist.join(", ");
  const sendMode = policy?.sendMode.kind ?? "requireApproval";
  const preapproved =
    policy?.sendMode.kind === "requireApproval"
      ? policy.sendMode.preapprovedRecipients.join(", ")
      : "";
  return `<div class="field"><label class="field__label" for="mailboxes-${id}">Mailbox IDs</label><input id="mailboxes-${id}" name="mailboxes" type="text" value="${escapeHtmlText(mailboxIds)}" required><p class="field__hint">Comma-separated mailbox IDs, or all.</p></div>
<label class="checkbox-field"><input id="canRead-${id}" name="canRead" type="checkbox"${policy?.canRead === false ? "" : " checked"}><span>Allow reading mail</span></label>
<div class="field"><label class="field__label" for="sendMode-${id}">Send mode</label><select id="sendMode-${id}" name="sendMode">
  <option value="deny"${sendMode === "deny" ? " selected" : ""}>Deny</option>
  <option value="requireApproval"${sendMode === "requireApproval" ? " selected" : ""}>Require approval</option>
  <option value="allow"${sendMode === "allow" ? " selected" : ""}>Allow</option>
</select></div>
<div class="field"><label class="field__label" for="preapproved-${id}">Send without approval to</label><input id="preapproved-${id}" name="preapproved" type="text" value="${escapeHtmlText(preapproved)}" placeholder="Leave empty to approve every message" aria-describedby="preapproved-hint-${id}"><p class="field__hint" id="preapproved-hint-${id}">Comma-separated addresses. Only applies to “Require approval”: a message reaches approval unless every one of its recipients is listed here.</p></div>
<div class="field"><label class="field__label" for="recipients-${id}">Recipient allowlist</label><input id="recipients-${id}" name="recipients" type="text" value="${escapeHtmlText(recipients)}" required></div>`;
}
