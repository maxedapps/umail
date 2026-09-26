import { OFFLINE_ACCESS_SCOPE, UMAIL_OAUTH_SCOPE } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import { htmlResponse, type PageView } from "../document.ts";
import { bidiAddress, bidiText, html } from "../html.ts";
import { failurePage } from "../session.ts";
import { noticePage } from "./notice.ts";

type DeviceDeps = Pick<ApiDeps, "auth" | "applicationUrl">;

const DeviceQuery = Schema.Struct({ user_code: Schema.optionalKey(Schema.String) });
const DeviceDecisionForm = Schema.Struct({ userCode: Schema.String });

export const deviceRoute = Effect.fn("deviceRoute")(function* (deps: DeviceDeps) {
  const query = yield* HttpServerRequest.schemaSearchParams(DeviceQuery).pipe(
    Effect.orElseSucceed(() => ({ user_code: undefined })),
  );
  const userCode = query.user_code;
  if (userCode === undefined || userCode.length === 0) {
    return yield* failurePage(400, "Enter the complete verification URL shown by the CLI.");
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  const verified = yield* pendingDeviceRequest(deps, webRequest.headers, userCode);
  if (typeof verified === "string") {
    return yield* failurePage(400, verified);
  }
  return yield* htmlResponse(
    200,
    deviceAuthorizationPage({
      userCode: verified.user_code,
      clientId: verified.client_id,
      scope: verified.scope ?? "",
      resource: deps.applicationUrl.origin,
    }),
  );
});

export const deviceDecisionRoute = Effect.fn("deviceDecisionRoute")(function* (
  deps: DeviceDeps,
  decision: "approved" | "denied",
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  const auth = yield* deps.auth.auth;
  const form = yield* HttpServerRequest.schemaBodyUrlParams(DeviceDecisionForm);
  const headers = webRequest.headers;
  const verified = yield* pendingDeviceRequest(deps, headers, form.userCode);
  if (typeof verified === "string") {
    return yield* failurePage(400, verified);
  }
  // Another tab may have decided between the check and this call.
  const decided = yield* Effect.tryPromise(() =>
    decision === "approved"
      ? auth.api.deviceApprove({ headers, body: { userCode: form.userCode } })
      : auth.api.deviceDeny({ headers, body: { userCode: form.userCode } }),
  ).pipe(Effect.option);
  if (Option.isNone(decided)) {
    return yield* failurePage(400, DEVICE_CODE_PROCESSED);
  }
  return yield* htmlResponse(200, deviceDecisionPage(decision));
});

const DEVICE_CODE_INVALID =
  "This device code is invalid or expired. Run `umail login` again for a new code.";
const DEVICE_CODE_PROCESSED = "This device code was already approved or denied.";
const DEVICE_ACCESS_UNSUPPORTED =
  "This device request asks for access AgentMail does not grant. Sign in with the AgentMail CLI.";

// The still-undecided device request behind a user code, or why it cannot be decided.
const pendingDeviceRequest = Effect.fn("pendingDeviceRequest")(function* (
  deps: DeviceDeps,
  headers: Headers,
  userCode: string,
) {
  const auth = yield* deps.auth.auth;
  const verified = yield* Effect.tryPromise(() =>
    auth.api.deviceVerify({ headers, query: { user_code: userCode } }),
  ).pipe(Effect.option);
  if (Option.isNone(verified)) return DEVICE_CODE_INVALID;
  if (!deviceRequestAdmitted(verified.value, deps.applicationUrl.origin)) {
    return DEVICE_ACCESS_UNSUPPORTED;
  }
  if (verified.value.status !== "pending") return DEVICE_CODE_PROCESSED;
  return verified.value;
});

// A device request must target the REST resource with the CLI's scopes, or it is refused.
function deviceRequestAdmitted(
  verified: { readonly resource?: string | string[] | undefined; readonly scope?: string | null },
  expected: string,
): boolean {
  const resource = verified.resource;
  const values = Array.isArray(resource) ? resource : resource === undefined ? [] : [resource];
  const scopes = new Set((verified.scope ?? "").split(" ").filter((value) => value.length > 0));
  return (
    values.length === 1 &&
    values[0] === expected &&
    scopes.has(UMAIL_OAUTH_SCOPE) &&
    scopes.has(OFFLINE_ACCESS_SCOPE)
  );
}

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
    main: html`<p class="code">${bidiAddress(view.userCode)}</p>
      <dl class="meta">
        <dt>Client</dt>
        <dd>${bidiAddress(view.clientId)}</dd>
        <dt>Scope</dt>
        <dd>${bidiText(view.scope)}</dd>
        <dt>Resource</dt>
        <dd>${bidiAddress(view.resource)}</dd>
      </dl>
      <form class="actions" method="post">
        <input type="hidden" name="userCode" value="${view.userCode}" />
        <button class="button" type="submit" formaction="/device/approve">
          Approve CLI access
        </button>
        <button class="button secondary" type="submit" formaction="/device/deny">
          Deny request
        </button>
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
