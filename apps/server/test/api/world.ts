import { betterAuth } from "better-auth";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

import { ExternalMailAddress, MailDomain, MailboxAddress } from "@umail/api-contract";
import type { MailHtmlPolicy } from "@umail/mail-content";
import type { AccountStoreRpc } from "../../src/account/worker.ts";
import { makeApiHttpEffect, type ApiDeps, type MailArchiveReader } from "../../src/api/app.ts";
import type { AuthControlDatabase } from "../../src/auth/auth-control.ts";
import {
  asUmailBetterAuth,
  makeAuthOptions,
  mcpResourceUrl,
  restResourceUrl,
  type UmailBetterAuth,
} from "../../src/auth/options.ts";
import { provisionAuth, type AuthD1Database } from "../../src/auth/provisioning.ts";
import type { NotificationKey } from "../../src/mail/notifications.ts";
import {
  FaithfulMailHtmlPolicy,
  MemoryArchive,
  MemoryApprovalClock,
  MemoryDestinations,
} from "./fakes.ts";
import { createMemoryAccount, type MemoryAccountSqliteStorage } from "./memory-account-store.ts";
import { MemoryD1 } from "./memory-d1.ts";

export const MAIL_DOMAIN = Schema.decodeSync(MailDomain)("umail.example.com");
export const FROM_ADDRESS = Schema.decodeSync(MailboxAddress)("inbox@umail.example.com");
export const PROBE_ADDRESS = Schema.decodeSync(MailboxAddress)("probe@umail.example.com");
export const OPERATOR_EMAIL = Schema.decodeSync(ExternalMailAddress)("approver@example.com");
export const OPERATOR_PASSWORD = "operator-passphrase";
export const APPLICATION_URL = new URL("https://umail.test");
export const APPLICATION_ORIGIN = APPLICATION_URL.origin;
export const TEST_SITE = { apiHostname: "umail.test" } as const;
export const AUTH_SECRET = "umail-test-better-auth-secret";
export { createMailHtmlPolicy } from "@umail/mail-content";

