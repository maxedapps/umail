import { html } from "../html.ts";
import type { PageView } from "../document.ts";

type NoticeView = {
  readonly title: string;
  readonly heading: string;
  readonly message: string;
  readonly tone: "ordinary" | "error";
};

// A page that only says something: an error, or the end of a flow.
export function noticePage(view: NoticeView): PageView {
  return {
    kind: "static",
    title: view.title,
    heading: view.heading,
    main: html`<p
      class="note${view.tone === "error" ? " danger" : ""}"
      role="${view.tone === "error" ? "alert" : "status"}"
    >
      ${view.message}
    </p>`,
  };
}
