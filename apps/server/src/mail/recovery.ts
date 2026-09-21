import type { InboundReceipt, ListInboundReceiptWorkInput } from "../account/domain.ts";
import type { ScheduledController } from "@cloudflare/workers-types";

import { toRpcAsync, type RpcAsync } from "alchemy/Cloudflare/Bridge";
import type { Input } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { AccountStoreRpc } from "../account/worker.ts";
import { MailArchive } from "./archive.ts";
import { MailIndex } from "./indexing.ts";
import { MailSend } from "./send.ts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const Recovery = (scriptName: Input<string>, operatorId: Input<string>) =>
  Cloudflare.Worker("Recovery", {
    main: import.meta.url,
    workersDev: false,
    crons: [MAIL_RECOVERY_CRON],
    env: {
      ARCHIVE: MailArchive,
      INDEX: MailIndex,
      SEND: MailSend,
      ACCOUNT_STORE: Cloudflare.DurableObject<AccountStoreRpc>("RecoveryAccountStore", {
        className: "AccountStore",
        scriptName,
      }),
      ACCOUNT_ID: operatorId,
    },
  });

export type RecoveryEnv = Cloudflare.InferEnv<ReturnType<typeof Recovery>>;
import { RECEIPT_MANIFEST_PREFIX, receiptRetryAfterIso } from "./policy.ts";
import { type IndexReceiptWork } from "./index-payload.ts";
import { ReceiptManifest } from "./archive.ts";
import type { SendJobWork } from "./send.ts";

export type RecoveryArchiveListPage = {
  readonly keys: ReadonlyArray<string>;
  readonly cursor: string | null;
};

export type RecoveryArchive = {
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string, limit: number, cursor: string | null): Promise<RecoveryArchiveListPage>;
};

export type RecoveryIndex = {
  send(payload: IndexReceiptWork): Promise<void>;
};

export type RecoverySend = {
  send(payload: SendJobWork): Promise<void>;
};

export type RecoveryAccount = Pick<
  RpcAsync<AccountStoreRpc>,
  | "registerInboundReceipt"
  | "listInboundReceiptWork"
  | "recordInboundReceiptRedrive"
  | "getRecoveryScan"
  | "putRecoveryScan"
> &
  Partial<
    Pick<
      RpcAsync<AccountStoreRpc>,
      | "listSendWork"
      | "listDuePendingApprovals"
      | "listPurgeableNotifications"
      | "expirePendingApproval"
      | "settleExpiredInFlight"
      | "purgeNotificationCiphertext"
    >
  >;

export type RecoveryPorts = {
  readonly archive: RecoveryArchive;
  readonly index: RecoveryIndex;
  readonly account: RecoveryAccount;
  readonly receiptPageSize: number;
  readonly manifestPageSize: number;
  readonly attemptBudget: number;
  readonly send?: RecoverySend;
  readonly sendPageSize?: number;
  readonly approvalPageSize?: number;
  readonly purgePageSize?: number;
};

export async function handleRecoveryScheduled(
  controller: Pick<ScheduledController, "scheduledTime">,
  ports: RecoveryPorts,
): Promise<void> {
  await runMailRecovery(ports, new Date(controller.scheduledTime).toISOString());
}

export async function runMailRecovery(ports: RecoveryPorts, nowIso: string): Promise<void> {
  const nowMs = Date.parse(nowIso);
  await discoverManifests(ports, nowIso);
  await redriveReceiptWork(ports, "ready", nowIso, nowMs);
  await redriveReceiptWork(ports, "expired_claim", nowIso, nowMs);
  if (ports.send !== undefined) {
    await publishReadySendWork(ports, nowIso);
    await expireDueApprovals(ports, nowIso);
    await purgeNotificationCiphertexts(ports, nowIso);
    await settleExpiredSendClaims(ports, nowIso);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: RecoveryEnv): Promise<void> {
    await handleRecoveryScheduled(controller, recoveryPortsFromEnv(env));
  },
};

