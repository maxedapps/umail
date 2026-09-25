import type { PageView } from "../document.ts";
import { bidiAddress, bidiText, html } from "../html.ts";
import { noticePage } from "./notice.ts";

type DeviceAuthorizationView = {
  readonly userCode: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
};

export function deviceAuthorizationPage(view: DeviceAuthorizationView): PageView {
  return {
    kind: "form",
    title: "Approve device",
    heading: "Approve the CLI sign-in",
    lede: "Approve only when this code exactly matches the code shown by the AgentMail CLI.",
    main: html`<dl class="meta">
        <dt>Code</dt>
        <dd><strong>${bidiAddress(view.userCode)}</strong></dd>
        <dt>Client</dt>
        <dd>${bidiAddress(view.clientId)}</dd>
        <dt>Scope</dt>
        <dd>${bidiText(view.scope)}</dd>
        <dt>Resource</dt>
        <dd>${bidiAddress(view.resource)}</dd>
      </dl>
      <form class="actions" method="post">
        <input type="hidden" name="userCode" value="${view.userCode}" />
        <button type="submit" formaction="/device/approve">Approve CLI access</button>
        <button type="submit" class="secondary" formaction="/device/deny">Deny request</button>
      </form>`,
  };
}

export function deviceDecisionPage(decision: "approved" | "denied"): PageView {
  return noticePage({
    title: `Device ${decision}`,
    heading: decision === "approved" ? "CLI access approved" : "CLI access denied",
    message:
      decision === "approved"
        ? "Return to the terminal to finish signing in. You may close this tab."
        : "The CLI request was denied. You may close this tab.",
    tone: "ordinary",
  });
}
