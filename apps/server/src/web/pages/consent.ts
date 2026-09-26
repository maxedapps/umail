import { OFFLINE_ACCESS_SCOPE, UMAIL_OAUTH_SCOPE, type Address } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import { listAddresses } from "../../api/operations.ts";
import { htmlResponse, type PageView } from "../document.ts";
import { bidiAddress, bidiText, displayText, html } from "../html.ts";
import { accessFieldsets, policyFormState } from "./clients.ts";
import { AUTH_CONTINUATION_SCRIPT } from "./login.ts";

// Builds the policy fields from the form and posts the decision with Better Auth's signed query.
const CONSENT_PAGE_SCRIPT = `
const consentForm = document.getElementById("consent-form");
const acceptButton = document.getElementById("accept");
const denyButton = document.getElementById("deny");
const status = document.getElementById("status");
${AUTH_CONTINUATION_SCRIPT}

function setPending(pending) {
  consentForm.setAttribute("aria-busy", pending ? "true" : "false");
  acceptButton.disabled = pending;
  denyButton.disabled = pending;
}

// Better Auth's core routes answer { message }, its OAuth routes { error, error_description }.
function consentFailure(status, payload) {
  const message =
    payload === null
      ? null
      : typeof payload.message === "string"
        ? payload.message
        : typeof payload.error_description === "string"
          ? payload.error_description
          : null;
  if (message === null) {
    return "Could not record your decision (HTTP " + status + "). Try again.";
  }
  if (/missing oauth query/i.test(message)) {
    return "This consent request expired or is incomplete. Start the connection again from the client.";
  }
  return message;
}

async function consent(accept) {
  setPending(true);
  showStatus("Recording your decision…", "pending");
  try {
    const body = { accept };
    const oauthQuery = signedOAuthQuery(location.search);
    if (oauthQuery !== null) {
      body.oauth_query = oauthQuery;
    }
    if (accept) {
      const data = new FormData(consentForm);
      body.mailboxes = data.get("mailboxScope") === "some" ? data.getAll("mailbox").join(",") : "all";
      body.sendMode = data.get("sendMode");
      body.preapproved = data.get("preapproved") ?? "";
    }
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      showStatus(consentFailure(response.status, payload), "error");
      return;
    }
    const redirectUrl = browserRedirectUrl(payload);
    if (redirectUrl !== null) {
      location.assign(redirectUrl);
      return;
    }
    showStatus("Consent recorded.", "success");
  } catch {
    showStatus("Could not reach AgentMail. Check your connection and try again.", "error");
  } finally {
    setPending(false);
  }
}

acceptButton.addEventListener("click", () => consent(true));
denyButton.addEventListener("click", () => consent(false));
`;

function scopeInWords(scope: string): string {
  switch (scope) {
    case UMAIL_OAUTH_SCOPE:
      return "Use your mailboxes";
    case OFFLINE_ACCESS_SCOPE:
      return "stay signed in";
    default:
      return scope;
  }
}

type ConsentView = {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly scope: string;
  readonly redirectUri: string | null;
};

export function consentPage(view: ConsentView, addresses: ReadonlyArray<Address>): PageView {
  const scopes = view.scope
    .split(" ")
    .filter((scope) => scope.length > 0)
    .map(scopeInWords);
  const redirect = view.redirectUri === null ? null : URL.parse(view.redirectUri);
  return {
    kind: "auth",
    title: "Authorize mailbox access",
    heading: `Allow ${view.clientName === null ? "this client" : displayText(view.clientName)} to use AgentMail?`,
    lede: "Choose what it may do. You can change this later under Clients.",
    main: html`<form class="stack" id="consent-form" aria-busy="false">
      <dl class="meta">
        <dt>Client</dt>
        <dd>
          ${view.clientName === null ? null : html`${bidiText(view.clientName)}<br />`}
          <span class="mono muted">${bidiAddress(view.clientId)}</span>
        </dd>
        <dt>Access</dt>
        <dd>${scopes.length === 0 ? "Not stated" : scopes.join(" · ")}</dd>
        <dt>Returns to</dt>
        <dd>
          ${redirect === null ? "Not stated" : bidiAddress(`${redirect.protocol}//${redirect.host}`)}
        </dd>
      </dl>
      <div class="settings">${accessFieldsets(policyFormState(null), addresses, null)}</div>
      <div class="actions">
        <button class="button" id="accept" type="button">Allow access</button>
        <button class="button secondary" id="deny" type="button">Deny</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></p>
    </form>`,
    script: CONSENT_PAGE_SCRIPT,
  };
}

const ConsentQuery = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
});

export const consentRoute = Effect.fn("consentRoute")(function* (deps: ApiDeps) {
  const query = yield* HttpServerRequest.schemaSearchParams(ConsentQuery);
  const clientId = query.client_id ?? "";
  const view = {
    clientId,
    clientName: clientId.length === 0 ? null : yield* deps.access.clientName(clientId),
    scope: query.scope ?? "",
    redirectUri: query.redirect_uri ?? null,
  };
  return yield* htmlResponse(200, consentPage(view, yield* listAddresses(deps)));
});
