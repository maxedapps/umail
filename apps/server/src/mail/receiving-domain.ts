import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { UserFacingError } from "alchemy/UserFacingError";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const EmailRoutingDomainTypeId = "uMail.Email.RoutingDomain" as const;
type EmailRoutingDomainTypeId = typeof EmailRoutingDomainTypeId;

interface EmailRoutingDomainProps {
  readonly zoneId: string;
  readonly name: string;
}

export type EmailRoutingDomain = AlchemyResource<
  EmailRoutingDomainTypeId,
  EmailRoutingDomainProps,
  EmailRoutingDomainProps
>;

export const EmailRoutingDomain = Resource<EmailRoutingDomain>(EmailRoutingDomainTypeId);

export class ReceivingDomainUnsafe extends Data.TaggedError("ReceivingDomainUnsafe")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

const READY_POLLS = 12;
const READY_POLL_INTERVAL = "5 seconds";

// alchemy prints a UserFacingError as one line, so the deploy says which records to look at.
export class EmailRoutingDomainNotReady extends Data.TaggedError("EmailRoutingDomainNotReady")<{
  readonly zoneId: string;
  readonly name: string;
  readonly missing: ReadonlyArray<string>;
}> {
  readonly [UserFacingError] = true;
  override readonly message = `Email Routing DNS for ${this.name} is not ready after 60 s.${
    this.missing.length === 0 ? "" : ` Missing: ${this.missing.join("; ")}.`
  } Check for conflicting MX/TXT records.`;
}

// A DNS record Email Routing still needs on a subdomain.
const MissingRecord = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(Schema.NullOr(Schema.Finite)),
});

// `getDns` with `subdomain` answers `{ errors, record }` rather than the zone's record list the SDK
// types. Cloudflare deprecated the parameter but offers no other subdomain check, so it is decoded here.
const SubdomainDns = Schema.Struct({
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          code: Schema.optional(Schema.NullOr(Schema.String)),
          missing: Schema.optional(Schema.NullOr(MissingRecord)),
        }),
      ),
    ),
  ),
});

// The zone apex reports readiness in its routing settings. A subdomain is ready once Cloudflare
// lists no missing DNS records for it; the ones it lists are what a stuck deploy reports.
const inspect = Effect.fn("inspectEmailRoutingDomain")(function* ({
  zoneId,
  name,
}: EmailRoutingDomainProps) {
  const settings = yield* emailRouting.getEmailRouting({ zoneId });
  if (settings.name === name) {
    return { apex: true, ready: settings.enabled && settings.status === "ready", missing: [] };
  }
  const dns = yield* Schema.decodeUnknownEffect(SubdomainDns)(
    yield* emailRouting.getDns({ zoneId, subdomain: name }),
  );
  const missing = (dns.errors ?? []).map(({ code, missing }) =>
    missing === null || missing === undefined ? (code ?? "unknown") : describeRecord(missing),
  );
  return { apex: false, ready: settings.enabled === true && missing.length === 0, missing };
});

// "MX mail.example.com → route1.mx.cloudflare.net (priority 1)"
function describeRecord(record: typeof MissingRecord.Type): string {
  const priority =
    record.priority === null || record.priority === undefined
      ? ""
      : ` (priority ${record.priority})`;
  return `${record.type ?? "?"} ${record.name ?? "?"} → ${record.content ?? "?"}${priority}`;
}

