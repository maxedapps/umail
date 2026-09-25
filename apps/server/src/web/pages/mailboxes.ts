import { parseExternalMailAddress, type Address } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type { ApiDeps } from "../../api/app.ts";
import {
  createAddress,
  getAddress,
  listAddresses,
  patchAddress,
  removeAddressForwarding,
  setAddressForwarding,
} from "../../api/operations.ts";
import { htmlResponse, redirect, type Flash, type PageView } from "../document.ts";
import { html, type Html } from "../html.ts";

type FieldError = { readonly field: "localPart" | "forwardTo"; readonly message: string };

function fieldError(error: FieldError | null, field: FieldError["field"]): Html | null {
  return error?.field === field ? html`<p class="error" role="alert">${error.message}</p>` : null;
}

function activeBadge(address: Address): Html {
  return address.active
    ? html`<span class="badge success">Active</span>`
    : html`<span class="badge">Inactive</span>`;
}

export function mailboxesPage(
  addresses: ReadonlyArray<Address>,
  mailDomain: string,
  form: { readonly localPart: string; readonly displayName: string },
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
          : html`<ul class="list">
              ${addresses.map(
                (address) =>
                  html`<li>
                    <a class="row" href="/mailboxes/${encodeURIComponent(address.id)}">
                      <span class="primary"
                        ><span class="mono">${address.address}</span> ${activeBadge(address)}</span
                      >
                      <span class="secondary"
                        >${address.displayName ?? "No display name"}${
                          address.forwardTo === null ? null : ` · forwards to ${address.forwardTo}`
                        }</span
                      >
                    </a>
                  </li>`,
              )}
            </ul>`
      }
      <section class="section" aria-labelledby="new-mailbox-title">
        <h2 id="new-mailbox-title">New mailbox</h2>
        <form class="stack" method="post" action="/mailboxes">
          <div class="field">
            <label for="localPart">Address</label>
            <div class="suffixed">
              <input
                id="localPart"
                name="localPart"
                type="text"
                value="${form.localPart}"
                required
                autocomplete="off"
                ${error?.field === "localPart" ? html`aria-invalid="true"` : null}
              />
              <span>@${mailDomain}</span>
            </div>
            ${fieldError(error, "localPart")}
          </div>
          <div class="field">
            <label for="displayName">Display name</label>
            <input id="displayName" name="displayName" type="text" value="${form.displayName}" />
          </div>
          <div class="actions"><button type="submit">Create mailbox</button></div>
        </form>
      </section>`,
  };
}

export function mailboxPage(
  address: Address,
  forwardTo: string,
  error: FieldError | null,
  flash: Flash | undefined,
): PageView {
  const path = `/mailboxes/${encodeURIComponent(address.id)}`;
  return {
    kind: "console",
    section: "mailboxes",
    title: address.address,
    heading: address.address,
    lede: activeBadge(address),
    flash,
    main: html`<form class="stack" method="post" action="${path}">
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
        <label class="choice"
          ><input type="checkbox" name="active" ${address.active ? html`checked` : null} />
          <span
            >Active<small>An inactive mailbox rejects new mail and cannot send.</small></span
          ></label
        >
        <div class="actions"><button type="submit">Save</button></div>
      </form>
      <section class="section" aria-labelledby="forwarding-title">
        <h2 id="forwarding-title">Forwarding</h2>
        <p class="muted">
          ${
            address.forwardTo === null
              ? "Mail is kept here only."
              : html`Mail is also forwarded to <span class="mono">${address.forwardTo}</span>.`
          }
        </p>
        <form class="stack" method="post" action="${path}/forwarding">
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
            <p class="hint">Cloudflare emails this address once to verify it before forwarding.</p>
            ${fieldError(error, "forwardTo")}
          </div>
          <div class="actions">
            <button type="submit">${address.forwardTo === null ? "Forward" : "Change"}</button>
          </div>
        </form>
        ${
          address.forwardTo === null
            ? null
            : html`<form method="post" action="${path}/forwarding">
                <input type="hidden" name="remove" value="1" />
                <button class="danger" type="submit">Stop forwarding</button>
              </form>`
        }
      </section>`,
  };
}

const MailboxForm = Schema.Struct({
  localPart: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.String),
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
      deps.mailDomain,
      { localPart: "", displayName: "" },
      null,
    ),
  );
});

export const createMailboxRoute = Effect.fn("createMailboxRoute")(function* (deps: ApiDeps) {
  const form = yield* HttpServerRequest.schemaBodyUrlParams(MailboxForm);
  const localPart = (form.localPart ?? "").trim();
  const displayName = (form.displayName ?? "").trim();
  const input = displayName.length === 0 ? { localPart } : { localPart, displayName };
  return yield* createAddress(deps, input).pipe(
    Effect.map((address) => redirect(`/mailboxes/${encodeURIComponent(address.id)}?saved`)),
    Effect.catchTag(["BadRequest", "Conflict"], () =>
      Effect.flatMap(listAddresses(deps), (addresses) =>
        htmlResponse(
          400,
          mailboxesPage(
            addresses,
            deps.mailDomain,
            { localPart, displayName },
            {
              field: "localPart",
              message: "That address is not valid or already exists.",
            },
          ),
        ),
      ),
    ),
  );
});

export const mailboxRoute = Effect.fn("mailboxRoute")(function* (deps: ApiDeps) {
  const { id } = yield* HttpRouter.schemaPathParams(MailboxParams);
  const query = yield* HttpServerRequest.schemaSearchParams(MailboxQuery);
  const address = yield* getAddress(deps, id);
  return yield* htmlResponse(200, mailboxPage(address, "", null, mailboxFlash(address, query)));
});

function mailboxFlash(address: Address, query: typeof MailboxQuery.Type): Flash | undefined {
  switch (query.forwarding) {
    case "verified":
      return { tone: "success", message: `Forwarding to ${address.forwardTo ?? ""} is verified.` };
    case "pending":
      return {
        tone: "success",
        message: `Waiting for verification — Cloudflare emailed ${address.forwardTo ?? ""}.`,
      };
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
      htmlResponse(400, mailboxPage(address, email, { field: "forwardTo", message }, undefined)),
    );
  if (parseExternalMailAddress(email).kind !== "ok") {
    return yield* rejected(`“${email}” is not an email address.`);
  }
  return yield* setAddressForwarding(deps, id, email).pipe(
    Effect.map((forwarding) =>
      redirect(`${path}?forwarding=${forwarding.verified ? "verified" : "pending"}`),
    ),
    Effect.catchTag("ApiProblem", (problem) => rejected(problem.message)),
  );
});
