import * as Alchemy from "alchemy";
import { betterAuth } from "better-auth";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as TestClock from "effect/testing/TestClock";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

import {
  ExternalMailAddress,
  MailDomain,
  MailboxAddress,
  OPERATOR_POLICY,
  type PrincipalPolicy,
} from "@umail/api-contract";
import type { MailHtmlPolicy } from "../../src/mail/html-policy.ts";
import type { CompleteAttemptOutcome } from "../../src/account/domain.ts";
import { runDueWork } from "../../src/account/due-work.ts";
import type { AccountStoreRpc } from "../../src/account/worker.ts";
import { makeApiHttpEffect, type ApiDeps, type MailArchiveReader } from "../../src/api/app.ts";
import { makeAccess, type Access } from "../../src/auth/access.ts";
import {
  asUmailBetterAuth,
  makeAuthOptions,
  mcpResourceUrl,
  restResourceUrl,
  type UmailBetterAuth,
} from "../../src/auth/options.ts";
import { provisionAuth } from "../../src/auth/provisioning.ts";
import { WebCrypto, webCrypto } from "../../src/crypto.ts";
import type { ProviderOutboundMail } from "../../src/mail/email-sender.ts";
import type { NotificationKey } from "../../src/mail/notifications.ts";
import { FaithfulMailHtmlPolicy, MemoryArchive, MemoryDestinations } from "./fakes.ts";
import { createMemoryAccount, type MemoryAccountSqliteStorage } from "./memory-account-store.ts";
import { MemoryD1, memoryQueryDatabase } from "./memory-d1.ts";

export const MAIL_DOMAIN = Schema.decodeSync(MailDomain)("umail.example.com");
export const FROM_ADDRESS = Schema.decodeSync(MailboxAddress)("inbox@umail.example.com");
export const PROBE_ADDRESS = Schema.decodeSync(MailboxAddress)("probe@umail.example.com");
export const OPERATOR_EMAIL = Schema.decodeSync(ExternalMailAddress)("approver@example.com");
export const OPERATOR_PASSWORD = "operator-passphrase";
export const APPLICATION_URL = new URL("https://umail.test");
export const APPLICATION_ORIGIN = APPLICATION_URL.origin;
export const TEST_SITE = { apiHostname: "umail.test" } as const;
export const AUTH_SECRET = "umail-test-better-auth-secret";
// What the Worker runtime provides: Crypto, and alchemy's RuntimeContext, which the in-memory fakes
// never read.
export const WorkerServices = Layer.merge(WebCrypto, Alchemy.RuntimeContext.phantom);

export function runInWorker<A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | Alchemy.RuntimeContext>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(WorkerServices)));
}

export const WORLD_START = DateTime.makeUnsafe("2026-08-28T10:00:00.000Z");
export { createMailHtmlPolicy } from "../../src/mail/html-policy.ts";

export type World = {
  readonly db: MemoryD1;
  readonly access: Access;
  readonly account: AccountStoreRpc;
  readonly accountStorage: MemoryAccountSqliteStorage;
  readonly archive: MemoryArchive;
  readonly destinations: MemoryDestinations;
  readonly htmlPolicy: FaithfulMailHtmlPolicy;
  // Every request's Clock. It starts at WORLD_START; tests move it with `setTime`.
  readonly clock: TestClock.TestClock;
  readonly setTime: (iso: string) => Effect.Effect<void>;
  // Runs an API operation directly, with the world's clock and the Worker's services.
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, Crypto.Crypto | Alchemy.RuntimeContext>,
  ) => Effect.Effect<A, E>;
  readonly notificationKey: NotificationKey;
  readonly deps: ApiDeps;
  readonly auth: UmailBetterAuth;
  readonly operatorId: string;
  readonly operatorEmail: ExternalMailAddress;
  readonly sessionCookie: string;
  readonly operatorAccessToken: string;
  readonly operatorRefreshToken: string;
  readonly operatorClientId: string;
  // For clients that take a fetch function, such as the MCP transport.
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly request: (input: string, init?: RequestInit) => Effect.Effect<Response>;
};

