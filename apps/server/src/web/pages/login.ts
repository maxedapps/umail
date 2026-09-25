import type { PageView } from "../document.ts";
import { html } from "../html.ts";

// Shared by the login and consent scripts: the signed OAuth continuation, the allowed return
// paths, and Better Auth's redirect answer.
export const AUTH_CONTINUATION_SCRIPT = `
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
    const allowed = ["/device", "/clients", "/mail", "/mailboxes"].some(
      (path) => parsed.pathname === path || parsed.pathname.startsWith(path + "/"),
    );
    if (!allowed) {
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

function showStatus(message, kind) {
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}
`;

const LOGIN_PAGE_SCRIPT = `
const form = document.getElementById("login-form");
const emailField = document.getElementById("email");
const secretField = document.getElementById("secret");
const submitButton = document.getElementById("login-submit");
const status = document.getElementById("status");
${AUTH_CONTINUATION_SCRIPT}

function setPending(pending) {
  form.setAttribute("aria-busy", pending ? "true" : "false");
  submitButton.disabled = pending;
  submitButton.textContent = pending ? "Signing in…" : "Sign in";
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
      showStatus("Could not sign in. Check your email and password.", "error");
      return;
    }
    const payload = await signIn.json();
    const redirectUrl = browserRedirectUrl(payload);
    if (redirectUrl !== null) {
      location.assign(redirectUrl);
      return;
    }
    const next = sameOriginReturnPath(new URLSearchParams(location.search).get("next"));
    location.assign(next ?? "/mail");
  } catch {
    showStatus("Could not sign in. Try again.", "error");
  } finally {
    setPending(false);
  }
});
`;

export function loginPage(): PageView {
  return {
    kind: "auth",
    title: "Sign in",
    heading: "Sign in to AgentMail",
    main: html`<form
      class="stack"
      id="login-form"
      method="post"
      action="/api/auth/sign-in/email"
      aria-busy="false"
    >
      <div class="field">
        <label for="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          inputmode="email"
          autocomplete="username"
          required
        />
      </div>
      <div class="field">
        <label for="secret">Password</label>
        <input
          id="secret"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>
      <button class="button" id="login-submit" type="submit">Sign in</button>
      <p id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></p>
    </form>`,
    script: LOGIN_PAGE_SCRIPT,
  };
}
