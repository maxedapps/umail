import type { Address, PrincipalPolicy } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import type { ApiDeps } from "../../api/app.ts";
import { listAddresses } from "../../api/operations.ts";
import { policyFromForm, type ClientGrant, type PolicyField } from "../../auth/access.ts";
import { htmlResponse, redirect, type Flash, type PageView } from "../document.ts";
import { bidiText, displayText, html, type Html } from "../html.ts";

// The policy controls as the form holds them, so a rejected save re-renders what was typed.
export type PolicyFormState = {
  readonly mailboxScope: "all" | "some";
  readonly mailboxIds: ReadonlyArray<string>;
  readonly canRead: boolean;
  readonly sendMode: "deny" | "requireApproval" | "allow";
  readonly preapproved: string;
  readonly recipientScope: "any" | "some";
  readonly recipients: string;
};

export type PolicyError = { readonly field: PolicyField; readonly message: string };

// A consent without a policy starts from the consent screen's defaults.
export function policyFormState(policy: PrincipalPolicy | null): PolicyFormState {
  return {
    mailboxScope: policy === null || policy.mailboxIds === "all" ? "all" : "some",
    mailboxIds: policy === null || policy.mailboxIds === "all" ? [] : policy.mailboxIds,
    canRead: policy?.canRead ?? true,
    sendMode: policy?.sendMode.kind ?? "requireApproval",
    preapproved:
      policy?.sendMode.kind === "requireApproval"
        ? policy.sendMode.preapprovedRecipients.join(", ")
        : "",
    recipientScope: policy === null || policy.recipientAllowlist === "any" ? "any" : "some",
    recipients:
      policy === null || policy.recipientAllowlist === "any"
        ? ""
        : policy.recipientAllowlist.join(", "),
  };
}

// The mailbox and sending controls, shared with the consent screen.
export function accessFieldsets(
  state: PolicyFormState,
  addresses: ReadonlyArray<Address>,
  error: PolicyError | null,
): Html {
  return html`${mailboxesFieldset(state, addresses, error)} ${sendingFieldset(state, error)}`;
}

function mailboxesFieldset(
  state: PolicyFormState,
  addresses: ReadonlyArray<Address>,
  error: PolicyError | null,
): Html {
  return html`<fieldset class="stack">
    <legend>Mailboxes</legend>
    <div class="choices">
      ${choice("mailboxScope", "all", state.mailboxScope, "All mailboxes", "Including ones you add later.")}
      ${choice("mailboxScope", "some", state.mailboxScope, "Only these", "Pick the mailboxes below.", true)}
    </div>
    <div class="revealed field">
      <div class="checks">
        ${addresses.map(
          (address) =>
            html`<label
              ><input
                type="checkbox"
                name="mailbox"
                value="${address.id}"
                ${state.mailboxIds.includes(address.id) ? html`checked` : null}
              />
              <span class="mono">${address.address}</span></label
            >`,
        )}
      </div>
      ${fieldError(error, "mailboxes")}
    </div>
  </fieldset>`;
}

function sendingFieldset(state: PolicyFormState, error: PolicyError | null): Html {
  return html`<fieldset class="stack">
    <legend>Sending</legend>
    <div class="choices">
      ${choice("sendMode", "deny", state.sendMode, "Never", "It cannot send mail.")}
      ${choice("sendMode", "requireApproval", state.sendMode, "With my approval", "Each message waits for you.", true)}
      ${choice("sendMode", "allow", state.sendMode, "Without approval", "Messages go out at once.")}
    </div>
    <div class="revealed field">
      <label for="preapproved">Skip approval for</label>
      <input
        id="preapproved"
        name="preapproved"
        type="text"
        value="${state.preapproved}"
        placeholder="me@example.com, team@example.com"
        aria-describedby="preapproved-hint"
      />
      <p class="hint" id="preapproved-hint">
        Comma-separated addresses. A message skips approval only when all its recipients are listed.
      </p>
      ${fieldError(error, "preapproved")}
    </div>
  </fieldset>`;
}

function recipientsFieldset(state: PolicyFormState, error: PolicyError | null): Html {
  return html`<fieldset class="stack">
    <legend>Recipients</legend>
    <div class="choices">
      ${choice("recipientScope", "any", state.recipientScope, "Anyone", "Any address it is told to write to.")}
      ${choice("recipientScope", "some", state.recipientScope, "Only these", "List the allowed addresses below.", true)}
    </div>
    <div class="revealed field">
      <label for="recipients">Allowed recipients</label>
      <input
        id="recipients"
        name="recipients"
        type="text"
        value="${state.recipients}"
        placeholder="anna@example.net, team@example.net"
      />
      ${fieldError(error, "recipients")}
    </div>
  </fieldset>`;
}

