import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import AppLive, { App } from "./apps/server/src/app.ts";
import { AuthProvision } from "./apps/server/src/auth/provisioning.ts";
import { WebCrypto, randomId } from "./apps/server/src/crypto.ts";
import { mcpResourceUrl, restResourceUrl } from "./apps/server/src/auth/options.ts";
import {
  configureMailRouting,
  DeploymentMailDomains,
  mailDomainResources,
} from "./apps/server/src/mail/routing.ts";
import { EmailRoutingDomainProvider } from "./apps/server/src/mail/receiving-domain.ts";
import { LegacyCatchAllProvider } from "./apps/server/src/mail/legacy-catch-all.ts";
import { LegacySeedRuleProvider } from "./apps/server/src/mail/legacy-seed-rules.ts";
import { AuthDb, ProvisionedOperator } from "./apps/server/src/resources.ts";
import { currentSite, deployConfigError, operatorEmail } from "./apps/server/src/site.ts";
import { loadStackName } from "./tools/stack-name.ts";

// Export the real application program so local tests can inspect its resource graph without cloud providers.
export const application = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const site = yield* currentSite;
  const domains = yield* mailDomainResources;

  const authDb = yield* AuthDb;
  const provision = yield* AuthProvision({
    identity: { databaseId: authDb.databaseId },
    runNonce: yield* randomId,
    operatorEmail: yield* operatorEmail,
    restResource: restResourceUrl(site),
    mcpResource: mcpResourceUrl(site),
  });

  return yield* Effect.gen(function* () {
    const app = yield* App;
    yield* configureMailRouting(app.workerName);
    return {
      stage,
      apiHostname: site.apiHostname,
      worker: app.workerName,
      mailKind: site.kind,
      mailDomain: site.mailDomain,
    };
  }).pipe(
    Effect.provide(AppLive.pipe(Layer.provide(Layer.succeed(ProvisionedOperator, provision)))),
    Effect.provideService(DeploymentMailDomains, domains),
  );
}).pipe(
  Effect.provide(WebCrypto),
  // alchemy prints a UserFacingError, failed or died, as one line naming the variable instead of a
  // SchemaError tree. Stack types its error channel as ConfigError, so this one dies.
  Effect.catchTags({
    ConfigError: (error) => Effect.die(deployConfigError(error)),
    ReceivingDomainUnsafe: Effect.die,
  }),
);

export default Alchemy.Stack(
  await loadStackName(),
  {
    providers: Layer.mergeAll(
      EmailRoutingDomainProvider,
      LegacyCatchAllProvider,
      LegacySeedRuleProvider,
    ).pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  application,
);
