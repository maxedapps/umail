import {
  PrincipalPolicy,
  requireApprovalSendMode,
  type PrincipalSendMode,
  parsePrincipalRecipientAllowlist,
  parsePrincipalMailboxIds,
  parseMailAddressList,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { productPageTitle } from "../api/brand/identity.ts";
import { renderHumanPageNotice } from "../api/human-pages/notices.ts";
import {
  renderDeviceAuthorizationPage,
  renderDeviceDecisionPage,
  renderMcpClientsPage,
} from "../api/human-pages/oauth-management.ts";
import { humanPageHeaders } from "../api/human-pages/response.ts";
import type { ApiAccountStore } from "../account/worker.ts";
import { OFFLINE_ACCESS_SCOPE, UMAIL_OAUTH_SCOPE, type UmailBetterAuth } from "./options.ts";
import { cookieMutationAllowed } from "./runtime-surface.ts";

const PolicyForm = Schema.Struct({
  label: Schema.String,
  mailboxIds: Schema.String,
  canRead: Schema.optionalKey(Schema.String),
  canDelete: Schema.optionalKey(Schema.String),
  sendMode: Schema.Literals(["deny", "allow", "requireApproval"]),
  recipientAllowlist: Schema.String,
  preapprovedRecipients: Schema.optionalKey(Schema.String),
  canAdmin: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.String),
});
const DeviceDecisionForm = Schema.Struct({ userCode: Schema.String });

export type OAuthRouteDependencies = {
  readonly auth: UmailBetterAuth;
  readonly account: ApiAccountStore;
  readonly applicationUrl: URL;
  readonly operatorId: string;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

export function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === "/device" ||
    pathname === "/device/approve" ||
    pathname === "/device/deny" ||
    pathname === "/clients" ||
    pathname.startsWith("/clients/")
  );
}

export async function serveOAuthRoute(
  deps: OAuthRouteDependencies,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/device" && request.method === "GET") {
    return deviceRoute(deps, request);
  }
  if (url.pathname === "/device/approve" && request.method === "POST") {
    const originError = cookieMutationOriginError(deps, request);
    if (originError !== null) return originError;
    return deviceDecisionRoute(deps, request, "approved");
  }
  if (url.pathname === "/device/deny" && request.method === "POST") {
    const originError = cookieMutationOriginError(deps, request);
    if (originError !== null) return originError;
    return deviceDecisionRoute(deps, request, "denied");
  }
  if (url.pathname === "/clients" && request.method === "GET") {
    return clientsRoute(deps, request);
  }
  const policyMatch = /^\/clients\/([^/]+)\/policy$/.exec(url.pathname);
  if (policyMatch !== null && request.method === "POST") {
    const originError = cookieMutationOriginError(deps, request);
    if (originError !== null) return originError;
    return updateClientPolicyRoute(deps, request, decodeURIComponent(policyMatch[1] ?? ""));
  }
  const revokeMatch = /^\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeMatch !== null && request.method === "POST") {
    const originError = cookieMutationOriginError(deps, request);
    if (originError !== null) return originError;
    return revokeClientRoute(deps, request, decodeURIComponent(revokeMatch[1] ?? ""));
  }
  return new Response(null, { status: 405 });
}

async function deviceRoute(deps: OAuthRouteDependencies, request: Request): Promise<Response> {
  const session = await requireOperatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  const userCode = new URL(request.url).searchParams.get("user_code");
  if (userCode === null || userCode.length === 0) {
    return humanError("Enter the complete verification URL shown by the CLI.", 400);
  }
  try {
    const verified = await deps.auth.api.deviceVerify({
      headers: request.headers,
      query: { user_code: userCode },
    });
    const resource = verifiedDeviceResource(verified.resource, deps.applicationUrl.origin);
    assertDeviceScopes(verified.scope ?? "");
    return humanResponse(
      renderDeviceAuthorizationPage({
        userCode: verified.user_code,
        clientId: verified.client_id,
        scope: verified.scope ?? "",
        resource,
      }),
    );
  } catch {
    return humanError("This device code is invalid, expired, or requests unsupported access.", 400);
  }
}

async function deviceDecisionRoute(
  deps: OAuthRouteDependencies,
  request: Request,
  decision: "approved" | "denied",
): Promise<Response> {
  const session = await requireOperatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  try {
    const form = await Schema.decodeUnknownPromise(DeviceDecisionForm)(
      Object.fromEntries(await request.formData()),
    );
    const verified = await deps.auth.api.deviceVerify({
      headers: request.headers,
      query: { user_code: form.userCode },
    });
    verifiedDeviceResource(verified.resource, deps.applicationUrl.origin);
    assertDeviceScopes(verified.scope ?? "");
    if (decision === "approved") {
      await deps.auth.api.deviceApprove({
        headers: request.headers,
        body: { userCode: form.userCode },
      });
    } else {
      await deps.auth.api.deviceDeny({
        headers: request.headers,
        body: { userCode: form.userCode },
      });
    }
    return humanResponse(renderDeviceDecisionPage(decision));
  } catch {
    return humanError("This device code is invalid, expired, or already processed.", 400);
  }
}

