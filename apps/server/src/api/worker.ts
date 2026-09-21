import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { generateApprovalToken, parseExternalMailAddress } from "@umail/api-contract";
import { createMailHtmlPolicy } from "@umail/mail-content";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { AuthDb } from "../auth/auth-control.ts";
import { MailArchive } from "../mail/archive.ts";
import { ProvisionedOperator } from "../auth/auth-control.ts";
import { layoutForStage, rootDomain } from "../site.ts";
import { AccountStore, AccountStoreLive } from "../account/worker.ts";
import { ArchiveTransportError, makeApiHttpEffect } from "./app.ts";
import type { AuthControlDatabase } from "../auth/auth-control.ts";
import { asUmailBetterAuth, makeAuthOptions } from "../auth/options.ts";
import { cloudflareDestinationsClient } from "./destinations.ts";
import { notificationKeyringFromSecret } from "../mail/notifications.ts";

const siteEffect = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return layoutForStage(yield* rootDomain, stack.stage);
});

const apiWorkerProps = Effect.gen(function* () {
  const site = yield* siteEffect;
  const props = { main: import.meta.url, workersDev: false, domain: site.apiHostname };
  // Action outputs and deployment credentials are unavailable during Worker initialization.
  if (globalThis.__ALCHEMY_RUNTIME__) return props;

  const provisioned = yield* ProvisionedOperator;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return {
    ...props,
    env: {
      UMAIL_MAIL_DOMAIN: site.mailDomain,
      UMAIL_PREVIEW_MAILBOXES: site.kind === "preview" ? site.testLocalParts.join(",") : "",
      AUTH_SCHEMA_REVISION: provisioned.schemaRevision,
      AUTH_PROVISION_GENERATION: provisioned.generation,
      AUTH_OPERATOR_ID: provisioned.operatorId,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  };
});

export class Api extends Cloudflare.Worker<Api, {}, AccountStore>()("Api") {}

export default Api.make(
  apiWorkerProps,
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const site = yield* siteEffect;
    const mailDomain = site.mailDomain;
    const applicationUrl = new URL(`https://${site.apiHostname}`);
    const authDb = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    const archive = yield* Cloudflare.R2.ReadBucket(MailArchive);
    const routingToken = yield* Config.redacted("CF_EMAIL_ROUTING_TOKEN");
    const operatorEmailRaw = yield* Config.string("UMAIL_OPERATOR_EMAIL");
    const operatorEmailParsed = parseExternalMailAddress(operatorEmailRaw);
    if (operatorEmailParsed.kind !== "ok") {
      throw new Error("UMAIL_OPERATOR_EMAIL is not a valid email address.");
    }
    const operatorEmail = operatorEmailParsed.address;
    const operatorId = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Config.string("AUTH_OPERATOR_ID")
      : "plan";
    const authInstance = yield* BetterAuth({
      ...makeAuthOptions(site, operatorId, { rateLimit: true }),
      migrate: false,
    });
    const accountId = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Config.string("CLOUDFLARE_ACCOUNT_ID")
      : "plan";
    const htmlPolicy = createMailHtmlPolicy();
    const notificationSecret = yield* Config.redacted("UMAIL_NOTIFICATION_KEY");
    const notificationKeyring = notificationKeyringFromSecret(Redacted.value(notificationSecret));
    const depsWithoutAccount = {
      archive: {
        get: (key: string) =>
          archive.get(key).pipe(
            Effect.flatMap((object) => {
              if (object === null) return Effect.succeed(null);
              return object.bytes();
            }),
            Effect.mapError(() => new ArchiveTransportError({ key })),
          ) as Effect.Effect<Uint8Array | null, ArchiveTransportError>,
      },
      destinations: cloudflareDestinationsClient({
        token: routingToken,
        accountId,
      }),
      htmlPolicy,
      mailDomain,
      applicationUrl,
      operatorId,
      approvalAdminEmail: operatorEmail,
      approvalClock: { now: DateTime.now },
      notification: {
        keyring: notificationKeyring,
        nextToken: generateApprovalToken,
      },
    };

    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const account = accounts.getByName(operatorId);
          const auth = asUmailBetterAuth(yield* authInstance.auth);
          const authDatabase = yield* authDb.raw;
          const handle = yield* makeApiHttpEffect({
            ...depsWithoutAccount,
            account,
            auth,
            authDatabase: authDatabase as AuthControlDatabase,
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
        Cloudflare.R2.ReadBucketBinding,
        AccountStoreLive,
      ),
    ),
  ),
);