export const createWorld = Effect.fn("createWorld")(function* (
  settings: {
    readonly rateLimit?: boolean;
    readonly operatorEmail?: ExternalMailAddress;
    readonly archive?: MailArchiveReader;
    readonly htmlPolicy?: MailHtmlPolicy;
    // Replaces store methods seen by the API only; `world.account` stays the real store for seeding.
    readonly account?: Partial<AccountStoreRpc>;
    // Merged into every request fiber, e.g. a test Logger.
    readonly requestContext?: Context.Context<never>;
  } = {},
) {
  const db = new MemoryD1();
  const memoryAccount = createMemoryAccount();
  const operatorEmail = settings.operatorEmail ?? OPERATOR_EMAIL;
  const provision = yield* provisionAuth(memoryQueryDatabase(db), {
    identity: { databaseId: "test-auth" },
    runNonce: "test-world",
    operatorEmail,
    restResource: restResourceUrl(TEST_SITE),
    mcpResource: mcpResourceUrl(TEST_SITE),
    password: OPERATOR_PASSWORD,
  }).pipe(Effect.provide(WorkerServices));
  const auth = asUmailBetterAuth(
    betterAuth({
      ...makeAuthOptions(TEST_SITE, provision.operatorId, {
        rateLimit: settings.rateLimit ?? false,
      }),
      database: db,
      secret: AUTH_SECRET,
    }),
  );
  const archive = new MemoryArchive();
  const destinations = new MemoryDestinations();
  const htmlPolicy = new FaithfulMailHtmlPolicy();
  const notificationKey = new Uint8Array(yield* webCrypto.randomBytes(32).pipe(Effect.orDie));
  const access = makeAccess(memoryQueryDatabase(db), provision.operatorId);
  const runtime = yield* Effect.gen(function* () {
    const deps = {
      account: { ...memoryAccount.account, ...settings.account },
      archive: settings.archive ?? archive,
      destinations,
      htmlPolicy: settings.htmlPolicy ?? htmlPolicy,
      mailDomain: MAIL_DOMAIN,
      auth: { auth: Effect.succeed(auth) },
      access,
      applicationUrl: APPLICATION_URL,
      operatorId: provision.operatorId,
      notificationKey: Effect.succeed(notificationKey),
    } satisfies ApiDeps;
    const clock = yield* TestClock.make();
    yield* clock.setTime(DateTime.toEpochMillis(WORLD_START));
    // The router keeps the services it was built with, so it is built on the world's clock.
    const handler = HttpEffect.toWebHandler(
      (yield* makeApiHttpEffect(deps).pipe(Effect.provideService(Clock.Clock, clock))).pipe(
        Effect.provide(Alchemy.RuntimeContext.phantom),
      ),
    );
    return { deps, handler, clock };
  }).pipe(Effect.provide(Reactivity.layer), Effect.scoped);
  const clock = runtime.clock;
  const setTime = (iso: string) => clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));
  const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Alchemy.RuntimeContext>) =>
    effect.pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(WorkerServices));
  const requestContext = Context.add(
    settings.requestContext ?? Context.empty(),
    Clock.Clock,
    clock,
  );

  const dispatch = (request: Request) => runtime.handler(request, requestContext);
  const fetchWorld = (input: string, init?: RequestInit) => dispatch(new Request(input, init));
  const request = (input: string, init?: RequestInit) =>
    Effect.promise(() => fetchWorld(input, init));

  const operator = yield* bootstrapOperator(request, operatorEmail);

  return {
    db,
    access,
    account: memoryAccount.account,
    accountStorage: memoryAccount.storage,
    archive,
    destinations,
    htmlPolicy,
    clock,
    setTime,
    run,
    notificationKey,
    deps: runtime.deps,
    auth,
    operatorId: provision.operatorId,
    operatorEmail,
    sessionCookie: operator.sessionCookie,
    operatorAccessToken: operator.accessToken,
    operatorRefreshToken: operator.refreshToken,
    operatorClientId: operator.clientId,
    fetch: fetchWorld,
    request,
  } satisfies World;
});

// A JSON request body.
export const jsonBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function readJson(response: Response) {
  return Effect.promise(() => response.json());
}

export function readText(response: Response) {
  return Effect.promise(() => response.text());
}

export function authorized(world: World): RequestInit {
  return { headers: { authorization: `Bearer ${world.operatorAccessToken}` } };
}