export const MAIL_RECOVERY_CRON = "* * * * *" as const;
export const RECEIPT_RECOVERY_PAGE_SIZE = 50 as const;
export const MANIFEST_DISCOVERY_PAGE_SIZE = 100 as const;
export const RECEIPT_RECOVERY_ATTEMPT_BUDGET = 8 as const;
export const MANIFEST_SCAN_ID = "r2_manifests" as const;
export const SEND_RECOVERY_PAGE_SIZE = 50 as const;
export const APPROVAL_EXPIRY_PAGE_SIZE = 50 as const;
export const NOTIFICATION_PURGE_PAGE_SIZE = 50 as const;
export const READY_SEND_SCAN_ID = "ready_send" as const;

function recoveryPortsFromEnv(env: RecoveryEnv): RecoveryPorts {
  const stub = toRpcAsync<AccountStoreRpc>(env.ACCOUNT_STORE.getByName(env.ACCOUNT_ID));
  return {
    archive: {
      async get(key) {
        const object = await env.ARCHIVE.get(key);
        if (object === null) return null;
        return new Uint8Array(await object.arrayBuffer());
      },
      async list(prefix, limit, cursor) {
        const listed =
          cursor === null
            ? await env.ARCHIVE.list({ prefix, limit })
            : await env.ARCHIVE.list({ prefix, limit, cursor });
        return {
          keys: listed.objects.map((object: { readonly key: string }) => object.key),
          cursor: listed.truncated ? listed.cursor : null,
        };
      },
    },
    index: {
      async send(payload) {
        await env.INDEX.send(payload);
      },
    },
    account: stub,
    receiptPageSize: RECEIPT_RECOVERY_PAGE_SIZE,
    manifestPageSize: MANIFEST_DISCOVERY_PAGE_SIZE,
    attemptBudget: RECEIPT_RECOVERY_ATTEMPT_BUDGET,
    send: {
      async send(payload) {
        await env.SEND.send(payload);
      },
    },
    sendPageSize: SEND_RECOVERY_PAGE_SIZE,
    approvalPageSize: APPROVAL_EXPIRY_PAGE_SIZE,
    purgePageSize: NOTIFICATION_PURGE_PAGE_SIZE,
  };
}

async function discoverManifests(ports: RecoveryPorts, nowIso: string): Promise<void> {
  const scan = await ports.account.getRecoveryScan(MANIFEST_SCAN_ID);
  const listed = await ports.archive.list(
    RECEIPT_MANIFEST_PREFIX,
    ports.manifestPageSize,
    scan === null ? null : scan.cursor,
  );
  for (const key of listed.keys) {
    await registerManifestIfPresent(ports, key);
  }
  await ports.account.putRecoveryScan({
    scanId: MANIFEST_SCAN_ID,
    cursor: listed.cursor,
    updatedAt: nowIso,
  });
}

async function registerManifestIfPresent(ports: RecoveryPorts, key: string): Promise<void> {
  const bytes = await ports.archive.get(key);
  if (bytes === null) {
    return;
  }
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(ReceiptManifest))(
    new TextDecoder().decode(bytes),
  );
  if (Result.isFailure(decoded)) {
    return;
  }
  const manifest = decoded.success;
  await ports.account.registerInboundReceipt({
    receiptId: manifest.receiptId,
    digest: manifest.digest,
    envelopeFrom: manifest.envelope.from,
    envelopeTo: manifest.envelope.to,
    rawKey: manifest.rawKey,
    manifestKey: key,
    advertisedRawSize: manifest.advertisedRawSize,
    consumedBytes: manifest.consumedBytes,
    receivedAt: manifest.receivedAt,
  });
}