function choice(
  name: string,
  value: string,
  current: string,
  label: string,
  hint: string,
  reveals = false,
): Html {
  return html`<label class="choice"
    ><input
      type="radio"
      name="${name}"
      value="${value}"
      ${value === current ? html`checked` : null}
      ${reveals ? html`data-reveal` : null}
    />
    <span>${label}<small>${hint}</small></span></label
  >`;
}

function fieldError(error: PolicyError | null, field: PolicyField): Html | null {
  return error?.field === field ? html`<p class="error" role="alert">${error.message}</p>` : null;
}

function grantBadge(grant: ClientGrant): Html {
  if (grant.consentId === null) return html`<span class="badge accent">Operator CLI</span>`;
  if (grant.policy === null) return html`<span class="badge danger">No access</span>`;
  return html`<span class="badge">Agent</span>`;
}

function grantName(grant: ClientGrant): Html {
  return grant.name === null
    ? html`<span class="mono">${grant.clientId}</span>`
    : bidiText(grant.name);
}

function grantSummary(grant: ClientGrant, addresses: ReadonlyArray<Address>): string {
  if (grant.consentId === null) return "Full operator access through the CLI";
  if (grant.policy === null) return "No access until you save what it may do";
  const policy = grant.policy;
  const mailboxes =
    policy.mailboxIds === "all"
      ? "All mailboxes"
      : policy.mailboxIds.length === 1
        ? (addresses.find((address) => address.id === policy.mailboxIds[0])?.address ?? "1 mailbox")
        : `${policy.mailboxIds.length} mailboxes`;
  const sending = {
    deny: "no sending",
    requireApproval: "sends with approval",
    allow: "sends without approval",
  }[policy.sendMode.kind];
  const recipients =
    policy.recipientAllowlist === "any"
      ? "any recipient"
      : policy.recipientAllowlist.length === 1
        ? `only ${policy.recipientAllowlist[0]}`
        : `${policy.recipientAllowlist.length} recipients`;
  return [mailboxes, policy.canRead ? "reads" : "no reading", sending, recipients].join(" · ");
}

export function clientsPage(
  grants: ReadonlyArray<ClientGrant>,
  addresses: ReadonlyArray<Address>,
  flash: Flash | undefined,
): PageView {
  return {
    kind: "console",
    section: "clients",
    title: "Clients",
    heading: "Clients",
    lede: "Every client that can use AgentMail. Open one to change what it may do or to revoke it.",
    flash,
    main:
      grants.length === 0
        ? html`<p class="empty">No client has access yet.</p>`
        : html`<ul class="list">
            ${grants.map(
              (grant) =>
                html`<li>
                  <a class="row" href="/clients/${encodeURIComponent(grant.clientId)}">
                    <span class="primary">${grantName(grant)} ${grantBadge(grant)}</span>
                    <span class="secondary">${grantSummary(grant, addresses)}</span>
                  </a>
                </li>`,
            )}
          </ul>`,
  };
}

export function clientPage(
  grant: ClientGrant,
  addresses: ReadonlyArray<Address>,
  state: PolicyFormState,
  error: PolicyError | null,
  flash: Flash | undefined,
): PageView {
  // A client names itself at registration, so its name is projected like mail metadata.
  const name = displayText(grant.name ?? grant.clientId);
  const path = `/clients/${encodeURIComponent(grant.clientId)}`;
  const form =
    grant.consentId === null
      ? html`<p class="muted">
          The CLI signs in as the operator and always has full access. Revoke it to sign it out.
        </p>`
      : html`<form class="stack" method="post" action="${path}">
          ${accessFieldsets(state, addresses, error)}
          <fieldset class="stack">
            <legend>Reading</legend>
            <label class="choice"
              ><input type="checkbox" name="canRead" ${state.canRead ? html`checked` : null} />
              <span>Read mail<small>List, open and download messages.</small></span></label
            >
          </fieldset>
          ${recipientsFieldset(state, error)}
          <div class="actions">
            <button type="submit">${grant.policy === null ? "Grant access" : "Save access"}</button>
          </div>
        </form>`;
  return {
    kind: "console",
    section: "clients",
    title: name,
    heading: name,
    lede: html`${grantBadge(grant)} <span class="mono muted">${grant.clientId}</span>`,
    flash,
    main: html`${form}
      <section class="section" aria-labelledby="revoke-title">
        <h2 id="revoke-title">Revoke access</h2>
        <p class="muted">
          Revoking ends this client's tokens at once. It can ask again through the consent screen.
        </p>
        <div class="actions">
          <button class="danger" type="button" popovertarget="revoke-dialog">Revoke access…</button>
        </div>
      </section>
      <div id="revoke-dialog" popover>
        <h2>Revoke ${name}?</h2>
        <p>Its tokens stop working at once.</p>
        <form class="actions" method="post" action="${path}/revoke">
          <button class="danger solid" type="submit">Revoke</button>
          <button
            class="secondary"
            type="button"
            popovertarget="revoke-dialog"
            popovertargetaction="hide"
          >
            Cancel
          </button>
        </form>
      </div>`,
  };
}

