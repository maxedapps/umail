import {
  parseExternalMailAddress,
  type Address,
  type CreateAddressPayload,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import {
  createAddress,
  getAddress,
  listAddresses,
  patchAddress,
  removeAddressForwarding,
  setAddressForwarding,
  retireAddress,
  retryAddressRouting,
} from "../../api/operations.ts";
import { htmlResponse, redirect, type Flash, type PageView } from "../document.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";

type FieldError = {
  readonly field: "localPart" | "domain" | "forwardTo";
  readonly message: string;
};

function fieldError(error: FieldError | null, field: FieldError["field"]): Html | null {
  return error?.field === field ? html`<p class="error" role="alert">${error.message}</p>` : null;
}

function activeBadge(address: Address): Html {
  if (address.retiredAt !== null) return html`<span class="badge">Retired</span>`;
  return address.active
    ? html`<span class="badge success">Active</span>`
    : html`<span class="badge">Paused</span>`;
}

function receptionBadge(address: Address): Html {
  if (address.routing.state === "error") return html`<span class="badge">Reception error</span>`;
  if (address.retiredAt !== null)
    return html`<span class="badge"
      >${address.routing.state === "ready" ? "Reception removed" : "Removing reception"}</span
    >`;
  return address.routing.state === "ready"
    ? html`<span class="badge success">Ready</span>`
    : html`<span class="badge">Reception pending</span>`;
}

export function mailboxesPage(
  addresses: ReadonlyArray<Address>,
  domains: ApiDeps["mailDomains"],
  form: { readonly localPart: string; readonly displayName: string; readonly domain: string },
  error: FieldError | null,
): PageView {
  return {
    kind: "console",
    section: "mailboxes",
    title: "Mailboxes",
    heading: "Mailboxes",
    lede: "Every address AgentMail receives mail for. Open one to rename it, pause it or forward it.",
    flash: error === null ? undefined : { tone: "error", message: "Nothing was created." },
    main: html`${
        addresses.length === 0
          ? html`<p class="empty">No mailboxes yet.</p>`
          : html`<ul class="rows">
              ${addresses.map(
                (address) =>
                  html`<li>
                    <a class="row" href="/mailboxes/${encodeURIComponent(address.id)}">
                      <span
                        ><span class="mono">${address.address}</span> ${activeBadge(address)}
                        ${receptionBadge(address)}</span
                      >
                      <small
                        >${address.displayName ?? "No display name"}${
                          address.forwardTo === null ? null : ` · forwards to ${address.forwardTo}`
                        }</small
                      >
                    </a>
                  </li>`,
              )}
            </ul>`
      }
      <div class="settings">
        <section class="setting" aria-labelledby="new-mailbox-title">
          <header>
            <h2 id="new-mailbox-title">New mailbox</h2>
            <p>Create an address on one of this installation's receiving domains.</p>
          </header>
          <form method="post" action="/mailboxes">
            <div class="field">
              <label for="localPart">Address</label>
              <input
                id="localPart"
                name="localPart"
                type="text"
                value="${form.localPart}"
                required
                autocomplete="off"
                ${error?.field === "localPart" ? html`aria-invalid="true"` : null}
              />
              ${fieldError(error, "localPart")}
            </div>
            <div class="field">
              <label for="domain">Receiving domain</label>
              <select id="domain" name="domain" required>
                ${domains.filter(({ receive }) => receive).map(({ name }) => html`<option value="${name}" ${form.domain === name ? html`selected` : null}>@${name}</option>`)}
              </select>
              ${fieldError(error, "domain")}
            </div>
            <div class="field">
              <label for="displayName">Display name</label>
              <input id="displayName" name="displayName" type="text" value="${form.displayName}" />
            </div>
            <div class="actions"><button class="button" type="submit">Create mailbox</button></div>
          </form>
        </section>
      </div>`,
  };
}

export function mailboxPage(
  address: Address,
  forwardTo: string,
  error: FieldError | null,
  flash: Flash | undefined,
  awaitingVerification: boolean,
): PageView {
  const path = `/mailboxes/${encodeURIComponent(address.id)}`;
  return {
    kind: "console",
    section: "mailboxes",
    title: address.address,
    heading: address.address,
    lede: activeBadge(address),
    flash,
    toolbar: html`<nav class="crumbs" aria-label="Breadcrumb">
      <a href="/mailboxes">Mailboxes</a>${icon("right")}<span>${address.address}</span>
    </nav>`,
    main: html`<div class="settings">
      <section class="setting" aria-labelledby="reception-title">
        <header>
          <h2 id="reception-title">Reception</h2>
          <p>${receptionBadge(address)}</p>
        </header>
        ${address.routing.error === null ? null : html`<p class="error" role="alert">${address.routing.error}</p>`}
        ${address.routing.state === "error" ? html`<form method="post" action="${path}/routing/retry"><button class="button" type="submit">Retry reception</button></form>` : null}
        ${address.routing.state === "pending" ? html`<p>Reception is being updated. <a href="${path}">Refresh status</a></p>` : null}
        <p>${address.canSend ? "This domain can send mail." : "This domain receives mail only."}</p>
      </section>
      ${
        address.retiredAt !== null
          ? html`<section class="setting">
              <h2>Archived mailbox</h2>
              <p>
                Retired on ${address.retiredAt}. Existing mail remains available; this address
                cannot be resumed.
              </p>
            </section>`
          : html` <section class="setting" aria-labelledby="general-title">
                <header>
                  <h2 id="general-title">General</h2>
                  <p>How the address signs its mail, and whether it takes any.</p>
                </header>
                <form method="post" action="${path}">
                  <div class="field">
                    <label for="displayName">Display name</label>
                    <input
                      id="displayName"
                      name="displayName"
                      type="text"
                      value="${address.displayName ?? ""}"
                    />
                    <p class="hint">Shown as the sender name on mail from this address.</p>
                  </div>
                  <label class="switch-row"
                    ><span
                      ><b>Active</b
                      ><small>An inactive mailbox rejects new mail and cannot send.</small></span
                    ><input
                      class="switch"
                      type="checkbox"
                      name="active"
                      ${address.active ? html`checked` : null}
                  /></label>
                  <div class="actions"><button class="button" type="submit">Save</button></div>
                </form>
              </section>
              <section class="setting" aria-labelledby="forwarding-title">
                <header>
                  <h2 id="forwarding-title">Forwarding</h2>
                  <p>Copies incoming mail to another address.</p>
                </header>
                <form method="post" action="${path}/forwarding">
                  ${
                    address.forwardTo === null
                      ? html`<p class="muted">Mail is kept here only.</p>`
                      : awaitingVerification
                        ? html`<p class="note warning" role="status">
                            ${icon("alert")}Waiting for verification — Cloudflare emailed
                            ${address.forwardTo}. Mail is forwarded once the address is verified.
                          </p>`
                        : html`<p class="muted">
                            Mail is also forwarded to
                            <span class="mono">${address.forwardTo}</span>.
                          </p>`
                  }
                  <div class="field">
                    <label for="forwardTo">Forward to</label>
                    <input
                      id="forwardTo"
                      name="email"
                      type="email"
                      value="${forwardTo}"
                      required
                      ${error?.field === "forwardTo" ? html`aria-invalid="true"` : null}
                    />
                    <p class="hint">
                      Cloudflare emails this address once to verify it before forwarding.
                    </p>
                    ${fieldError(error, "forwardTo")}
                  </div>
                  <div class="actions">
                    <button class="button" type="submit">
                      ${address.forwardTo === null ? "Forward" : "Change"}
                    </button>
                    ${
                      address.forwardTo === null
                        ? null
                        : html`<button
                            class="button danger"
                            type="submit"
                            name="remove"
                            value="1"
                            formnovalidate
                          >
                            Stop forwarding
                          </button>`
                    }
                  </div>
                </form>
              </section>
              <section class="setting" aria-labelledby="retire-title">
                <header>
                  <h2 id="retire-title">Retire mailbox</h2>
                  <p>
                    Permanently stop reception and sending. Existing messages stay in the archive.
                  </p>
                </header>
                <form method="post" action="${path}/retire">
                  <button class="button danger" type="submit">Retire mailbox</button>
                </form>
              </section>`
      }
    </div>`,
  };
}

const MailboxForm = Schema.Struct({
  localPart: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.String),
  domain: Schema.optionalKey(Schema.String),
});