export type World = {
  readonly db: MemoryD1;
  readonly account: AccountStoreRpc;
  readonly accountStorage: MemoryAccountSqliteStorage;
  readonly archive: MemoryArchive;
  readonly destinations: MemoryDestinations;
  readonly htmlPolicy: FaithfulMailHtmlPolicy;
  readonly approvalClock: MemoryApprovalClock;
  readonly notificationKey: NotificationKey;
  readonly deps: ApiDeps;
  readonly auth: UmailBetterAuth;
  readonly operatorId: string;
  readonly operatorEmail: ExternalMailAddress;
  readonly sessionCookie: string;
  readonly operatorAccessToken: string;
  readonly operatorRefreshToken: string;
  readonly operatorClientId: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export async function createWorld(
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
): Promise<World> {
  const db = new MemoryD1();
  const memoryAccount = createMemoryAccount();
  const operatorEmail = settings.operatorEmail ?? OPERATOR_EMAIL;
  const authDatabase = db as AuthD1Database & AuthControlDatabase;
  const provision = await provisionAuth(authDatabase, {
    identity: { databaseId: "test-auth" },
    runNonce: crypto.randomUUID(),
    operatorEmail,
    restResource: restResourceUrl(TEST_SITE),
    mcpResource: mcpResourceUrl(TEST_SITE),
    password: OPERATOR_PASSWORD,
  });
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
  const approvalClock = new MemoryApprovalClock();
  const notificationKey = crypto.getRandomValues(new Uint8Array(32));
  const runtime = await Effect.runPromise(
    Effect.gen(function* () {
      const deps = {
        account: { ...memoryAccount.account, ...settings.account },
        archive: settings.archive ?? archive,
        destinations,
        htmlPolicy: settings.htmlPolicy ?? htmlPolicy,
        mailDomain: MAIL_DOMAIN,
        auth,
        authDatabase,
        applicationUrl: APPLICATION_URL,
        operatorId: provision.operatorId,
        approvalClock,
        notificationKey,
      } satisfies ApiDeps;
      const handler = HttpEffect.toWebHandler(yield* makeApiHttpEffect(deps));
      return { deps, handler };
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );

  const dispatch = (request: Request) => runtime.handler(request, settings.requestContext);
  const fetchWorld = (input: string, init?: RequestInit) => dispatch(new Request(input, init));

  const operator = await bootstrapOperator(fetchWorld, operatorEmail);

  return {
    db,
    account: memoryAccount.account,
    accountStorage: memoryAccount.storage,
    archive,
    destinations,
    htmlPolicy,
    approvalClock,
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
  };
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

async function bootstrapOperator(
  fetchWorld: (input: string, init?: RequestInit) => Promise<Response>,
  operatorEmail: ExternalMailAddress,
): Promise<{
  readonly sessionCookie: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly clientId: string;
}> {
  const signIn = await fetchWorld("http://umail.test/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: operatorEmail,
      password: OPERATOR_PASSWORD,
    }),
  });
  if (!signIn.ok) {
    throw new Error(`operator sign-in failed: ${signIn.status} ${await signIn.text()}`);
  }
  const sessionCookie = responseCookie(signIn);
  if (sessionCookie === null) {
    throw new Error("operator sign-in did not return a browser session cookie");
  }

  const registration = await fetchWorld("http://umail.test/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "uMail CLI test",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      subject_type: "public",
      dpop_bound_access_tokens: false,
      resources: ["https://umail.test"],
    }),
  });
  if (!registration.ok) {
    throw new Error(`CLI DCR failed: ${registration.status} ${await registration.text()}`);
  }
  const cli = Schema.decodeUnknownSync(
    Schema.Struct({ client_id: Schema.String, token_endpoint_auth_method: Schema.Literal("none") }),
  )(await registration.json());
  const device = await fetchWorld("http://umail.test/api/auth/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cli.client_id,
      scope: "umail:access offline_access",
      resource: "https://umail.test",
    }).toString(),
  });
  if (!device.ok) {
    throw new Error(`device authorization failed: ${device.status} ${await device.text()}`);
  }
  const codes = Schema.decodeUnknownSync(
    Schema.Struct({ device_code: Schema.String, user_code: Schema.String }),
  )(await device.json());
  const approval = await fetchWorld("http://umail.test/device/approve", {
    method: "POST",
    headers: operatorCookieHeaders(sessionCookie, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams({ userCode: codes.user_code }).toString(),
  });
  if (!approval.ok) {
    throw new Error(`device approval failed: ${approval.status} ${await approval.text()}`);
  }
  const token = await fetchWorld("http://umail.test/api/auth/oauth2/token", {
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
    throw new Error(`device token exchange failed: ${token.status} ${await token.text()}`);
  }
  const tokens = Schema.decodeUnknownSync(
    Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
  )(await token.json());
  return {
    sessionCookie,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId: cli.client_id,
  };
}

export async function listMcpPolicyRows(world: World) {
  const policies = await Effect.runPromise(world.account.listMcpOAuthPolicies());
  return policies.map((policy) => ({ client_id: policy.clientId, state: policy.state }));
}

export async function seedMailbox(
  world: World,
  localPart = "inbox",
  displayName = localPart === "inbox" ? "Inbox" : "Probe",
) {
  const now = "2026-01-01T00:00:00.000Z";
  const address = await Effect.runPromise(
    world.account.createAddress(localPart, MAIL_DOMAIN, displayName, now),
  );
  if (address === null) {
    throw new Error(`Could not create mailbox ${localPart}`);
  }
  return address;
}

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

export async function seedInboundMessage(
  world: World,
  mailboxId: string,
  seed: InboundMessageSeed = {},
) {
  const id = seed.id ?? "message-1";
  const now =
    seed.occurredAt ??
    (id === "message-text" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z");
  const fromAddress = Schema.decodeSync(ExternalMailAddress)(seed.from ?? "sender@example.com");
  const toAddresses = (seed.to ?? [FROM_ADDRESS]).map((address) =>
    Schema.decodeSync(ExternalMailAddress)(address),
  );
  const ccAddresses = (seed.cc ?? []).map((address) =>
    Schema.decodeSync(ExternalMailAddress)(address),
  );
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
  await Effect.runPromise(
    world.account.registerInboundReceipt({
      receiptId: id,
      envelopeFrom: seed.envelopeFrom ?? seed.from ?? "sender@example.com",
      envelopeTo: seed.envelopeTo ?? FROM_ADDRESS,
      rawKey: `raw/${id}`,
      receivedAt: now,
    }),
  );
  if (seed.forward !== undefined) {
    await Effect.runPromise(
      world.account.observeInboundForward({ receiptId: id, observation: seed.forward }),
    );
  }
  const accepted = await Effect.runPromise(
    world.account.acceptInbound(
      seed.attachments === undefined ? input : { ...input, attachments: seed.attachments },
    ),
  );
  if (accepted === null) {
    throw new Error(`Seeded receipt ${id} was already settled`);
  }
  return accepted;
}

function responseCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) return null;
  const cookie = setCookie.split(";", 1)[0]?.trim();
  return cookie === undefined || cookie.length === 0 ? null : cookie;
}
