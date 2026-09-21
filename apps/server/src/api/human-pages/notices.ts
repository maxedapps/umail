import { escapeHtmlText, renderHumanPageInternal } from "./internal/page.ts";

export type HumanPageNoticeView = {
  readonly status: 200 | 400 | 403 | 404 | 410 | 500;
  readonly title: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
  readonly message: string;
  readonly tone: "ordinary" | "error";
};

export function renderHumanPageNotice(view: HumanPageNoticeView) {
  const role = view.tone === "error" ? "alert" : "status";
  const mainHtml = `<div class="notice-panel" role="${role}">
  <p>${escapeHtmlText(view.message)}</p>
</div>`;
  return renderHumanPageInternal({
    status: view.status,
    policy: "static",
    document: {
      title: view.title,
      eyebrow: view.eyebrow,
      heading: view.heading,
      description: view.description,
      mainHtml,
    },
  });
}
