import { AccountStoreUnexpectedError } from "../apps/server/src/account/errors.ts";
import {
  InboundReceipt,
  MessageBody,
  MessageSummary,
  StoredAttachment,
  type PutRecoveryScanInput,
} from "../apps/server/src/account/domain.ts";
import { applyAccountSchema } from "../apps/server/src/account/commands.ts";
import { type AccountSqliteStorage } from "../apps/server/src/account/sqlite.ts";
import { parseMailDomain, parseMailboxAddress } from "../packages/api-contract/src/index.ts";
import type {
  DurableObjectStorage,
  Queue,
  R2Bucket,
  R2ObjectBody,
} from "@cloudflare/workers-types";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AccountStore,
  makeAccountStoreRpc,
  type AccountStoreRpc,
} from "../apps/server/src/account/worker.ts";
import { Api } from "../apps/server/src/api/worker.ts";
import { handleRecoveryScheduled } from "../apps/server/src/mail/recovery.ts";
import {
  archiveInboundReceipt,
  ReceiptManifest,
  receiptManifestKey,
} from "../apps/server/src/mail/archive.ts";
import { DEFAULT_MAX_RAW_BYTES, sha256Hex } from "../apps/server/src/mail/policy.ts";
import { MailArchive } from "../apps/server/src/mail/archive.ts";
import { MailIndex } from "../apps/server/src/mail/indexing.ts";
import {
  MANIFEST_DISCOVERY_PAGE_SIZE,
  RECEIPT_RECOVERY_ATTEMPT_BUDGET,
  RECEIPT_RECOVERY_PAGE_SIZE,
} from "../apps/server/src/mail/recovery.ts";
import { ProvisionedOperator } from "../apps/server/src/auth/auth-control.ts";
import { seedDevelopmentAddresses } from "../apps/server/src/account/worker.ts";

const CAPACITY_MAIL_DOMAIN = "capacity.test";
const capacityMailbox = parseMailboxAddress(`inbox@${CAPACITY_MAIL_DOMAIN}`);
if (capacityMailbox.kind === "invalid") {
  throw new Error("Capacity mailbox is invalid.");
}
export const CAPACITY_MAILBOX = capacityMailbox.address;
const CAPACITY_RETRY_SCAN_ID = "capacity_retry_injection";
const CAPACITY_RETRY_STORAGE_KEY = "capacity/retry-injection";

const CapacityRetryInjection = Schema.Struct({
  receiptId: Schema.String,
  state: Schema.Literals(["armed", "injected"]),
});
type CapacityRetryInjection = typeof CapacityRetryInjection.Type;

export const CapacitySeedResponse = Schema.Struct({
  receiptId: Schema.String,
  digest: Schema.String,
  rawKey: Schema.String,
  manifestKey: Schema.String,
  queued: Schema.Boolean,
});
export type CapacitySeedResponse = typeof CapacitySeedResponse.Type;

const CapacityStoredAttachment = Schema.Struct({
  stored: StoredAttachment,
  object: Schema.Struct({
    key: Schema.String,
    size: Schema.Finite,
    sha256: Schema.String,
  }),
});

const CapacityArchiveObject = Schema.Struct({
  key: Schema.String,
  size: Schema.Finite,
});

export const CapacityStatusResponse = Schema.Struct({
  receipt: Schema.NullOr(InboundReceipt),
  manifest: Schema.NullOr(ReceiptManifest),
  summary: Schema.NullOr(MessageSummary),
  body: Schema.NullOr(MessageBody),
  attachments: Schema.Array(CapacityStoredAttachment),
  derivedObjects: Schema.Array(CapacityArchiveObject),
});
export type CapacityStatusResponse = typeof CapacityStatusResponse.Type;

export const CapacityEmptyResponse = Schema.Struct({
  deleted: Schema.Finite,
  remaining: Schema.Literal(0),
});
export type CapacityEmptyResponse = typeof CapacityEmptyResponse.Type;

export const CapacityErrorResponse = Schema.Struct({
  error: Schema.Literals([
    "body_required",
    "body_too_large",
    "capacity_request_failed",
    "invalid_request",
    "not_found",
    "unauthorized",
  ]),
});
export type CapacityErrorResponse = typeof CapacityErrorResponse.Type;

