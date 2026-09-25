import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { AGENTMAIL_ICON_PNG } from "./icon-bytes.ts";

export const PRODUCT_NAME = "AgentMail";
const MCP_SERVER_NAME = "umail";
const MCP_SERVER_VERSION = "0.0.0";
const PRODUCT_DESCRIPTION =
  "Self-hosted mailbox for AI agents. Read mail, manage threads, and send with approval.";
const PRODUCT_WEBSITE_URL = "https://github.com/maxedapps/umail";
const AGENTMAIL_ICON_PATH = "/icon.png";

export function productPageTitle(label: string): string {
  return `${label} · ${PRODUCT_NAME}`;
}

function agentMailIconUrl(origin: string): string {
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

export const agentMailIconResponse = HttpServerResponse.uint8Array(AGENTMAIL_ICON_PNG, {
  status: 200,
  contentType: "image/png",
  headers: {
    "cache-control": "public, max-age=86400",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  },
});