const ForwardingForm = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  remove: Schema.optionalKey(Schema.String),
});

const MailboxParams = Schema.Struct({ id: Schema.String });

const MailboxQuery = Schema.Struct({
  saved: Schema.optionalKey(Schema.String),
  forwarding: Schema.optionalKey(Schema.String),
});

export const mailboxesRoute = Effect.fn("mailboxesRoute")(function* (deps: ApiDeps) {
  return yield* htmlResponse(
    200,
    mailboxesPage(
      yield* listAddresses(deps),
      deps.mailDomains,
      { localPart: "", displayName: "", domain: "" },
      null,
    ),
  );
});

export const createMailboxRoute = Effect.fn("createMailboxRoute")(function* (deps: ApiDeps) {
  const form = yield* HttpServerRequest.schemaBodyUrlParams(MailboxForm);
  const localPart = (form.localPart ?? "").trim();
  const displayName = (form.displayName ?? "").trim();
  const input: Mutable<Pick<CreateAddressPayload, "localPart" | "displayName" | "domain">> = {
    localPart,
  };
  if (displayName.length > 0) input.displayName = displayName;
  if (form.domain !== undefined) input.domain = form.domain;
  return yield* createAddress(deps, input).pipe(
    Effect.map((address) => redirect(`/mailboxes/${encodeURIComponent(address.id)}?saved`)),
    Effect.catchTag(["InvalidRequest", "Conflict"], (problem) =>
      Effect.flatMap(listAddresses(deps), (addresses) =>
        htmlResponse(
          400,
          mailboxesPage(
            addresses,
            deps.mailDomains,
            { localPart, displayName, domain: form.domain ?? "" },
            {
              field:
                problem._tag === "InvalidRequest" && problem.code === "receiving_domain_required"
                  ? "domain"
                  : "localPart",
              message: problem.message,
            },
          ),
        ),
      ),
    ),
  );
});

