import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { AGENTMAIL_ICON_PNG } from "./icon-bytes.ts";

export const PRODUCT_NAME = "AgentMail";
export const MCP_SERVER_NAME = "umail";
export const MCP_SERVER_VERSION = "0.0.0";
export const PRODUCT_DESCRIPTION =
  "Self-hosted mailbox for AI agents. Read mail, manage threads, and send with approval.";
export const PRODUCT_WEBSITE_URL = "https://github.com/maxedapps/umail";
export const AGENTMAIL_ICON_PATH = "/icon.png";
export const CLI_CLIENT_NAME = "AgentMail CLI";

export function productPageTitle(label: string): string {
  return `${label} · ${PRODUCT_NAME}`;
}

export function agentMailIconUrl(origin: string): string {
  return `${origin}${AGENTMAIL_ICON_PATH}`;
}

export function agentMailMcpServerInfo(origin: string) {
  return {
    name: MCP_SERVER_NAME,
    title: PRODUCT_NAME,
    version: MCP_SERVER_VERSION,
    description: PRODUCT_DESCRIPTION,
    websiteUrl: PRODUCT_WEBSITE_URL,
    icons: [
      {
        src: agentMailIconUrl(origin),
        mimeType: "image/png",
        sizes: ["512x512"],
      },
    ],
  };
}

export function isAgentMailIconPath(pathname: string): boolean {
  return pathname === AGENTMAIL_ICON_PATH || pathname === "/favicon.png";
}

export function serveAgentMailIcon(method: string) {
  if (method !== "GET") {
    return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
  }
  return HttpServerResponse.uint8Array(AGENTMAIL_ICON_PNG, {
    status: 200,
    contentType: "image/png",
    headers: {
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}