export function authorizedAs(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

export function unauthorized(): RequestInit {
  return { headers: { authorization: "Bearer not-a-valid-credential" } };
}

export function jsonHeaders(headers: RequestInit["headers"]): Headers {
  const value = new Headers(headers);
  value.set("content-type", "application/json");
  return value;
}

export function operatorCookieHeaders(
  sessionCookie: string,
  extra: Record<string, string> = {},
): Headers {
  const headers = new Headers(extra);
  headers.set("cookie", sessionCookie);
  headers.set("origin", APPLICATION_ORIGIN);
  return headers;
}

const bootstrapOperator = Effect.fn("bootstrapOperator")(function* (
  request: (input: string, init?: RequestInit) => Effect.Effect<Response>,
  operatorEmail: ExternalMailAddress,
) {
  const signIn = yield* request("http://umail.test/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody({
      email: operatorEmail,
      password: OPERATOR_PASSWORD,
    }),
  });
  if (!signIn.ok) {
    return yield* Effect.die(
      `operator sign-in failed: ${signIn.status} ${yield* readText(signIn)}`,
    );
  }
  const sessionCookie = responseCookie(signIn);
  if (sessionCookie === null) {
    return yield* Effect.die("operator sign-in did not return a browser session cookie");
  }

  const cli = { client_id: "umail-cli" };
  const device = yield* request("http://umail.test/api/auth/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cli.client_id,
      scope: "umail:access offline_access",
      resource: "https://umail.test",
    }).toString(),
  });
  if (!device.ok) {
    return yield* Effect.die(
      `device authorization failed: ${device.status} ${yield* readText(device)}`,
    );
  }
  const codes = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ device_code: Schema.String, user_code: Schema.String }),
  )(yield* readJson(device)).pipe(Effect.orDie);
  const approval = yield* request("http://umail.test/device/approve", {
    method: "POST",
    headers: operatorCookieHeaders(sessionCookie, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams({ userCode: codes.user_code }).toString(),
  });
  if (!approval.ok) {
    return yield* Effect.die(
      `device approval failed: ${approval.status} ${yield* readText(approval)}`,
    );
  }
  const token = yield* request("http://umail.test/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codes.device_code,
      client_id: cli.client_id,
      resource: "https://umail.test",
    }).toString(),
  });
  if (!token.ok) {
    return yield* Effect.die(
      `device token exchange failed: ${token.status} ${yield* readText(token)}`,
    );
  }
  const tokens = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
  )(yield* readJson(token)).pipe(Effect.orDie);
  return {
    sessionCookie,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId: cli.client_id,
  };
});

// Runs the store's due-work pass, as its alarm would, through a fake provider. Returns the mail sent.
// MCP requesters get `mcpPolicy` when given, else their consent's policy.
export const runDueWorkPass = Effect.fn("runDueWorkPass")(function* (
  world: World,
  options: {
    readonly at?: string;
    readonly outcome?: CompleteAttemptOutcome;
    readonly mcpPolicy?: PrincipalPolicy;
  } = {},
) {
  const mails: Array<ProviderOutboundMail> = [];
  const nowMs =
    options.at === undefined
      ? yield* world.clock.currentTimeMillis
      : DateTime.toEpochMillis(DateTime.makeUnsafe(options.at));
  yield* runDueWork(
    world.accountStorage,
    {
      sender: {
        send: (mail) =>
          Effect.sync(() => {
            mails.push(mail);
            return (
              options.outcome ?? {
                kind: "accepted",
                providerMessageId: `provider-${mails.length}`,
                rfcMessageId: null,
              }
            );
          }),
      },
      htmlPolicy: world.htmlPolicy,
      applicationUrl: APPLICATION_URL,
      notification: {
        key: Effect.succeed(world.notificationKey),
        mailDomain: MAIL_DOMAIN,
        approvalAdminEmail: world.operatorEmail,
      },
      policyFor: (requester) =>
        requester.kind === "operator"
          ? Effect.succeed(OPERATOR_POLICY)
          : options.mcpPolicy === undefined
            ? world.access.mcpPolicy(requester.clientId)
            : Effect.succeed(options.mcpPolicy),
      index: { send: () => Effect.void },
    },
    nowMs,
  ).pipe(Effect.provide(WorkerServices));
  return mails;
});