export const retryMailboxRoutingRoute = Effect.fn("retryMailboxRoutingRoute")(function* (
  deps: ApiDeps,
) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  yield* retryAddressRouting(deps, id);
  return redirect(`/mailboxes/${encodeURIComponent(id)}`);
});

export const retireMailboxRoute = Effect.fn("retireMailboxRoute")(function* (deps: ApiDeps) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  yield* retireAddress(deps, id);
  return redirect(`/mailboxes/${encodeURIComponent(id)}`);
});

export const mailboxRoute = Effect.fn("mailboxRoute")(function* (deps: ApiDeps) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  const query = yield* HttpServerRequest.schemaSearchParams(MailboxQuery);
  const address = yield* getAddress(deps, id);
  // Only the redirect after a save knows forwarding is unverified, so that state stays on the page
  // instead of in a toast that fades while the sentence below would claim mail is forwarded.
  return yield* htmlResponse(
    200,
    mailboxPage(address, "", null, mailboxFlash(address, query), query.forwarding === "pending"),
  );
});

function mailboxFlash(address: Address, query: typeof MailboxQuery.Type): Flash | undefined {
  switch (query.forwarding) {
    case "verified":
      return { tone: "success", message: `Forwarding to ${address.forwardTo ?? ""} is verified.` };
    case "removed":
      return { tone: "success", message: "Forwarding stopped." };
  }
  return query.saved === undefined ? undefined : { tone: "success", message: "Saved." };
}

export const saveMailboxRoute = Effect.fn("saveMailboxRoute")(function* (deps: ApiDeps) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  const form = yield* HttpServerRequest.schemaBodyUrlParams(MailboxForm);
  const displayName = (form.displayName ?? "").trim();
  yield* patchAddress(deps, id, {
    displayName: displayName.length === 0 ? null : displayName,
    active: form.active !== undefined,
  });
  return redirect(`/mailboxes/${encodeURIComponent(id)}?saved`);
});

export const forwardingRoute = Effect.fn("forwardingRoute")(function* (deps: ApiDeps) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  const form = yield* HttpServerRequest.schemaBodyUrlParams(ForwardingForm);
  const path = `/mailboxes/${encodeURIComponent(id)}`;
  if (form.remove !== undefined) {
    yield* removeAddressForwarding(deps, id);
    return redirect(`${path}?forwarding=removed`);
  }
  const email = (form.email ?? "").trim();
  const rejected = (message: string) =>
    Effect.flatMap(getAddress(deps, id), (address) =>
      htmlResponse(
        400,
        mailboxPage(address, email, { field: "forwardTo", message }, undefined, false),
      ),
    );
  if (parseExternalMailAddress(email).kind !== "ok") {
    return yield* rejected(`“${email}” is not an email address.`);
  }
  return yield* setAddressForwarding(deps, id, email).pipe(
    Effect.map((forwarding) =>
      redirect(`${path}?forwarding=${forwarding.verified ? "verified" : "pending"}`),
    ),
    Effect.catchTags({
      InvalidRequest: (problem) => rejected(problem.message),
      // Not the address's fault: Cloudflare is down or the deploy's token is wrong.
      Unavailable: (problem) =>
        Effect.flatMap(getAddress(deps, id), (address) =>
          htmlResponse(
            502,
            mailboxPage(
              address,
              email,
              null,
              { tone: "error", message: `Forwarding was not changed. ${problem.message}` },
              false,
            ),
          ),
        ),
    }),
  );
});
