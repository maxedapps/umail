import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createMailHtmlPolicy } from "./mail/html-policy.ts";
import { AccountStore, AccountStoreLive, OPERATOR_ACCOUNT } from "./account/worker.ts";
import { ArchiveTransportError, makeApiHttpEffect } from "./api/app.ts";
import { cloudflareDestinations } from "./api/destinations.ts";
import { WebCrypto } from "./crypto.ts";
import { makeAccess } from "./auth/access.ts";
import { asUmailBetterAuth, makeAuthOptions } from "./auth/options.ts";
import { receiveInbound } from "./mail/inbound.ts";
import { notificationKeyFromSecret } from "./mail/notifications.ts";
import { IndexReceiptWork, indexReceipt } from "./mail/process-index.ts";
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
    const site = yield* currentSite;
    const archive = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const indexQueue = yield* MailIndex;
    const index = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    const authDb = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    const routingToken = yield* Config.redacted("CF_EMAIL_ROUTING_TOKEN");
    const operatorId = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Config.string("AUTH_OPERATOR_ID")
      : "plan";
    const accountId = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Config.string("CLOUDFLARE_ACCOUNT_ID")
      : "plan";
    const authInstance = yield* BetterAuth({
      ...makeAuthOptions(site, operatorId, { rateLimit: true }),
      migrate: false,
    });
    const htmlPolicy = createMailHtmlPolicy();
    const notificationSecret = yield* Config.redacted("UMAIL_NOTIFICATION_KEY");
    const depsWithoutAccount = {
      archive: {
        get: (key: string) =>
          archive.get(key).pipe(
            Effect.flatMap((object) => (object === null ? Effect.succeed(null) : object.bytes())),
            Effect.mapError(() => new ArchiveTransportError({ key })),
          ) as Effect.Effect<Uint8Array | null, ArchiveTransportError>,
      },
      destinations: cloudflareDestinations({ token: routingToken, accountId }),
      htmlPolicy,
      mailDomain: site.mailDomain,
      applicationUrl: new URL(`https://${site.apiHostname}`),
      operatorId,
      notificationKey: notificationKeyFromSecret(Redacted.value(notificationSecret)),
    };

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
              const account = accounts.getByName(OPERATOR_ACCOUNT);
              yield* indexReceipt(work.receiptId, { archive, account, htmlPolicy, nowIso });
            }),
          ),
        ),
    );

    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const auth = asUmailBetterAuth(yield* authInstance.auth);
          const handle = yield* makeApiHttpEffect({
            ...depsWithoutAccount,
            account: accounts.getByName(OPERATOR_ACCOUNT),
            auth,
            access: makeAccess(authDb, operatorId),
          });
          return yield* handle;
        }),
      ),
    };
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