const capacityAccountStoreLive = AccountStore.make<never>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const storage = state.raw.storage;
      const accountId = state.raw.id.name;
      if (accountId === undefined) {
        throw new Error("Capacity AccountStore requires a named instance.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      applyAccountSchema(storage, { accountId, nowIso });
      const rpc = makeAccountStoreRpc(storage);
      const mailDomain = parseMailDomain(CAPACITY_MAIL_DOMAIN);
      if (mailDomain.kind !== "ok") {
        throw new Error("Capacity mail domain is invalid.");
      }
      yield* seedDevelopmentAddresses(rpc, {
        mailDomain: mailDomain.domain,
        localParts: ["inbox"],
        nowIso,
      }).pipe(Effect.orDie);
      return capacityAccountStoreRpc(storage, rpc);
    });
  }),
);

function capacityAccountStoreRpc(
  storage: AccountSqliteStorage & DurableObjectStorage,
  rpc: AccountStoreRpc,
): AccountStoreRpc {
  return {
    ...rpc,
    getInboundReceipt: (receiptId) =>
      Effect.gen(function* () {
        const stored = yield* Effect.promise(() => storage.get(CAPACITY_RETRY_STORAGE_KEY));
        const decoded = Schema.decodeUnknownResult(Schema.UndefinedOr(CapacityRetryInjection))(
          stored,
        );
        if (Result.isFailure(decoded)) {
          return yield* Effect.die(new Error("Capacity retry marker is invalid."));
        }
        const injection = decoded.success;
        if (
          injection !== undefined &&
          injection.receiptId === receiptId &&
          injection.state === "armed"
        ) {
          const injected = {
            receiptId,
            state: "injected",
          } as const satisfies CapacityRetryInjection;
          yield* Effect.promise(() => storage.put(CAPACITY_RETRY_STORAGE_KEY, injected));
          return yield* new AccountStoreUnexpectedError({ cause: "capacity_retry_once" });
        }
        return yield* rpc.getInboundReceipt(receiptId);
      }),
    putRecoveryScan: (input) =>
      input.scanId === CAPACITY_RETRY_SCAN_ID && input.cursor !== null
        ? armRetryInjection(storage, {
            scanId: input.scanId,
            cursor: input.cursor,
            updatedAt: input.updatedAt,
          })
        : rpc.putRecoveryScan(input),
  } satisfies AccountStoreRpc;
}

function armRetryInjection(
  storage: DurableObjectStorage,
  input: CapacityRetryArmInput,
): ReturnType<AccountStoreRpc["putRecoveryScan"]> {
  return Effect.gen(function* () {
    const injection = {
      receiptId: input.cursor,
      state: "armed",
    } as const satisfies CapacityRetryInjection;
    yield* Effect.promise(() => storage.put(CAPACITY_RETRY_STORAGE_KEY, injection));
    return {
      scanId: input.scanId,
      cursor: input.cursor,
      updatedAt: input.updatedAt,
    };
  });
}

type CapacityRetryArmInput = Omit<PutRecoveryScanInput, "cursor"> & {
  readonly cursor: string;
};

const capacityApiProps = Effect.gen(function* () {
  const operatorId = globalThis.__ALCHEMY_RUNTIME__
    ? yield* Config.string("AUTH_OPERATOR_ID")
    : (yield* ProvisionedOperator).operatorId;
  return {
    main: import.meta.url,
    workersDev: true,
    env: {
      AUTH_OPERATOR_ID: operatorId,
      UMAIL_MAIL_CAPACITY_CONTROL_TOKEN: Config.redacted("UMAIL_MAIL_CAPACITY_CONTROL_TOKEN"),
    },
  };
});

export default Api.make(
  capacityApiProps,
  Effect.gen(function* () {
    const accounts = yield* AccountStore.from(Api);
    const archiveClient = yield* Cloudflare.R2.ReadWriteBucket(MailArchive);
    const indexClient = yield* Cloudflare.Queues.WriteQueue(MailIndex);
    const controlToken = yield* Config.redacted("UMAIL_MAIL_CAPACITY_CONTROL_TOKEN");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = HttpServerRequest.toWebResult(request);
        if (Result.isFailure(webRequest)) {
          return HttpServerResponse.fromWeb(jsonResponse(400, { error: "invalid_request" }));
        }
        const authorized = yield* Effect.promise(() =>
          verifyControlToken(
            webRequest.success.headers.get("authorization"),
            Redacted.value(controlToken),
          ),
        );
        if (!authorized) {
          return HttpServerResponse.fromWeb(jsonResponse(401, { error: "unauthorized" }));
        }

        const archive = yield* archiveClient.raw;
        const index = yield* indexClient.raw;
        const accountId = yield* Config.string("AUTH_OPERATOR_ID");
        const account = accounts.getByName(accountId);
        const context = yield* Effect.context<Alchemy.RuntimeContext>();
        const runAccount = Effect.runPromiseWith(context);
        const response = yield* Effect.tryPromise({
          try: () =>
            handleCapacityRequest(webRequest.success, {
              archive,
              index,
              account,
              runAccount: (effect) => runAccount(effect),
            }),
          catch: (cause) => new CapacityRequestError({ cause }),
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed(jsonResponse(500, { error: "capacity_request_failed" })),
          ),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        capacityAccountStoreLive,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
      ),
    ),
  ),
);