function waitUntilReady(domain: EmailRoutingDomainProps, session: ScopedPlanStatusSession) {
  return inspect(domain).pipe(
    Effect.tap(({ ready, missing }) =>
      ready ? Effect.void : session.note(`waiting for Email Routing DNS: ${missing.join("; ")}`),
    ),
    Effect.repeat({
      schedule: Schedule.spaced(READY_POLL_INTERVAL),
      until: ({ ready }) => ready,
      times: READY_POLLS,
    }),
    Effect.flatMap(({ ready, missing }) =>
      ready ? Effect.void : Effect.fail(new EmailRoutingDomainNotReady({ ...domain, missing })),
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
  session: ScopedPlanStatusSession,
) {
  const { zoneId, name } = domain;
  const { apex, ready } = yield* inspect(domain);
  if (!ready) {
    if (apex)
      return yield* new ReceivingDomainUnsafe({
        message: `Receiving domain ${name} is not ready. umail never enables or repairs apex mail.`,
      });
    yield* requireReceivingFoundation(zoneId, name);
    yield* emailRouting.createDns({ zoneId, name });
    yield* waitUntilReady(domain, session);
  }
  return { zoneId, name };
});

// The pinned SDK omits the supported name on DELETE. A named request removes only that child.
// Never issue an unnamed DELETE: that disables the whole zone.
export const deleteEmailRoutingDomain = Effect.fn("deleteEmailRoutingDomain")(function* ({
  zoneId,
  name,
}: EmailRoutingDomainProps) {
  const settings = yield* emailRouting.getEmailRouting({ zoneId });
  if (settings.name === name || !name.endsWith(`.${settings.name}`)) {
    return yield* new ReceivingDomainUnsafe({
      message: `Refusing to remove apex or foreign receiving domain ${name}.`,
    });
  }
  const credentials = yield* yield* Credentials;
  const request = yield* HttpClientRequest.delete(
    `${credentials.apiBaseUrl}/zones/${zoneId}/email/routing/dns`,
  ).pipe(
    HttpClientRequest.setHeaders(formatHeaders(credentials)),
    HttpClientRequest.bodyJson({ name }),
  );
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request);
  const result = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Boolean,
      errors: Schema.Array(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
    }),
  )(yield* response.json);
  if (
    !result.success &&
    !(result.errors.length > 0 && result.errors.every(({ code }) => code === 2033))
  ) {
    return yield* new ReceivingDomainUnsafe({
      message: `Cannot remove receiving domain ${name}: ${result.errors.map(({ message }) => message).join("; ")}.`,
    });
  }
});

export const EmailRoutingDomainProvider = Provider.succeed(EmailRoutingDomain, {
  stables: ["zoneId", "name"],
  diff: ({ olds, news, output }) =>
    isResolved(news) ? diffEmailRoutingDomain(olds, news, output) : Effect.void,
  read: ({ olds }) => readEmailRoutingDomain(olds),
  reconcile: ({ news, session }) => reconcileEmailRoutingDomain(news, session),
  delete: ({ output }) => deleteEmailRoutingDomain(output),
});

// Child onboarding itself enables the zone and creates shared DKIM if missing. Require those
// to exist first so a deploy cannot change shared mail configuration as a side effect.
export const requireReceivingFoundation = Effect.fn("requireReceivingFoundation")(function* (
  zoneId: string,
  name: string,
) {
  const settings = yield* emailRouting.getEmailRouting({ zoneId });
  if (!settings.enabled || !name.endsWith(`.${settings.name}`)) {
    return yield* new ReceivingDomainUnsafe({
      message: `Receiving domain ${name} requires an already enabled Email Routing zone. Set up the shared zone foundation separately; umail will not enable it.`,
    });
  }
  const expected = yield* emailRouting.getDns({ zoneId });
  const selectors = expected.filter(
    (record) => record.type === "TXT" && record.name?.endsWith(`._domainkey.${settings.name}`),
  );
  if (selectors.length === 0)
    return yield* new ReceivingDomainUnsafe({
      message: `Cannot verify the shared Email Routing DKIM foundation for ${name}.`,
    });
  for (const selector of selectors) {
    const records = yield* dns.listRecords({
      zoneId,
      name: { exact: selector.name! },
      type: "TXT",
    });
    const canonical = (value: string) => value.replace(/[\s"]/g, "");
    if (
      records.result.length !== 1 ||
      canonical(records.result[0]?.content ?? "") !== canonical(selector.content ?? "")
    ) {
      return yield* new ReceivingDomainUnsafe({
        message: `Receiving domain ${name} requires the existing Cloudflare shared DKIM record ${selector.name}; umail will not create or replace shared DNS.`,
      });
    }
  }
});