async function redriveReceiptWork(
  ports: RecoveryPorts,
  kind: ListInboundReceiptWorkInput["kind"],
  nowIso: string,
  nowMs: number,
): Promise<void> {
  const page = await ports.account.listInboundReceiptWork({
    kind,
    nowIso,
    limit: ports.receiptPageSize,
  });
  for (const receipt of page.items) {
    const retried = await ports.account.recordInboundReceiptRedrive({
      receiptId: receipt.receiptId,
      nowIso,
      retryAfterIso: receiptRetryAfterIso(nowMs, receipt.attemptCount),
      attemptBudget: ports.attemptBudget,
    });
    if (isRedriveTerminal(retried.workState)) {
      continue;
    }
    await ports.index.send({
      version: 1,
      receiptId: retried.receiptId,
    });
  }
}

function isRedriveTerminal(state: InboundReceipt["workState"]): boolean {
  return (
    state === "operator_reprocess" ||
    state === "terminal" ||
    state === "policy_failed" ||
    state === "indexed"
  );
}

async function publishReadySendWork(ports: RecoveryPorts, nowIso: string): Promise<void> {
  const send = ports.send;
  if (send === undefined || ports.account.listSendWork === undefined) {
    return;
  }
  const scan = await ports.account.getRecoveryScan(READY_SEND_SCAN_ID);
  const cursor = decodeSendCursor(scan === null ? null : scan.cursor);
  const limit = ports.sendPageSize ?? SEND_RECOVERY_PAGE_SIZE;
  const page =
    cursor === undefined
      ? await ports.account.listSendWork({ kind: "ready", nowIso, limit })
      : await ports.account.listSendWork({ kind: "ready", nowIso, limit, cursor });
  for (const job of page.items) {
    await send.send({ version: 1, jobId: job.jobId });
  }
  await ports.account.putRecoveryScan({
    scanId: READY_SEND_SCAN_ID,
    cursor: page.nextCursor === null ? null : encodeSendCursor(page.nextCursor),
    updatedAt: nowIso,
  });
}

async function expireDueApprovals(ports: RecoveryPorts, nowIso: string): Promise<void> {
  if (
    ports.account.listDuePendingApprovals === undefined ||
    ports.account.expirePendingApproval === undefined
  ) {
    return;
  }
  const page = await ports.account.listDuePendingApprovals({
    nowIso,
    limit: ports.approvalPageSize ?? APPROVAL_EXPIRY_PAGE_SIZE,
  });
  for (const approval of page.items) {
    await ports.account.expirePendingApproval({
      approvalId: approval.id,
      nowIso,
    });
  }
}

async function purgeNotificationCiphertexts(ports: RecoveryPorts, nowIso: string): Promise<void> {
  if (
    ports.account.listPurgeableNotifications === undefined ||
    ports.account.purgeNotificationCiphertext === undefined
  ) {
    return;
  }
  const page = await ports.account.listPurgeableNotifications({
    nowIso,
    limit: ports.purgePageSize ?? NOTIFICATION_PURGE_PAGE_SIZE,
  });
  for (const notification of page.items) {
    await ports.account.purgeNotificationCiphertext({
      notificationId: notification.id,
      nowIso,
    });
  }
}

function encodeSendCursor(cursor: { readonly createdAt: string; readonly jobId: string }): string {
  return `${cursor.createdAt}|${cursor.jobId}`;
}

function decodeSendCursor(
  raw: string | null,
): { readonly createdAt: string; readonly jobId: string } | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  const separator = raw.indexOf("|");
  if (separator <= 0 || separator === raw.length - 1) {
    return undefined;
  }
  return {
    createdAt: raw.slice(0, separator),
    jobId: raw.slice(separator + 1),
  };
}

async function settleExpiredSendClaims(ports: RecoveryPorts, nowIso: string): Promise<void> {
  if (
    ports.account.listSendWork === undefined ||
    ports.account.settleExpiredInFlight === undefined
  ) {
    return;
  }
  const page = await ports.account.listSendWork({
    kind: "expired_in_flight",
    nowIso,
    limit: ports.sendPageSize ?? SEND_RECOVERY_PAGE_SIZE,
  });
  for (const job of page.items) {
    if (job.attemptId === null) {
      continue;
    }
    await ports.account.settleExpiredInFlight({
      jobId: job.jobId,
      attemptId: job.attemptId,
      nowIso,
    });
  }
}
