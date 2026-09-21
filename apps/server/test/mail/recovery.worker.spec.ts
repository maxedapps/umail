import { indexAccountFromAsync } from "./fakes.ts";
/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { beforeEach, describe, expect, it } from "vitest";

import { handleIndexMessages } from "../../src/mail/indexing.ts";
import { sha256Hex } from "../../src/mail/policy.ts";
import { ArchiveError, type ArchiveStore } from "../../src/mail/process-index.ts";
import {
  handleRecoveryScheduled,
  type RecoveryIndex,
  type RecoveryPorts,
} from "../../src/mail/recovery.ts";
import { archiveInboundReceipt } from "../../src/mail/archive.ts";
import type { IndexReceiptWork } from "../../src/mail/index-payload.ts";
import { foldedBase64Fixture, recoveryProbeFixture } from "./mail-capacity-fixtures.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
  readonly ACCOUNT_ID: string;
};

const testEnv = env as TestEnv;

const INBOX = "inbox@umail.example.com";
const SENDER = "sender@example.com";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";
const SCHEDULED_TIME = Date.parse(TEST_NOW_ISO);

describe("mail recovery cron handler", () => {
  beforeEach(async () => {
    await reset();
  });

  it("rediscovers unpublished ready receipts after commit-before-publication interruption", async () => {
    const world = await createWorld("recovery-unpublished");
    const archived = await archiveRegistered(world, "ready-1");
    expect(world.published).toEqual([]);

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);

    expect(world.published).toEqual([{ version: 1, receiptId: archived.receiptId }]);
    const receipt = await world.stub.getInboundReceipt(archived.receiptId);
    expect(receipt?.workState).toBe("ready");
    expect(receipt?.retryAfter).toBeTruthy();
    expect(receipt?.forward).toEqual({ kind: "none" });
  });

  it("redrives ready work in bounded pages", async () => {
    const world = await createWorld("recovery-pages", 2);
    const first = await archiveRegistered(world, "page-a");
    const second = await archiveRegistered(world, "page-b");
    const third = await archiveRegistered(world, "page-c");

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);
    expect(world.published).toHaveLength(2);
    const firstPage = new Set(idsOf(world.published));
    expect(firstPage.size).toBe(2);

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);
    expect(new Set(idsOf(world.published))).toEqual(
      new Set([first.receiptId, second.receiptId, third.receiptId]),
    );
    expect(world.published).toHaveLength(3);
  });

  it("indexes recovered work before a subsequent valid large message", async () => {
    const world = await createWorld("recovery-then-large");
    const recoveryFixture = recoveryProbeFixture();
    const recovered = await archiveRegistered(world, "recovered", recoveryFixture.raw);
    const failedMessage = new FakeQueueMessage("failed", {
      version: 1,
      receiptId: recovered.receiptId,
    });

    await Effect.runPromise(
      handleIndexMessages(Stream.fromIterable([failedMessage]), {
        archive: failReadOnceArchiveStore(r2ArchiveStore(), recovered.rawKey),
        account: indexAccountFromAsync({
          getInboundReceipt: (receiptId) => world.stub.getInboundReceipt(receiptId),
          getAddressByMailbox: (address) => world.stub.getAddressByMailbox(address),
          claimInboundReceipt: (input) => world.stub.claimInboundReceipt(input),
          acceptInbound: (input) => world.stub.acceptInbound(input),
          completeInboundReceipt: (receiptId) => world.stub.completeInboundReceipt(receiptId),
          failInboundReceiptPolicy: (input) => world.stub.failInboundReceiptPolicy(input),
        }),
        nowIso: "2025-12-31T23:45:00.000Z",
        claimUntilIso: "2025-12-31T23:59:00.000Z",
      }),
    );

    expect(failedMessage.settlement).toBe("retry");
    expect(await world.stub.getInboundReceipt(recovered.receiptId)).toMatchObject({
      workState: "claimed",
      attemptCount: 0,
      claimedUntil: "2025-12-31T23:59:00.000Z",
    });

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);

    expect(world.published).toEqual([{ version: 1, receiptId: recovered.receiptId }]);
    const recoveredWork = world.published[0];
    if (recoveredWork === undefined) {
      throw new Error("expected recovered receipt work");
    }
    const largeFixture = foldedBase64Fixture();
    const large = await archiveRegistered(world, "large", largeFixture.raw);
    const recoveryMessage = new FakeQueueMessage("recovered", recoveredWork);
    const largeMessage = new FakeQueueMessage("large", {
      version: 1,
      receiptId: large.receiptId,
    });

    await Effect.runPromise(
      handleIndexMessages(Stream.fromIterable([recoveryMessage, largeMessage]), {
        archive: r2ArchiveStore(),
        account: indexAccountFromAsync({
          getInboundReceipt: (receiptId) => world.stub.getInboundReceipt(receiptId),
          getAddressByMailbox: (address) => world.stub.getAddressByMailbox(address),
          claimInboundReceipt: (input) => world.stub.claimInboundReceipt(input),
          acceptInbound: (input) => world.stub.acceptInbound(input),
          completeInboundReceipt: (receiptId) => world.stub.completeInboundReceipt(receiptId),
          failInboundReceiptPolicy: (input) => world.stub.failInboundReceiptPolicy(input),
        }),
        nowIso: TEST_NOW_ISO,
        claimUntilIso: "2026-01-01T00:15:00.000Z",
      }),
    );

    expect(recoveryMessage.settlement).toBe("ack");
    expect(largeMessage.settlement).toBe("ack");
    expect(await world.stub.getInboundReceipt(recovered.receiptId)).toMatchObject({
      workState: "indexed",
      attemptCount: 1,
      claimedUntil: null,
    });
    expect(await world.stub.getInboundReceipt(large.receiptId)).toMatchObject({
      workState: "indexed",
      attemptCount: 0,
      claimedUntil: null,
    });
    const messages = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(new Set(messages.items.map((message) => message.id))).toEqual(
      new Set([recovered.receiptId, large.receiptId]),
    );
    const recoveredBody = await world.stub.getMessageBody(recovered.receiptId, "all");
    expect(recoveredBody?.textBody).toContain("recovery-probe-marker");

    if (largeFixture.expected.kind !== "indexed") {
      throw new Error("expected indexed large fixture");
    }
    const expectedAttachment = largeFixture.expected.attachments[0];
    if (expectedAttachment === undefined) {
      throw new Error("expected large attachment metadata");
    }
    const stored = await testEnv.ARCHIVE.get(`attachments/${large.receiptId}/0`);
    if (stored === null) {
      throw new Error("expected recovered sequence attachment");
    }
    const bytes = new Uint8Array(await stored.arrayBuffer());
    expect(bytes.byteLength).toBe(expectedAttachment.byteLength);
    expect(await sha256Hex(bytes)).toBe(expectedAttachment.sha256);
  }, 60_000);

  it("republishes expired claims and skips finished receipts", async () => {
    const world = await createWorld("recovery-claim");
    const expired = await archiveRegistered(world, "claimed");
    const indexed = await archiveRegistered(world, "indexed");
    await world.stub.claimInboundReceipt({
      receiptId: expired.receiptId,
      nowIso: TEST_NOW_ISO,
      claimUntilIso: "2025-12-31T00:00:00.000Z",
    });
    await world.stub.completeInboundReceipt(indexed.receiptId);

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);

    expect(world.published).toEqual([{ version: 1, receiptId: expired.receiptId }]);
    expect((await world.stub.getInboundReceipt(indexed.receiptId))?.workState).toBe("indexed");
  });

  it("registers missing receipts from a bounded R2 manifest scan", async () => {
    const world = await createWorld("recovery-manifests", 50, 2);
    const first = await archiveOnly("scan-a");
    const second = await archiveOnly("scan-b");
    const third = await archiveOnly("scan-c");

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);
    const afterFirst = await registeredIds(world, [
      first.receiptId,
      second.receiptId,
      third.receiptId,
    ]);
    expect(afterFirst).toHaveLength(2);
    const scan = await world.stub.getRecoveryScan("r2_manifests");
    expect(scan?.cursor).toBeTruthy();

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);
    const afterSecond = await registeredIds(world, [
      first.receiptId,
      second.receiptId,
      third.receiptId,
    ]);
    expect(afterSecond).toHaveLength(3);
    expect(new Set(idsOf(world.published))).toEqual(
      new Set([first.receiptId, second.receiptId, third.receiptId]),
    );
  });

  it("classifies exhausted operational redrives as operator_reprocess", async () => {
    const world = await createWorld("recovery-budget", 50, 100, 1);
    const archived = await archiveRegistered(world, "budget");

    await handleRecoveryScheduled({ scheduledTime: SCHEDULED_TIME }, world.ports);

    const receipt = await world.stub.getInboundReceipt(archived.receiptId);
    expect(receipt?.workState).toBe("operator_reprocess");
    expect(receipt?.lastError).toBe("attempt_budget");
    expect(world.published).toEqual([]);
  });

  it("does not reset a claimed unexpired receipt to ready by redrive", async () => {
    const world = await createWorld("recovery-live-claim");
    const archived = await archiveRegistered(world, "live");
    const claimUntilIso = "2026-01-01T01:00:00.000Z";
    await world.stub.claimInboundReceipt({
      receiptId: archived.receiptId,
      nowIso: TEST_NOW_ISO,
      claimUntilIso,
    });

    const retried = await world.stub.recordInboundReceiptRedrive({
      receiptId: archived.receiptId,
      nowIso: TEST_NOW_ISO,
      retryAfterIso: "2026-01-01T00:00:05.000Z",
      attemptBudget: 8,
    });
    expect(retried.workState).toBe("claimed");
    expect(retried.claimedUntil).toBe(claimUntilIso);
    expect(retried.attemptCount).toBe(0);

    const atBudget = await world.stub.recordInboundReceiptRedrive({
      receiptId: archived.receiptId,
      nowIso: TEST_NOW_ISO,
      retryAfterIso: "2026-01-01T00:00:05.000Z",
      attemptBudget: 1,
    });
    expect(atBudget.workState).toBe("claimed");
    expect(atBudget.claimedUntil).toBe(claimUntilIso);
    expect(atBudget.lastError).toBeNull();
    expect(world.published).toEqual([]);
  });
});

