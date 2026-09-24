import { productPageTitle } from "../brand/identity.ts";
import { renderHumanPageInternal } from "./internal/page.ts";
import { humanPageHttpResponse } from "./response.ts";

const AUTH_CONTINUATION_SCRIPT = `
function signedOAuthQuery(search) {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) {
    return null;
  }
  const signedNames = params.getAll("ba_param");
  if (signedNames.length === 0) {
    return null;
  }
  const allowed = Object.create(null);
  for (const name of signedNames) {
    allowed[name] = true;
  }
  const signed = new URLSearchParams();
  for (const entry of params.entries()) {
    const key = entry[0];
    if (key === "sig" || key === "ba_param" || allowed[key] === true) {
      signed.append(key, entry[1]);
    }
  }
  return signed.toString();
}

function sameOriginReturnPath(next) {
  if (next === null || next.length === 0) {
    return null;
  }
  if (!next.startsWith("/") || next.startsWith("//")) {
    return null;
  }
  if (next.includes("\\\\") || next.includes("://") || /\\s/.test(next)) {
    return null;
  }
  try {
    const parsed = new URL(next, location.origin);
    if (parsed.origin !== location.origin) {
      return null;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return null;
    }
    if (parsed.hash.length > 0) {
      return null;
    }
    const returned = parsed.pathname + parsed.search;
    if (returned !== next) {
      return null;
    }
    if (parsed.pathname !== "/clients" && parsed.pathname !== "/device") {
      return null;
    }
    return returned;
  } catch {
    return null;
  }
}

function browserRedirectUrl(payload) {
  if (payload === null || payload.redirect !== true) {
    return null;
  }
  if (Object.prototype.toString.call(payload.url) !== "[object String]") {
    return null;
  }
  try {
    return new URL(payload.url, location.href);
  } catch {
    return null;
  }
}
`;

const LOGIN_PAGE_SCRIPT = `
const form = document.getElementById("login-form");
const emailField = document.getElementById("email");
const secretField = document.getElementById("secret");
const submitButton = document.getElementById("login-submit");
const status = document.getElementById("status");
${AUTH_CONTINUATION_SCRIPT}

function showStatus(message, kind) {
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}

function setPending(pending) {
  form.setAttribute("aria-busy", pending ? "true" : "false");
  submitButton.disabled = pending;
  submitButton.textContent = pending ? "Working…" : "Continue";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailField.value;
  const password = secretField.value;
  const oauthQuery = signedOAuthQuery(location.search);
  setPending(true);
  showStatus("Signing in…", "pending");
  try {
    const signInBody = { email, password };
    if (oauthQuery !== null) {
      signInBody.oauth_query = oauthQuery;
    }
    const signIn = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(signInBody),
    });
    if (!signIn.ok) {
      showStatus("Could not sign in. Check the operator email and secret.", "error");
      return;
    }
    const payload = await signIn.json();
    const redirectUrl = browserRedirectUrl(payload);
    if (redirectUrl !== null) {
      location.assign(redirectUrl);
      return;
    }
    const next = sameOriginReturnPath(new URLSearchParams(location.search).get("next"));
    if (next !== null) {
      location.assign(next);
      return;
    }
    secretField.value = "";
    showStatus("Signed in. Continue to the authorization request or use umail login.", "success");
  } catch {
    showStatus("Could not sign in. Try again.", "error");
  } finally {
    setPending(false);
  }
});
`;

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

function showStatus(message, kind) {
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}

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

export function loginPageResponse() {
  const page = renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle("Operator sign in"),
      eyebrow: "Mailbox access",
      heading: "Open the mail ledger",
      description:
        "Sign in as the provisioned operator. OAuth consent and device approval use the same protected Better Auth flow.",
      mainHtml: `<form class="auth-form" id="login-form" method="post" action="/api/auth/sign-in/email" aria-describedby="login-guidance" aria-busy="false">
  <div class="field">
    <label class="field__label" for="email">Operator email</label>
    <input id="email" name="email" type="email" inputmode="email" autocomplete="username" required>
  </div>
  <div class="field">
    <label class="field__label" for="secret">Operator secret</label>
    <input id="secret" name="password" type="password" autocomplete="current-password" required>
  </div>
  <p id="login-guidance" class="field__help">Credentials are sent only to AgentMail’s first-party authentication endpoint.</p>
  <div class="form-actions">
    <button id="login-submit" type="submit">Continue</button>
  </div>
  <p id="status" class="status-message" role="status" aria-live="polite" aria-atomic="true"></p>
</form>`,
      script: LOGIN_PAGE_SCRIPT,
    },
  });
  return humanPageHttpResponse(page);
}

export function consentPageResponse() {
  const page = renderHumanPageInternal({
    status: 200,
    policy: "auth",
    document: {
      title: productPageTitle("Authorize mailbox access"),
      eyebrow: "OAuth consent",
      heading: "Review this access request",
      description:
        "A client is asking to use your mailbox through AgentMail. Confirm the client, then choose what it may do. You can change this later on the clients page.",
      mainHtml: `<form id="consent-form" aria-busy="false">
  <dl class="consent-details">
    <dt>Client</dt>
    <dd><bdi id="client-id" dir="auto"></bdi></dd>
    <dt>Scope</dt>
    <dd><bdi id="scope" dir="auto"></bdi></dd>
    <dt>Redirects to</dt>
    <dd><bdi id="redirect-host" dir="auto"></bdi></dd>
  </dl>
  <div class="field">
    <label class="field__label" for="mailboxes">Mailboxes</label>
    <input id="mailboxes" name="mailboxes" type="text" value="all" required aria-describedby="mailboxes-hint">
    <p class="field__hint" id="mailboxes-hint">all, or comma-separated mailbox IDs.</p>
  </div>
  <div class="field">
    <label class="field__label" for="send-mode">Sending</label>
    <select id="send-mode" name="sendMode">
      <option value="requireApproval" selected>Every send needs my approval</option>
      <option value="allow">Send without approval</option>
      <option value="deny">No sending</option>
    </select>
  </div>
  <div class="form-actions">
    <button id="accept" type="button">Allow access</button>
    <button class="button--secondary" id="deny" type="button">Deny request</button>
  </div>
  <p id="status" class="status-message" role="status" aria-live="polite" aria-atomic="true"></p>
</form>`,
      script: CONSENT_PAGE_SCRIPT,
    },
  });
  return humanPageHttpResponse(page);
}
