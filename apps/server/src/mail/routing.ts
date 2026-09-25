import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Input } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { stageSendsMail, type StageSite } from "../site.ts";

const EmailRoutingDomainTypeId = "uMail.Email.RoutingDomain" as const;
type EmailRoutingDomainTypeId = typeof EmailRoutingDomainTypeId;

export interface EmailRoutingDomainProps {
  readonly zoneId: string;
  readonly name: string;
}

export type EmailRoutingDomain = AlchemyResource<
  EmailRoutingDomainTypeId,
  EmailRoutingDomainProps,
  EmailRoutingDomainProps
>;

export const EmailRoutingDomain = Resource<EmailRoutingDomain>(EmailRoutingDomainTypeId);

export class EmailRoutingDomainNotReady extends Data.TaggedError("EmailRoutingDomainNotReady")<{
  readonly zoneId: string;
  readonly name: string;
  readonly message: string;
}> {}

// The zone apex reports readiness in its routing settings. A subdomain is ready
// once Cloudflare lists no missing DNS records for it.
const inspect = Effect.fn("inspectEmailRoutingDomain")(function* ({
  zoneId,
  name,
}: EmailRoutingDomainProps) {
  const settings = yield* emailRouting.getEmailRouting({ zoneId });
  if (settings.name === name) {
    return { apex: true, ready: settings.enabled && settings.status === "ready" };
  }
  const dns = yield* emailRouting.getDns({ zoneId, subdomain: name });
  return { apex: false, ready: (dns.errors ?? []).length === 0 };
});

function waitUntilReady(domain: EmailRoutingDomainProps) {
  return inspect(domain).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: ({ ready }) => ready,
      times: 12,
    }),
    Effect.flatMap(({ ready }) =>
      ready
        ? Effect.void
        : Effect.fail(
            new EmailRoutingDomainNotReady({
              ...domain,
              message: `Email Routing DNS for ${domain.name} did not become ready in time.`,
            }),
          ),
    ),
  );
}

// A ready registration is adopted as is; one that is not ready is created.
export const readEmailRoutingDomain = Effect.fn("readEmailRoutingDomain")(function* (
  domain: EmailRoutingDomainProps,
) {
  const { ready } = yield* inspect(domain);
  return ready ? { zoneId: domain.zoneId, name: domain.name } : undefined;
});

export const diffEmailRoutingDomain = Effect.fn("diffEmailRoutingDomain")(function* (
  olds: EmailRoutingDomainProps,
  news: EmailRoutingDomainProps,
  output: EmailRoutingDomainProps | undefined,
) {
  if (olds.zoneId !== news.zoneId || olds.name !== news.name) {
    return { action: "replace" } as const;
  }
  if (output === undefined) return undefined;
  const { ready } = yield* inspect(news);
  return ready ? undefined : ({ action: "update" } as const);
});

export const reconcileEmailRoutingDomain = Effect.fn("reconcileEmailRoutingDomain")(function* (
  domain: EmailRoutingDomainProps,
) {
  const { zoneId, name } = domain;
  const { apex, ready } = yield* inspect(domain);
  if (!ready) {
    yield* emailRouting.createDns(apex ? { zoneId } : { zoneId, name });
    yield* waitUntilReady(domain);
  }
  return { zoneId, name };
});

export const EmailRoutingDomainProvider = Provider.succeed(EmailRoutingDomain, {
  stables: ["zoneId", "name"],
  diff: ({ olds, news, output }) =>
    isResolved(news) ? diffEmailRoutingDomain(olds, news, output) : Effect.void,
  read: ({ olds }) => readEmailRoutingDomain(olds),
  reconcile: ({ news }) => reconcileEmailRoutingDomain(news),
  // Destroying a stage leaves the zone's Email Routing DNS in place; other stages share it.
  delete: () => Effect.void,
});

export const configureMailRouting = Effect.fn("configureMailRouting")(function* (
  site: StageSite,
  stage: string,
  workerName: Input<string>,
) {
  const routing = yield* Cloudflare.Email.Routing("MailRouting", {
    zone: site.mailDomain,
  }).pipe(Alchemy.RemovalPolicy.retain());
  const routingDomain = yield* EmailRoutingDomain("MailRoutingDomain", {
    zoneId: routing.zoneId,
    name: site.mailDomain,
  });

  if (stageSendsMail(stage)) {
    yield* Cloudflare.Email.SendingSubdomain("MailSending", {
      zoneId: routingDomain.zoneId,
      name: site.mailDomain,
    });
  }
  if (site.kind === "prod") {
    yield* Cloudflare.Email.CatchAll("MailCatchAll", {
      zone: routingDomain.zoneId,
      actions: [{ type: "worker", value: [workerName] }],
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
        actions: [{ type: "worker", value: [workerName] }],
      });
    for (const localPart of site.testLocalParts) {
      yield* mailRule(localPart);
    }
  }
});