type World = {
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
  readonly published: IndexReceiptWork[];
  readonly ports: RecoveryPorts;
};

async function createWorld(
  accountName: string,
  receiptPageSize = 50,
  manifestPageSize = 100,
  attemptBudget = 8,
): Promise<World> {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const mailbox = parsedInbox();
  const created = await stub.createAddress(
    mailbox.localPart,
    mailbox.domain,
    "Inbox",
    TEST_NOW_ISO,
  );
  expect(created).not.toBeNull();
  const published: IndexReceiptWork[] = [];
  const index: RecoveryIndex = {
    async send(payload) {
      published.push(payload);
    },
  };
  const ports: RecoveryPorts = {
    archive: {
      async get(key) {
        const object = await testEnv.ARCHIVE.get(key);
        if (object === null) return null;
        return new Uint8Array(await object.arrayBuffer());
      },
      async list(prefix, limit, cursor) {
        const listed =
          cursor === null
            ? await testEnv.ARCHIVE.list({ prefix, limit })
            : await testEnv.ARCHIVE.list({ prefix, limit, cursor });
        return {
          keys: listed.objects.map((object) => object.key),
          cursor: listed.truncated ? listed.cursor : null,
        };
      },
    },
    index,
    account: {
      registerInboundReceipt: (input) => stub.registerInboundReceipt(input),
      listInboundReceiptWork: (input) => stub.listInboundReceiptWork(input),
      recordInboundReceiptRedrive: (input) => stub.recordInboundReceiptRedrive(input),
      getRecoveryScan: (scanId) => stub.getRecoveryScan(scanId),
      putRecoveryScan: (input) => stub.putRecoveryScan(input),
    },
    receiptPageSize,
    manifestPageSize,
    attemptBudget,
  };
  return { stub, published, ports };
}