async function clientsRoute(deps: OAuthRouteDependencies, request: Request): Promise<Response> {
  const session = await requireOperatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  const policies = await deps.run(deps.account.listMcpOAuthPolicies());
  return humanResponse(renderMcpClientsPage(policies));
}

async function updateClientPolicyRoute(
  deps: OAuthRouteDependencies,
  request: Request,
  clientId: string,
): Promise<Response> {
  const session = await requireOperatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  try {
    const existing = await deps.run(deps.account.getMcpOAuthPolicy(clientId));
    if (existing === null) return humanError("MCP client policy not found.", 404);
    if (existing.state === "revoked") return humanError("Revoked access cannot be restored.", 403);
    const form = await Schema.decodeUnknownPromise(PolicyForm)(
      Object.fromEntries(await request.formData()),
    );
    const now = new Date().toISOString();
    await deps.run(
      deps.account.updateMcpOAuthPolicy({
        clientId,
        label: form.label.trim(),
        policy: policyFromForm(form),
        updatedAt: now,
      }),
    );
    await deps.run(
      deps.account.setMcpOAuthPolicyState({
        clientId,
        state: form.active === undefined ? "disabled" : "active",
        updatedAt: now,
      }),
    );
    return redirectResponse("/clients?updated=1");
  } catch {
    return humanError("Could not update that MCP client policy.", 400);
  }
}

async function revokeClientRoute(
  deps: OAuthRouteDependencies,
  request: Request,
  clientId: string,
): Promise<Response> {
  const session = await requireOperatorSession(deps, request);
  if (session.kind !== "authorized") return session.response;
  const policy = await deps.run(
    deps.account.revokeMcpOAuthPolicy(clientId, new Date().toISOString()),
  );
  if (policy === null) return humanError("MCP client policy not found.", 404);
  return redirectResponse("/clients?revoked=1");
}

async function requireOperatorSession(deps: OAuthRouteDependencies, request: Request) {
  const session = await deps.auth.api.getSession({ headers: request.headers });
  if (session === null) {
    return { kind: "redirect", response: loginRedirect(request) } as const;
  }
  if (session.user.id !== deps.operatorId) {
    return { kind: "forbidden", response: humanError("Forbidden.", 403) } as const;
  }
  return { kind: "authorized" } as const;
}

function cookieMutationOriginError(
  deps: OAuthRouteDependencies,
  request: Request,
): Response | null {
  if (cookieMutationAllowed(request, deps.applicationUrl.origin)) {
    return null;
  }
  return humanError("Forbidden.", 403);
}

function verifiedDeviceResource(resource: string | string[] | undefined, expected: string): string {
  const values = Array.isArray(resource) ? resource : resource === undefined ? [] : [resource];
  if (values.length !== 1 || values[0] !== expected) {
    throw new Error("Device request targets the wrong resource.");
  }
  return expected;
}

function assertDeviceScopes(scope: string): void {
  const scopes = new Set(scope.split(" ").filter((value) => value.length > 0));
  if (!scopes.has(UMAIL_OAUTH_SCOPE) || !scopes.has(OFFLINE_ACCESS_SCOPE)) {
    throw new Error("Device request has unsupported scopes.");
  }
}

function policyFromForm(form: typeof PolicyForm.Type) {
  const label = form.label.trim();
  if (label.length === 0) throw new Error("Client label is required.");
  const mailboxIds = parsePrincipalMailboxIds(form.mailboxIds);
  if (mailboxIds.kind !== "ok") throw new Error("At least one mailbox ID is required.");
  const recipientAllowlist = parsePrincipalRecipientAllowlist(form.recipientAllowlist);
  if (recipientAllowlist.kind === "invalid_address") {
    throw new Error("Recipient allowlist contains an invalid address.");
  }
  if (recipientAllowlist.kind !== "ok") throw new Error("At least one recipient is required.");
  return Schema.decodeUnknownSync(PrincipalPolicy)({
    mailboxIds: mailboxIds.mailboxIds,
    canRead: form.canRead !== undefined,
    canDelete: form.canDelete !== undefined,
    sendMode: parseSendMode(form.sendMode, form.preapprovedRecipients),
    recipientAllowlist: recipientAllowlist.recipientAllowlist,
    canAdmin: form.canAdmin !== undefined,
  });
}

function parseSendMode(
  kind: "deny" | "allow" | "requireApproval",
  preapprovedRecipients: string | undefined,
): PrincipalSendMode {
  if (kind !== "requireApproval") return { kind };
  const parsed = parseMailAddressList(preapprovedRecipients ?? "");
  if (parsed.kind !== "ok") throw new Error("Recipient list contains an invalid address.");
  return requireApprovalSendMode(parsed.addresses);
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return redirectResponse(`/login?next=${encodeURIComponent(next)}`);
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function humanResponse(page: ReturnType<typeof renderMcpClientsPage>): Response {
  return new Response(page.html, { status: page.status, headers: humanPageHeaders(page) });
}

function humanError(message: string, status: 400 | 403 | 404): Response {
  const page = renderHumanPageNotice({
    status,
    title: productPageTitle("OAuth request failed"),
    eyebrow: "OAuth",
    heading: "The request could not be completed",
    description: "AgentMail stopped before granting or changing access.",
    message,
    tone: "error",
  });
  return new Response(page.html, { status, headers: humanPageHeaders(page) });
}
