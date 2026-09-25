import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AccountStore, AccountStoreLive, OPERATOR_ACCOUNT } from "./account/worker.ts";
import { ArchiveTransportError, makeApiHttpEffect } from "./api/app.ts";
import { cloudflareDestinations } from "./api/destinations.ts";
import { WebCrypto } from "./crypto.ts";
import { asUmailBetterAuth, makeAuthOptions } from "./auth/options.ts";
import { receiveInbound } from "./mail/inbound.ts";
import { IndexReceiptWork, indexReceipt } from "./mail/process-index.ts";
import { appRuntime } from "./app-runtime.ts";
import { AuthDb, MailArchive, MailIndex, ProvisionedOperator } from "./resources.ts";
import { currentSite } from "./site.ts";

const appProps = Effect.gen(function* () {
  const site = yield* currentSite;
  const props = { main: import.meta.url, workersDev: false, domain: site.apiHostname };
  // Action outputs and deployment credentials are unavailable during Worker initialization.
  if (globalThis.__ALCHEMY_RUNTIME__) return props;

  const provisioned = yield* ProvisionedOperator;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return {
    ...props,
    env: {
      AUTH_OPERATOR_ID: provisioned.operatorId,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  };
});

// The whole application in one Worker: the HTTP API and pages, the email handler, the MailIndex
// consumer, and the AccountStore Durable Object, whose alarm sends mail.
export class App extends Cloudflare.Worker<App, {}, AccountStore>()("App") {}

export default App.make(
  appProps,
  Effect.gen(function* () {
    const accounts = yield* AccountStore;
    const runtime = yield* appRuntime;
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const indexQueue = yield* MailIndex;
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    const routingToken = yield* Config.redacted("CF_EMAIL_ROUTING_TOKEN");
    const accountId = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Config.string("CLOUDFLARE_ACCOUNT_ID")
      : "plan";
    const authInstance = yield* BetterAuth({
      ...makeAuthOptions(runtime.site, runtime.operatorId, { rateLimit: true }),
      migrate: false,
    });

    // Any failure fails the email handler, which Cloudflare turns into a temporary SMTP failure.
    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const account = accounts.getByName(OPERATOR_ACCOUNT);
        yield* receiveInbound(message, { archive, index, account, nowIso });
      }).pipe(Effect.provide(WebCrypto)),
    );

    // One receipt per batch: alchemy acks it on success, and on failure logs the cause and retries.
    yield* Cloudflare.Queues.consumeQueueMessages(
      indexQueue,
      { batchSize: 1, maxConcurrency: 1 },
      (messages: Stream.Stream<Cloudflare.Queues.Message>) =>
        messages.pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const work = yield* Schema.decodeUnknownEffect(IndexReceiptWork)(message.body);
              const nowIso = DateTime.formatIso(yield* DateTime.now);
              yield* indexReceipt(work.receiptId, {
                archive,
                account: accounts.getByName(OPERATOR_ACCOUNT),
                htmlPolicy: runtime.htmlPolicy,
                nowIso,
              });
            }),
          ),
        ),
    );

    // Built on the first request and reused for the isolate's life: the Durable Object namespace
    // exists only at runtime. The router holds nothing that needs closing, so its scope stays open.
    const api = yield* Effect.cached(
      Effect.suspend(() =>
        makeApiHttpEffect({
          account: accounts.getByName(OPERATOR_ACCOUNT),
          archive: {
            get: (key) =>
              archive.get(key).pipe(
                Effect.flatMap((object) =>
                  object === null ? Effect.succeed(null) : object.bytes(),
                ),
                Effect.mapError(() => new ArchiveTransportError({ key })),
              ),
          },
          destinations: cloudflareDestinations({ token: routingToken, accountId }),
          htmlPolicy: runtime.htmlPolicy,
          mailDomain: runtime.site.mailDomain,
          applicationUrl: runtime.applicationUrl,
          operatorId: runtime.operatorId,
          notificationKey: runtime.notificationKey,
          auth: { auth: Effect.map(authInstance.auth, asUmailBetterAuth) },
          access: runtime.access,
        }),
      ).pipe(Effect.provideServiceEffect(Scope.Scope, Scope.make())),
    );

    return { fetch: Effect.flatten(api) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudflareD1(AuthDb),
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.EmailEventSourceLive,
        AccountStoreLive,
      ),
    ),
  ),
);
