import type { PageView } from "../document.ts";
import { html } from "../html.ts";
import { AUTH_CONTINUATION_SCRIPT } from "./login.ts";

const CONSENT_PAGE_SCRIPT = `
const oauthQuery = signedOAuthQuery(location.search);
const params = new URLSearchParams(oauthQuery ?? "");
document.getElementById("client-id").textContent = params.get("client_id") ?? "Not supplied";
document.getElementById("scope").textContent = params.get("scope") ?? "Not supplied";
document.getElementById("redirect-host").textContent = redirectHost(params.get("redirect_uri"));
const consentForm = document.getElementById("consent-form");
const mailboxesField = document.getElementById("mailboxes");
const sendModeField = document.getElementById("send-mode");
const acceptButton = document.getElementById("accept");
const denyButton = document.getElementById("deny");
const status = document.getElementById("status");
${AUTH_CONTINUATION_SCRIPT}

function redirectHost(redirectUri) {
  if (redirectUri === null) {
    return "Not supplied";
  }
  try {
    const url = new URL(redirectUri);
    return url.protocol + "//" + url.host;
  } catch {
    return redirectUri;
  }
}

function setPending(pending) {
  consentForm.setAttribute("aria-busy", pending ? "true" : "false");
  acceptButton.disabled = pending;
  denyButton.disabled = pending;
}

async function consent(accept) {
  setPending(true);
  showStatus("Recording your decision…", "pending");
  try {
    const body = { accept };
    if (oauthQuery !== null) {
      body.oauth_query = oauthQuery;
    }
    if (accept) {
      body.mailboxes = mailboxesField.value;
      body.sendMode = sendModeField.value;
    }
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      showStatus("Could not complete consent.", "error");
      return;
    }
    const payload = await response.json();
    const redirectUrl = browserRedirectUrl(payload);
    if (redirectUrl !== null) {
      location.assign(redirectUrl);
      return;
    }
    showStatus("Consent recorded.", "success");
  } catch {
    showStatus("Could not complete consent. Try again.", "error");
  } finally {
    setPending(false);
  }
}

acceptButton.addEventListener("click", () => consent(true));
denyButton.addEventListener("click", () => consent(false));
`;

export function consentPage(): PageView {
  return {
    kind: "auth",
    title: "Authorize mailbox access",
    heading: "Review this access request",
    lede: "A client is asking to use your mailboxes through AgentMail. Choose what it may do. You can change this later under Clients.",
    main: html`<form class="stack" id="consent-form" aria-busy="false">
      <dl class="meta">
        <dt>Client</dt>
        <dd><bdi id="client-id" dir="auto"></bdi></dd>
        <dt>Scope</dt>
        <dd><bdi id="scope" dir="auto"></bdi></dd>
        <dt>Redirects to</dt>
        <dd><bdi id="redirect-host" dir="auto"></bdi></dd>
      </dl>
      <div class="field">
        <label for="mailboxes">Mailboxes</label>
        <input
          id="mailboxes"
          name="mailboxes"
          type="text"
          value="all"
          required
          aria-describedby="mailboxes-hint"
        />
        <p class="hint" id="mailboxes-hint">all, or comma-separated mailbox IDs.</p>
      </div>
      <div class="field">
        <label for="send-mode">Sending</label>
        <select id="send-mode" name="sendMode">
          <option value="requireApproval" selected>Every send needs my approval</option>
          <option value="allow">Send without approval</option>
          <option value="deny">No sending</option>
        </select>
      </div>
      <div class="actions">
        <button id="accept" type="button">Allow access</button>
        <button class="secondary" id="deny" type="button">Deny request</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></p>
    </form>`,
    script: CONSENT_PAGE_SCRIPT,
  };
}