async function archiveRegistered(world: World, suffix: string, raw = plainTextEml(suffix)) {
  const archived = await archiveOnly(suffix, raw);
  await world.stub.registerInboundReceipt({
    receiptId: archived.receiptId,
    digest: archived.digest,
    envelopeFrom: archived.envelope.from,
    envelopeTo: archived.envelope.to,
    rawKey: archived.rawKey,
    manifestKey: archived.manifestKey,
    advertisedRawSize: archived.advertisedRawSize,
    consumedBytes: archived.consumedBytes,
    receivedAt: archived.receivedAt,
  });
  return archived;
}

async function archiveOnly(suffix: string, raw = plainTextEml(suffix)) {
  return archiveInboundReceipt(
    {
      async get(key) {
        const object = await testEnv.ARCHIVE.get(key);
        if (object === null) return null;
        return new Uint8Array(await object.arrayBuffer());
      },
      async put(key, bytes) {
        await testEnv.ARCHIVE.put(key, bytes);
      },
    },
    {
      envelope: { from: SENDER, to: parsedInbox().address },
      advertisedRawSize: raw.byteLength,
      bytes: raw,
      receivedAt: TEST_NOW_ISO,
    },
  );
}

function r2ArchiveStore(): ArchiveStore {
  return {
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const object = await testEnv.ARCHIVE.get(key);
          if (object === null) return null;
          return object.arrayBuffer();
        },
        catch: () => new ArchiveError({ reason: "read_failed" }),
      }),
    put: (key, bytes) =>
      Effect.tryPromise({
        try: async () => {
          await testEnv.ARCHIVE.put(key, bytes);
        },
        catch: () => new ArchiveError({ reason: "write_failed" }),
      }),
  };
}