type CapacityHostDependencies = {
  readonly archive: R2Bucket;
  readonly index: Queue;
  readonly account: AccountStoreRpc;
  readonly runAccount: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

async function handleCapacityRequest(
  request: Request,
  deps: CapacityHostDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/seed") {
    return seedCapacityMessage(request, url, deps);
  }
  if (request.method === "GET" && url.pathname.startsWith("/status/")) {
    return capacityStatus(decodeURIComponent(url.pathname.slice("/status/".length)), deps);
  }
  if (request.method === "POST" && url.pathname === "/recover") {
    await runCapacityRecovery(deps);
    return jsonResponse(202, { recovered: true });
  }
  if (request.method === "POST" && url.pathname === "/empty") {
    const emptied = await emptyCapacityArchive(deps.archive);
    return jsonResponse(200, emptied);
  }
  return jsonResponse(404, { error: "not_found" });
}

async function seedCapacityMessage(
  request: Request,
  url: URL,
  deps: CapacityHostDependencies,
): Promise<Response> {
  const body = await readBoundedRequestBody(request, DEFAULT_MAX_RAW_BYTES);
  if (body.kind === "too_large") {
    return jsonResponse(413, { error: "body_too_large" });
  }
  if (body.bytes.byteLength === 0) {
    return jsonResponse(400, { error: "body_required" });
  }
  const receivedAt = new Date().toISOString();
  const archived = await archiveInboundReceipt(
    {
      get: async (key) => {
        const object = await deps.archive.get(key);
        if (object === null) return null;
        return object.bytes();
      },
      put: async (key, bytes) => {
        await deps.archive.put(key, bytes);
      },
    },
    {
      envelope: {
        from: "capacity-sender@example.net",
        to: CAPACITY_MAILBOX,
      },
      advertisedRawSize: body.bytes.byteLength,
      bytes: body.bytes,
      receivedAt,
    },
  );
  await deps.runAccount(
    deps.account.registerInboundReceipt({
      receiptId: archived.receiptId,
      digest: archived.digest,
      envelopeFrom: archived.envelope.from,
      envelopeTo: archived.envelope.to,
      rawKey: archived.rawKey,
      manifestKey: archived.manifestKey,
      advertisedRawSize: archived.advertisedRawSize,
      consumedBytes: archived.consumedBytes,
      receivedAt: archived.receivedAt,
    }),
  );
  if (url.searchParams.get("retry") === "1") {
    await deps.runAccount(
      deps.account.putRecoveryScan({
        scanId: CAPACITY_RETRY_SCAN_ID,
        cursor: archived.receiptId,
        updatedAt: receivedAt,
      }),
    );
  }
  const queued = url.searchParams.get("publish") !== "0";
  if (queued) {
    await deps.index.send({ version: 1, receiptId: archived.receiptId });
  }
  const response = {
    receiptId: archived.receiptId,
    digest: archived.digest,
    rawKey: archived.rawKey,
    manifestKey: archived.manifestKey,
    queued,
  } satisfies CapacitySeedResponse;
  return jsonResponse(202, response);
}

async function capacityStatus(
  receiptId: string,
  deps: CapacityHostDependencies,
): Promise<Response> {
  const receipt = await deps.runAccount(deps.account.getInboundReceipt(receiptId));
  const summary = await deps.runAccount(deps.account.getMessageSummary(receiptId, "all"));
  const body = await deps.runAccount(deps.account.getMessageBody(receiptId, "all"));
  const manifestObject = await deps.archive.get(receiptManifestKey(receiptId));
  const manifest = manifestObject === null ? null : await decodeReceiptManifest(manifestObject);
  const attachments = [];
  for (const meta of summary?.attachments ?? []) {
    const stored = await deps.runAccount(
      deps.account.getStoredAttachment(receiptId, meta.id, "all"),
    );
    if (stored === null) {
      throw new Error("Stored attachment row is missing.");
    }
    const object = await deps.archive.get(stored.r2Key);
    if (object === null) {
      throw new Error("Stored attachment object is missing.");
    }
    const bytes = await object.bytes();
    attachments.push({
      stored,
      object: {
        key: stored.r2Key,
        size: object.size,
        sha256: await sha256Hex(bytes),
      },
    });
  }
  const derivedObjects = await listCapacityObjects(deps.archive, `attachments/${receiptId}/`);
  const response = {
    receipt,
    manifest,
    summary,
    body,
    attachments,
    derivedObjects,
  } satisfies CapacityStatusResponse;
  return jsonResponse(200, response);
}

