import type { PrincipalPolicy } from "@umail/api-contract";

import type { ClientGrant } from "../../auth/access.ts";
import type { PageView } from "../document.ts";
import { bidiAddress, html, type Html } from "../html.ts";

export function clientsPage(grants: ReadonlyArray<ClientGrant>): PageView {
  return {
    kind: "form",
    title: "Client access",
    heading: "Manage client access",
    lede: "Every client that can use AgentMail. Policy changes apply to the next request. Revoking ends the client's tokens; it can ask again through the consent screen.",
    main: html`<section class="section">
      <h2>Authorized clients</h2>
      ${grants.length === 0 ? html`<p class="empty">No client has access.</p>` : grants.map(grantHtml)}
    </section>`,
  };
}

function grantHtml(grant: ClientGrant): Html {
  const access =
    grant.consentId === null
      ? "Operator (CLI)"
      : grant.policy === null
        ? "No access until a policy is saved"
        : "MCP";
  return html`<article class="section">
    <h2>${grant.name ?? grant.clientId}</h2>
    <dl class="meta">
      <dt>Client ID</dt>
      <dd>${bidiAddress(grant.clientId)}</dd>
      <dt>Access</dt>
      <dd>${access}</dd>
    </dl>
    ${
      grant.consentId === null
        ? null
        : html`<form
            class="stack"
            method="post"
            action="/clients/${encodeURIComponent(grant.consentId)}/policy"
          >
            ${policyFields(grant.clientId, grant.policy)}
            <div class="actions"><button type="submit">Save policy</button></div>
          </form>`
    }
    <form method="post" action="/clients/${encodeURIComponent(grant.clientId)}/revoke">
      <button class="secondary" type="submit">Revoke access</button>
    </form>
  </article>`;
}

// A consent without a policy starts from the consent screen's defaults.
function policyFields(clientId: string, policy: PrincipalPolicy | null): Html {
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
  const option = (value: string, label: string) =>
    html`<option value="${value}" ${sendMode === value ? html` selected` : null}>${label}</option>`;
  return html`<div class="field">
      <label for="mailboxes-${id}">Mailbox IDs</label
      ><input id="mailboxes-${id}" name="mailboxes" type="text" value="${mailboxIds}" required />
      <p class="hint">Comma-separated mailbox IDs, or all.</p>
    </div>
    <label class="choice"
      ><input
        id="canRead-${id}"
        name="canRead"
        type="checkbox"
        ${policy?.canRead === false ? null : html` checked`}
      /><span>Allow reading mail</span></label
    >
    <div class="field">
      <label for="sendMode-${id}">Send mode</label
      ><select id="sendMode-${id}" name="sendMode">
        ${option("deny", "Deny")}${option("requireApproval", "Require approval")}${option("allow", "Allow")}
      </select>
    </div>
    <div class="field">
      <label for="preapproved-${id}">Send without approval to</label
      ><input
        id="preapproved-${id}"
        name="preapproved"
        type="text"
        value="${preapproved}"
        placeholder="Leave empty to approve every message"
      />
      <p class="hint">Comma-separated addresses. Only applies to “Require approval”.</p>
    </div>
    <div class="field">
      <label for="recipients-${id}">Recipient allowlist</label
      ><input id="recipients-${id}" name="recipients" type="text" value="${recipients}" required />
    </div>`;
}