function failReadOnceArchiveStore(archive: ArchiveStore, rawKey: string): ArchiveStore {
  let pendingFailure = true;
  return {
    get: (key) => {
      if (pendingFailure && key === rawKey) {
        pendingFailure = false;
        return Effect.fail(new ArchiveError({ reason: "read_failed" }));
      }
      return archive.get(key);
    },
    put: (key, bytes) => archive.put(key, bytes),
  };
}

class FakeQueueMessage {
  readonly timestamp = new Date(TEST_NOW_ISO);
  readonly attempts = 1;
  settlement: "ack" | "retry" | null = null;

  readonly id: string;
  readonly body: IndexReceiptWork;

  constructor(id: string, body: IndexReceiptWork) {
    this.id = id;
    this.body = body;
  }

  ack(): void {
    if (this.settlement === null) {
      this.settlement = "ack";
    }
  }

  retry(): void {
    if (this.settlement === null) {
      this.settlement = "retry";
    }
  }
}

function idsOf(published: ReadonlyArray<IndexReceiptWork>): string[] {
  return published.map((item) => item.receiptId);
}

async function registeredIds(world: World, receiptIds: ReadonlyArray<string>): Promise<string[]> {
  const found: string[] = [];
  for (const receiptId of receiptIds) {
    if ((await world.stub.getInboundReceipt(receiptId)) !== null) {
      found.push(receiptId);
    }
  }
  return found;
}

function parsedInbox() {
  const parsed = parseMailboxAddress(INBOX);
  if (parsed.kind === "invalid") {
    throw new Error("expected inbox address");
  }
  return parsed;
}

function plainTextEml(body: string): Uint8Array {
  return new TextEncoder().encode(
    [
      `From: ${SENDER}`,
      `To: ${INBOX}`,
      "Subject: Hello",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ]
      .join("\r\n")
      .concat("\r\n"),
  );
}