async function decodeReceiptManifest(object: R2ObjectBody) {
  const encoded: unknown = await object.json();
  return Schema.decodeUnknownPromise(ReceiptManifest)(encoded);
}

async function runCapacityRecovery(deps: CapacityHostDependencies): Promise<void> {
  await handleRecoveryScheduled(
    { scheduledTime: Date.now() },
    {
      archive: {
        get: async (key) => {
          const object = await deps.archive.get(key);
          if (object === null) return null;
          return object.bytes();
        },
        list: async (prefix, limit, cursor) => {
          const listed = await deps.archive.list(
            cursor === null ? { prefix, limit } : { prefix, limit, cursor },
          );
          return {
            keys: listed.objects.map((object) => object.key),
            cursor: listed.truncated ? listed.cursor : null,
          };
        },
      },
      index: {
        send: async (payload) => {
          await deps.index.send(payload);
        },
      },
      account: {
        registerInboundReceipt: (input) =>
          deps.runAccount(deps.account.registerInboundReceipt(input)),
        listInboundReceiptWork: (input) =>
          deps.runAccount(deps.account.listInboundReceiptWork(input)),
        recordInboundReceiptRedrive: (input) =>
          deps.runAccount(deps.account.recordInboundReceiptRedrive(input)),
        getRecoveryScan: (scanId) => deps.runAccount(deps.account.getRecoveryScan(scanId)),
        putRecoveryScan: (input) => deps.runAccount(deps.account.putRecoveryScan(input)),
      },
      receiptPageSize: RECEIPT_RECOVERY_PAGE_SIZE,
      manifestPageSize: MANIFEST_DISCOVERY_PAGE_SIZE,
      attemptBudget: RECEIPT_RECOVERY_ATTEMPT_BUDGET,
    },
  );
}

async function emptyCapacityArchive(archive: R2Bucket): Promise<CapacityEmptyResponse> {
  let deleted = 0;
  while (true) {
    const listed = await archive.list({ limit: 1_000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length === 0) break;
    await archive.delete(keys);
    deleted += keys.length;
  }
  const remaining = await archive.list({ limit: 1 });
  if (remaining.objects.length !== 0) {
    throw new Error("Capacity archive did not empty completely.");
  }
  return { deleted, remaining: 0 };
}

async function listCapacityObjects(
  archive: R2Bucket,
  prefix: string,
): Promise<ReadonlyArray<{ readonly key: string; readonly size: number }>> {
  const objects: Array<{ readonly key: string; readonly size: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await archive.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of listed.objects) {
      objects.push({ key: object.key, size: object.size });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

type BoundedRequestBody =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" };

export async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
): Promise<BoundedRequestBody> {
  const declared = parseContentLength(request.headers.get("content-length"));
  if (declared !== null && declared > maximumBytes) {
    await request.body?.cancel();
    return { kind: "too_large" };
  }
  if (request.body === null) {
    return { kind: "bytes", bytes: new Uint8Array() };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "bytes", bytes };
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const decoded = Schema.decodeResult(Schema.FiniteFromString)(value);
  if (Result.isFailure(decoded) || !Number.isSafeInteger(decoded.success)) return null;
  return decoded.success;
}

class CapacityRequestError extends Data.TaggedError("CapacityRequestError")<{
  readonly cause: unknown;
}> {}

export async function verifyControlToken(
  authorization: string | null,
  expected: string,
): Promise<boolean> {
  const provided =
    authorization !== null && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return fixedLengthDigestEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

function fixedLengthDigestEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

type CapacityJsonResponse =
  | CapacitySeedResponse
  | CapacityStatusResponse
  | CapacityEmptyResponse
  | { readonly recovered: true }
  | CapacityErrorResponse;

function jsonResponse(status: number, body: CapacityJsonResponse) {
  return Response.json(body, { status });
}
