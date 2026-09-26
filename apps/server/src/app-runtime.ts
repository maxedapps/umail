import { Telemetry } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";

import { makeAccess } from "./auth/access.ts";
import { createMailHtmlPolicy } from "./mail/html-policy.ts";
import { notificationKeyFromHex } from "./mail/notifications.ts";
import { AuthDb, NotificationKey } from "./resources.ts";
import { currentSite } from "./site.ts";

// Workers Logs get one JSON object per log line, with its annotations (jobId, tool, clientId) as
// fields. Provided on both Workers' init effects so it reaches every event.
export const StructuredLogs = Telemetry.layer(Logger.layer([Logger.consoleStructured]));

// What the App Worker and the AccountStore both build at construction.
export const appRuntime = Effect.gen(function* () {
  const site = yield* currentSite;
  const authDb = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const keyText = yield* (yield* NotificationKey).text;
  // The provisioned operator id is only in the deployed Worker's env; planning uses a placeholder.
  const operatorId = globalThis.__ALCHEMY_RUNTIME__
    ? yield* Config.string("AUTH_OPERATOR_ID")
    : "plan";
  return {
    site,
    applicationUrl: new URL(`https://${site.apiHostname}`),
    htmlPolicy: createMailHtmlPolicy(),
    // Read when used: the key is bound into the Worker's env and readable only at runtime.
    notificationKey: Effect.map(keyText, (text) => notificationKeyFromHex(Redacted.value(text))),
    operatorId,
    access: makeAccess(authDb, operatorId),
  };
});
