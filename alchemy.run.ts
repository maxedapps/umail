import { parseExternalMailAddress } from "./packages/api-contract/src/mail-contact.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import ApiLive, { Api } from "./apps/server/src/api/worker.ts";
import { AuthDb, ProvisionedOperator } from "./apps/server/src/auth/auth-control.ts";
import { AuthProvision } from "./apps/server/src/auth/provisioning.ts";
import { mcpResourceUrl, restResourceUrl } from "./apps/server/src/auth/options.ts";
import InboundLive, { Inbound } from "./apps/server/src/mail/inbound.ts";
import IndexConsumerLive, { IndexConsumer } from "./apps/server/src/mail/indexing.ts";
import SendConsumerLive, { SendConsumer } from "./apps/server/src/mail/send.ts";
import { Recovery } from "./apps/server/src/mail/recovery.ts";
import { EmailRoutingDomainsApiLive } from "./apps/server/src/mail/routing-api.ts";
import {
  configureMailRouting,
  EmailRoutingDomainProvider,
} from "./apps/server/src/mail/routing.ts";
import { layoutForStage, rootDomain } from "./apps/server/src/site.ts";

// Export the real application program so local tests can inspect its resource graph without cloud providers.
export const application = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const site = layoutForStage(yield* rootDomain, stage);
  const operatorEmail = parseExternalMailAddress(yield* Config.string("UMAIL_OPERATOR_EMAIL"));
  if (operatorEmail.kind !== "ok") {
    throw new Error("UMAIL_OPERATOR_EMAIL is not a valid email address.");
  }

  const authDb = yield* AuthDb;
  const provision = yield* AuthProvision({
    identity: { databaseId: authDb.databaseId },
    runNonce: crypto.randomUUID(),
    operatorEmail: operatorEmail.address,
    restResource: restResourceUrl(site),
    mcpResource: mcpResourceUrl(site),
  });

  return yield* Effect.gen(function* () {
    const api = yield* Api;
    yield* IndexConsumer;
    yield* SendConsumer;
    const inbound = yield* Inbound;
    yield* Recovery(api.workerName, provision.operatorId);
    yield* configureMailRouting(site, stage, inbound.workerName);
    return {
      stage,
      apiHostname: site.apiHostname,
      apiWorker: api.workerName,
      mailKind: site.kind,
      mailDomain: site.mailDomain,
      inboundWorker: inbound.workerName,
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(ApiLive, InboundLive, IndexConsumerLive, SendConsumerLive)),
    Effect.provide(Layer.succeed(ProvisionedOperator, provision)),
  );
});

export default Alchemy.Stack(
  "uMail",
  {
    providers: EmailRoutingDomainProvider.pipe(
      Layer.provideMerge(EmailRoutingDomainsApiLive),
      Layer.provideMerge(Cloudflare.providers()),
    ),
    state: Cloudflare.state(),
  },
  application,
);
