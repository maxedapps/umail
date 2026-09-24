import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Input } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved, type Diff } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import {
  EmailRoutingDomainsApi,
  type EmailRoutingDomainApiError,
  type EmailRoutingDomainIdentity,
  type EmailRoutingDomainInspection,
  type EmailRoutingDomainRegistration,
  type EmailRoutingDomainsApiService,
  type EmailRoutingDomainStatus,
} from "./routing-api.ts";

import { stageSendsMail, type StageSite } from "../site.ts";

const EmailRoutingDomainTypeId = "uMail.Email.RoutingDomain" as const;
type EmailRoutingDomainTypeId = typeof EmailRoutingDomainTypeId;

export interface EmailRoutingDomainProps extends EmailRoutingDomainIdentity {}

export interface EmailRoutingDomainAttributes extends EmailRoutingDomainRegistration {
  readonly apexEnabled: boolean;
}

export type EmailRoutingDomain = AlchemyResource<
  EmailRoutingDomainTypeId,
  EmailRoutingDomainProps,
  EmailRoutingDomainAttributes
>;

export const EmailRoutingDomain = Resource<EmailRoutingDomain>(EmailRoutingDomainTypeId);

export class EmailRoutingDomainNotReady extends Data.TaggedError("EmailRoutingDomainNotReady")<{
  readonly zoneId: string;
  readonly name: string;
  readonly message: string;
}> {}

export interface EmailRoutingDomainLifecycle {
  read(
    props: EmailRoutingDomainProps,
    output: EmailRoutingDomainAttributes | undefined,
  ): Effect.Effect<EmailRoutingDomainAttributes | undefined, EmailRoutingDomainApiError>;
  diff(
    olds: EmailRoutingDomainProps,
    news: EmailRoutingDomainProps,
    output: EmailRoutingDomainAttributes | undefined,
  ): Effect.Effect<Diff | void, EmailRoutingDomainApiError>;
  reconcile(
    props: EmailRoutingDomainProps,
  ): Effect.Effect<
    EmailRoutingDomainAttributes,
    EmailRoutingDomainApiError | EmailRoutingDomainNotReady
  >;
}

function isApex(inspection: EmailRoutingDomainInspection, identity: EmailRoutingDomainIdentity) {
  return identity.name === inspection.zoneName;
}

function isReady(inspection: EmailRoutingDomainInspection) {
  return (
    inspection.apexEnabled &&
    inspection.exact?.enabled === true &&
    inspection.exact.status === "ready" &&
    inspection.exact.dnsReady
  );
}

function toAttributes(
  inspection: EmailRoutingDomainInspection,
): EmailRoutingDomainAttributes | undefined {
  const exact = inspection.exact;
  if (exact === undefined) return undefined;
  return {
    ...exact,
    apexEnabled: inspection.apexEnabled,
  };
}

function notReadyError(identity: EmailRoutingDomainIdentity) {
  return new EmailRoutingDomainNotReady({
    ...identity,
    message: `Email Routing DNS for ${identity.name} did not become ready in time.`,
  });
}

function waitUntilReady(
  api: EmailRoutingDomainsApiService,
  identity: EmailRoutingDomainIdentity,
): Effect.Effect<
  EmailRoutingDomainInspection,
  EmailRoutingDomainApiError | EmailRoutingDomainNotReady
> {
  return api.inspect(identity).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: isReady,
      times: 12,
    }),
    Effect.flatMap((inspection) =>
      isReady(inspection) ? Effect.succeed(inspection) : Effect.fail(notReadyError(identity)),
    ),
  );
}

export function makeEmailRoutingDomainLifecycle(
  api: EmailRoutingDomainsApiService,
): EmailRoutingDomainLifecycle {
  return {
    read: (props, output) =>
      api.inspect(props).pipe(
        Effect.map(toAttributes),
        Effect.map((attributes) =>
          attributes === undefined || output !== undefined ? attributes : Unowned(attributes),
        ),
      ),
    diff: (olds, news, output) => {
      if (olds.zoneId !== news.zoneId || olds.name !== news.name) {
        return Effect.succeed({ action: "replace" } as const);
      }
      if (output === undefined) return Effect.void;
      return api.inspect(news).pipe(
        Effect.map((inspection) => {
          const exact = inspection.exact;
          return isReady(inspection) && exact?.subdomainId === output.subdomainId
            ? undefined
            : ({ action: "update" } as const);
        }),
      );
    },
    reconcile: (props) =>
      Effect.gen(function* () {
        const inspection = yield* api.inspect(props);
        if (isReady(inspection)) {
          const attributes = toAttributes(inspection);
          if (attributes !== undefined) return attributes;
        }
        if (isApex(inspection, props)) {
          yield* api.enableApex(props);
        } else {
          yield* api.enable(props);
        }
        const ready = yield* waitUntilReady(api, props);
        const attributes = toAttributes(ready);
        if (attributes === undefined) return yield* notReadyError(props);
        return attributes;
      }),
  };
}

export const EmailRoutingDomainProvider = Provider.succeed(EmailRoutingDomain, {
  stables: ["zoneId", "name"],
  diff: Effect.fn(function* ({ olds, news, output }) {
    if (!isResolved(news)) return undefined;
    const api = yield* EmailRoutingDomainsApi;
    return yield* makeEmailRoutingDomainLifecycle(api).diff(olds, news, output);
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const api = yield* EmailRoutingDomainsApi;
    return yield* makeEmailRoutingDomainLifecycle(api).read(olds, output);
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const api = yield* EmailRoutingDomainsApi;
    return yield* makeEmailRoutingDomainLifecycle(api).reconcile(news);
  }),
  // Never runs: MailRoutingDomain is retained. Alchemy still requires a delete handler.
  delete: () => Effect.void,
});

export type { EmailRoutingDomainStatus };

export const configureMailRouting = Effect.fn(function* (
  site: StageSite,
  stage: string,
  inboundWorkerName: Input<string>,
) {
  const routing = yield* Cloudflare.Email.Routing("MailRouting", {
    zone: site.mailDomain,
  }).pipe(Alchemy.RemovalPolicy.retain());
  const routingDomain = yield* EmailRoutingDomain("MailRoutingDomain", {
    zoneId: routing.zoneId,
    name: site.mailDomain,
  }).pipe(Alchemy.AdoptPolicy.adopt(), Alchemy.RemovalPolicy.retain());

  if (stageSendsMail(stage)) {
    yield* Cloudflare.Email.SendingSubdomain("MailSending", {
      zoneId: routingDomain.zoneId,
      name: site.mailDomain,
    });
  }
  if (site.kind === "prod") {
    yield* Cloudflare.Email.CatchAll("MailCatchAll", {
      zone: routingDomain.zoneId,
      actions: [{ type: "worker", value: [inboundWorkerName] }],
    });
  } else {
    const mailRule = (localPart: (typeof site.testLocalParts)[number]) =>
      Cloudflare.Email.Rule(`Mail_${localPart}`, {
        zone: routingDomain.zoneId,
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `${localPart}@${site.mailDomain}`,
          },
        ],
        actions: [{ type: "worker", value: [inboundWorkerName] }],
      });
    for (const localPart of site.testLocalParts) {
      yield* mailRule(localPart);
    }
  }
});
