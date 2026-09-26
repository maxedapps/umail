import type { PageView } from "../document.ts";
import { html } from "../html.ts";
import { icon } from "../icons.ts";

type NoticeView = {
  readonly title: string;
  readonly heading: string;
  readonly message: string;
  readonly tone: "ordinary" | "error";
  readonly link?: { readonly href: string; readonly label: string };
};

// A page that only says something: an error, or the end of a flow.
export function noticePage(view: NoticeView): PageView {
  return {
    kind: "static",
    title: view.title,
    heading: view.heading,
    main: html`${
      view.tone === "error"
        ? html`<p class="lede" role="alert">${icon("alert")}${view.message}</p>`
        : html`<p class="lede" role="status">${icon("check")}${view.message}</p>`
    }${
      view.link === undefined
        ? null
        : html`<p><a class="button secondary" href="${view.link.href}">${view.link.label}</a></p>`
    }`,
  };
}
