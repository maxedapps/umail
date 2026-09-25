import type { PrincipalPolicy } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import { policyFromForm, type ClientGrant } from "../../auth/access.ts";
import { htmlResponse, redirect, type PageView } from "../document.ts";
import { failurePage } from "../session.ts";
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

type ClientsDeps = Pick<ApiDeps, "access">;

const ClientParams = Schema.Struct({ clientId: Schema.String });
const ConsentParams = Schema.Struct({ consentId: Schema.String });
const PolicyForm = Schema.Struct({
  mailboxes: Schema.optionalKey(Schema.String),
  sendMode: Schema.optionalKey(Schema.String),
  canRead: Schema.optionalKey(Schema.String),
  recipients: Schema.optionalKey(Schema.String),
  preapproved: Schema.optionalKey(Schema.String),
});

export const clientsRoute = Effect.fn("clientsRoute")(function* (deps: ClientsDeps) {
  return yield* htmlResponse(200, clientsPage(yield* deps.access.list()));
});

export const updateClientPolicyRoute = Effect.fn("updateClientPolicyRoute")(function* (
  deps: ClientsDeps,
) {
  const { consentId } = yield* HttpRouter.schemaPathParams(ConsentParams);
  const form = yield* HttpServerRequest.schemaBodyUrlParams(PolicyForm);
  const policy = policyFromForm({ ...form, canRead: form.canRead !== undefined });
  if (policy === null) return yield* failurePage(400, "Could not read that policy.");
  const updated = yield* deps.access.setPolicy(consentId, policy);
  if (!updated) return yield* failurePage(404, "That client has no consent to update.");
  return redirect("/clients?updated=1");
});

export const revokeClientRoute = Effect.fn("revokeClientRoute")(function* (deps: ClientsDeps) {
  const { clientId } = yield* HttpRouter.schemaPathParams(ClientParams);
  yield* deps.access.revoke(clientId);
  return redirect("/clients?revoked=1");
});
