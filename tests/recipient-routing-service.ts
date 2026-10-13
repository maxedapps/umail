import { Schema } from "effect";
import type { RecipientRule } from "../apps/server/src/mail/recipient-rules.ts";

const RuleRequest = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  priority: Schema.Finite,
  matchers: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["literal"]),
      field: Schema.Literals(["to"]),
      value: Schema.String,
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({ type: Schema.Literals(["worker"]), value: Schema.Array(Schema.String) }),
  ),
});

// Miniflare's outbound service is a local Cloudflare rules control plane. Every other
// outbound request fails, so the generated Worker tests cannot reach a live service.
export function recipientRoutingService() {
  const rules = new Map<string, RecipientRule>();
  let sequence = 0;
  return async (request: Pick<Request, "url" | "method" | "json">) => {
    const url = new URL(request.url);
    if (
      url.hostname === "umail-test-control.invalid" &&
      url.pathname === "/reset" &&
      request.method === "POST"
    ) {
      rules.clear();
      return new Response(null, { status: 204 });
    }
    const path = /^\/client\/v4\/zones\/([^/]+)\/email\/routing\/rules(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (url.hostname !== "api.cloudflare.com" || path === null)
      throw new Error(`Unexpected outbound request: ${request.method} ${url.href}`);
    const zoneId = path[1];
    if (zoneId === undefined) throw new Error("Missing rule zone");
    const id = path[2];
    const key = `${zoneId}/${id}`;
    let result: RecipientRule | ReadonlyArray<RecipientRule> | undefined;
    if (request.method === "GET" && id === undefined) {
      result =
        Number(url.searchParams.get("page") ?? "1") > 1
          ? []
          : [...rules.entries()]
              .filter(([stored]) => stored.startsWith(`${zoneId}/`))
              .map(([, rule]) => rule);
    } else if (request.method === "GET") {
      result = rules.get(key);
    } else if (request.method === "POST" || request.method === "PUT") {
      const body = Schema.decodeUnknownSync(RuleRequest)(await request.json());
      const ruleId = id ?? `runtime-rule-${++sequence}`;
      const saved: RecipientRule = {
        ...body,
        id: ruleId,
        matchers: body.matchers.map((matcher) => ({ ...matcher })),
        actions: body.actions.map((action) => ({ ...action, value: [...action.value] })),
      };
      result = saved;
      rules.set(`${zoneId}/${ruleId}`, saved);
    } else if (request.method === "DELETE") {
      result = rules.get(key);
      rules.delete(key);
    } else throw new Error(`Unexpected rule operation: ${request.method} ${url.href}`);
    return new Response(
      JSON.stringify(
        result === undefined
          ? { success: false, errors: [{ code: 2009, message: "Rule not found" }], messages: [] }
          : {
              success: true,
              errors: [],
              messages: [],
              result,
              result_info: { page: 1, total_pages: 1 },
            },
      ),
      {
        status: result === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
}