export function listMcpPolicyRows(world: World) {
  return Effect.promise(() =>
    world.db.all("SELECT consentId, policy FROM mcpPolicy ORDER BY consentId"),
  );
}

export const seedMailbox = Effect.fn("seedMailbox")(function* (
  world: World,
  localPart = "inbox",
  displayName = localPart === "inbox" ? "Inbox" : "Probe",
) {
  const now = "2026-01-01T00:00:00.000Z";
  const address = yield* world.account
    .createAddress(localPart, MAIL_DOMAIN, displayName, now)
    .pipe(Effect.orDie);
  if (address === null) {
    return yield* Effect.die(`Could not create mailbox ${localPart}`);
  }
  return address;
});

type InboundMessageSeed = {
  readonly id?: string;
  readonly htmlBody?: string | null;
  readonly occurredAt?: string;
  readonly parsedDate?: string | null;
  readonly subject?: string;
  readonly textBody?: string | null;
  readonly from?: string;
  readonly to?: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly rfcMessageId?: string | null;
  readonly inReplyToHeader?: string | null;
  readonly attachments?: Parameters<AccountStoreRpc["acceptInbound"]>[0]["attachments"];
  readonly envelopeFrom?: string;
  readonly envelopeTo?: string;
  readonly forward?: Parameters<AccountStoreRpc["observeInboundForward"]>[0]["observation"];
};

export const seedInboundMessage = Effect.fn("seedInboundMessage")(function* (
  world: World,
  mailboxId: string,
  seed: InboundMessageSeed = {},
) {
  const id = seed.id ?? "message-1";
  const now =
    seed.occurredAt ??
    (id === "message-text" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z");
  const decodeAddresses = Schema.decodeEffect(Schema.Array(ExternalMailAddress));
  const fromAddress = yield* Schema.decodeEffect(ExternalMailAddress)(
    seed.from ?? "sender@example.com",
  ).pipe(Effect.orDie);
  const toAddresses = yield* decodeAddresses(seed.to ?? [FROM_ADDRESS]).pipe(Effect.orDie);
  const ccAddresses = yield* decodeAddresses(seed.cc ?? []).pipe(Effect.orDie);
  const input: Parameters<AccountStoreRpc["acceptInbound"]>[0] = {
    messageId: id,
    mailboxId,
    rfcMessageId: seed.rfcMessageId === undefined ? `<${id}@example.com>` : seed.rfcMessageId,
    inReplyToHeader: seed.inReplyToHeader === undefined ? null : seed.inReplyToHeader,
    referencesHeader: null,
    occurredAt: now,
    nowIso: now,
    parsedDate: seed.parsedDate ?? null,
    subject: seed.subject ?? `Subject ${id}`,
    textBody: seed.textBody === undefined ? "text" : seed.textBody,
    htmlBody: seed.htmlBody === undefined ? null : seed.htmlBody,
    hasRemoteImages: false,
    from: [{ address: fromAddress, displayName: null }],
    replyTo: [{ address: fromAddress, displayName: null }],
    to: toAddresses.map((address) => ({ address, displayName: null })),
    cc: ccAddresses.map((address) => ({ address, displayName: null })),
  };
  yield* world.account
    .registerInboundReceipt({
      receiptId: id,
      envelopeFrom: seed.envelopeFrom ?? seed.from ?? "sender@example.com",
      envelopeTo: seed.envelopeTo ?? FROM_ADDRESS,
      rawKey: `raw/${id}`,
      receivedAt: now,
    })
    .pipe(Effect.orDie);
  if (seed.forward !== undefined) {
    yield* world.account
      .observeInboundForward({ receiptId: id, observation: seed.forward })
      .pipe(Effect.orDie);
  }
  const accepted = yield* world.account
    .acceptInbound(
      seed.attachments === undefined ? input : { ...input, attachments: seed.attachments },
    )
    .pipe(Effect.orDie);
  if (accepted === null) {
    return yield* Effect.die(`Seeded receipt ${id} was already settled`);
  }
  return accepted;
});

function responseCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) return null;
  const cookie = setCookie.split(";", 1)[0]?.trim();
  return cookie === undefined || cookie.length === 0 ? null : cookie;
}
