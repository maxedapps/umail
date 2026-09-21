import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import type { HumanPagePolicy, RenderedHumanPage } from "./internal/page.ts";

export type HumanPageHeaders = {
  readonly "cache-control": "no-store";
  readonly "content-security-policy": string;
  readonly "content-type": "text/html; charset=utf-8";
  readonly "permissions-policy": string;
  readonly "referrer-policy": "no-referrer";
  readonly "x-content-type-options": "nosniff";
  readonly "x-frame-options": "DENY";
  readonly "x-robots-tag": "noindex, nofollow, noarchive";
};

export type ApprovalMessagePreviewHeaders = {
  readonly "cache-control": "no-store";
  readonly "content-security-policy": string;
  readonly "content-type": "text/html; charset=utf-8";
  readonly "referrer-policy": "no-referrer";
  readonly "x-content-type-options": "nosniff";
};

const APPROVAL_MESSAGE_PREVIEW_CSP =
  "default-src 'none'; sandbox; frame-ancestors 'self'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; style-src-elem 'none'; style-src-attr 'unsafe-inline'";

const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

export function humanPageHeaders(page: RenderedHumanPage): HumanPageHeaders {
  return {
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy(page.policy, page.nonce),
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": PERMISSIONS_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
}

export function humanPageHttpResponse(page: RenderedHumanPage) {
  return HttpServerResponse.text(page.html, {
    status: page.status,
    headers: { ...humanPageHeaders(page) },
  });
}

export function humanPageHttpApiResponse(page: RenderedHumanPage) {
  return {
    status: page.status,
    value: HttpApiSchema.withHeaders({
      body: page.html,
      headers: humanPageHeaders(page),
    }),
  };
}

export function approvalMessagePreviewHttpApiResponse(html: string) {
  return HttpApiSchema.withHeaders({
    body: html,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": APPROVAL_MESSAGE_PREVIEW_CSP,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    } satisfies ApprovalMessagePreviewHeaders,
  });
}

function contentSecurityPolicy(policy: HumanPagePolicy, nonce: string): string {
  let connectSource = "'none'";
  let formAction = "'none'";
  let frameSource = "'none'";
  let scriptSource = "'none'";
  if (policy === "auth") {
    connectSource = "'self'";
    formAction = "'self'";
    scriptSource = `'nonce-${nonce}'`;
  }
  if (policy === "approvalReview") {
    formAction = "'self'";
    frameSource = "'self'";
  }
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src ${connectSource}`,
    "font-src 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    `frame-src ${frameSource}`,
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src ${scriptSource}`,
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "worker-src 'none'",
  ].join("; ");
}