const ClientParams = Schema.Struct({ clientId: Schema.String });

const FlashQuery = Schema.Struct({
  saved: Schema.optionalKey(Schema.String),
  revoked: Schema.optionalKey(Schema.String),
});

// Forms decode permissively and are checked by `policyFromForm`, so a bad entry re-renders with the
// typed values. A repeated checkbox arrives as a string, an array, or not at all.
const PolicyForm = Schema.Struct({
  mailboxScope: Schema.optionalKey(Schema.String),
  mailbox: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  canRead: Schema.optionalKey(Schema.String),
  sendMode: Schema.optionalKey(Schema.String),
  preapproved: Schema.optionalKey(Schema.String),
  recipientScope: Schema.optionalKey(Schema.String),
  recipients: Schema.optionalKey(Schema.String),
});

function submittedState(form: typeof PolicyForm.Type): PolicyFormState {
  const mailboxIds =
    form.mailbox === undefined
      ? []
      : typeof form.mailbox === "string"
        ? [form.mailbox]
        : form.mailbox;
  return {
    mailboxScope: form.mailboxScope === "some" ? "some" : "all",
    mailboxIds,
    canRead: form.canRead !== undefined,
    sendMode:
      form.sendMode === "deny" || form.sendMode === "allow" ? form.sendMode : "requireApproval",
    preapproved: form.preapproved ?? "",
    recipientScope: form.recipientScope === "some" ? "some" : "any",
    recipients: form.recipients ?? "",
  };
}

const findGrant = Effect.fn("findGrant")(function* (deps: ApiDeps, clientId: string) {
  const grant = (yield* deps.access.list()).find((candidate) => candidate.clientId === clientId);
  return grant ?? (yield* new HttpApiError.NotFound());
});

export const clientsRoute = Effect.fn("clientsRoute")(function* (deps: ApiDeps) {
  const query = yield* HttpServerRequest.schemaSearchParams(FlashQuery);
  const flash: Flash | undefined =
    query.saved !== undefined
      ? { tone: "success", message: "Access saved." }
      : query.revoked !== undefined
        ? { tone: "success", message: "Access revoked." }
        : undefined;
  const grants = yield* deps.access.list();
  return yield* htmlResponse(200, clientsPage(grants, yield* listAddresses(deps), flash));
});

export const clientRoute = Effect.fn("clientRoute")(function* (deps: ApiDeps) {
  const { clientId } = yield* HttpRouter.schemaPathParams(ClientParams);
  const query = yield* HttpServerRequest.schemaSearchParams(FlashQuery);
  const grant = yield* findGrant(deps, clientId);
  const flash: Flash | undefined =
    query.saved === undefined ? undefined : { tone: "success", message: "Access saved." };
  return yield* htmlResponse(
    200,
    clientPage(grant, yield* listAddresses(deps), policyFormState(grant.policy), null, flash),
  );
});

export const saveClientRoute = Effect.fn("saveClientRoute")(function* (deps: ApiDeps) {
  const { clientId } = yield* HttpRouter.schemaPathParams(ClientParams);
  const grant = yield* findGrant(deps, clientId);
  if (grant.consentId === null) return yield* new HttpApiError.NotFound();
  const state = submittedState(yield* HttpServerRequest.schemaBodyUrlParams(PolicyForm));
  const result = policyFromForm({
    mailboxes: state.mailboxScope === "all" ? "all" : state.mailboxIds.join(","),
    canRead: state.canRead,
    sendMode: state.sendMode,
    preapproved: state.preapproved,
    recipients: state.recipientScope === "any" ? "any" : state.recipients,
  });
  if (result.kind === "invalid") {
    return yield* htmlResponse(
      400,
      clientPage(grant, yield* listAddresses(deps), state, result, {
        tone: "error",
        message: "Nothing was saved. Fix the marked field.",
      }),
    );
  }
  yield* deps.access.setPolicy(grant.consentId, result.policy);
  return redirect(`/clients/${encodeURIComponent(clientId)}?saved`);
});

export const revokeClientRoute = Effect.fn("revokeClientRoute")(function* (deps: ApiDeps) {
  const { clientId } = yield* HttpRouter.schemaPathParams(ClientParams);
  yield* deps.access.revoke(clientId);
  return redirect("/clients?revoked");
});
