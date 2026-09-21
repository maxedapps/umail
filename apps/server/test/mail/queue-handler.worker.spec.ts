import { indexAccountFromAsync } from "./fakes.ts";
/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { beforeEach, describe, expect, it } from "vitest";

import { handleIndexMessages } from "../../src/mail/indexing.ts";
import type { IndexReceiptWork } from "../../src/mail/index-payload.ts";
import { INBOUND_MIME_LIMITS, sha256Hex } from "../../src/mail/policy.ts";
import {
  ArchiveError,
  type ArchiveStore,
  type IndexConsumerAccount,
} from "../../src/mail/process-index.ts";
import { archiveInboundReceipt } from "../../src/mail/archive.ts";
import { receiptClaimUntilIso } from "../../src/mail/policy.ts";
import { foldedBase64Fixture, retryProbeFixture } from "./mail-capacity-fixtures.ts";
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
const CLAIM_UNTIL_ISO = receiptClaimUntilIso(Date.parse(TEST_NOW_ISO));

describe("index queue handler", () => {
  beforeEach(async () => {
    await reset();
  });

  it("acks healthy items and retries poison siblings in the same batch", async () => {
    const world = await createWorld("queue-mixed");
    const healthy = await archiveRegistered(world, "healthy");
    const poison = new FakeQueueMessage("poison", { nope: true });
    const sibling = new FakeQueueMessage("healthy", {
      version: 1,
      receiptId: healthy.receiptId,
    });

    await runHandler(world, [poison, sibling]);

    expect(poison.retried).toBe(true);
    expect(poison.acked).toBe(false);
    expect(sibling.acked).toBe(true);
    expect(sibling.retried).toBe(false);

    const receipt = await world.stub.getInboundReceipt(healthy.receiptId);
    expect(receipt?.workState).toBe("indexed");
    const body = await world.stub.getMessageBody(healthy.receiptId, "all");
    expect(body?.textBody ?? body?.htmlBody).toBeTruthy();
    const listed = await world.stub.listMessageSummaries({
      mailboxScope: "all",
    });
    expect(listed.items).toHaveLength(1);
  });

  it("processes a manual batch in order and settles each item after durable work", async () => {
    const world = await createWorld("queue-ordered");
    const first = await archiveRegistered(world, "first");
    const policy = await archiveRegistered(world, "policy", oversizedHeaderEml());
    const transient = await archiveRegistered(world, "transient", retryProbeFixture().raw);
    const lastFixture = foldedBase64Fixture();
    if (lastFixture.expected.kind !== "indexed") {
      throw new Error("expected the folded attachment fixture to be indexed");
    }
    const last = await archiveRegistered(world, "last", lastFixture.raw);
    const events: string[] = [];
    const firstReadStarted = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const account = observedIndexAccount(indexAccount(world), events);
    const archive = orderedArchiveStore(
      r2ArchiveStore(),
      first.rawKey,
      policy.rawKey,
      transient.rawKey,
      last.rawKey,
      {
        started: firstReadStarted.resolve,
        released: releaseFirstRead.promise,
      },
      events,
    );
    const messages = [
      new FakeQueueMessage("first", { version: 1, receiptId: first.receiptId }, events),
      new FakeQueueMessage("policy", { version: 1, receiptId: policy.receiptId }, events),
      new FakeQueueMessage("transient", { version: 1, receiptId: transient.receiptId }, events),
      new FakeQueueMessage("last", { version: 1, receiptId: last.receiptId }, events),
    ];

    const handling = runHandler(world, messages, { archive, account });
    await firstReadStarted.promise;
    await Promise.resolve();

    expect(events).toEqual(["read:first"]);
    expect((await world.stub.getInboundReceipt(policy.receiptId))?.workState).toBe("ready");
    expect((await world.stub.getInboundReceipt(transient.receiptId))?.workState).toBe("ready");
    expect((await world.stub.getInboundReceipt(last.receiptId))?.workState).toBe("ready");

    releaseFirstRead.resolve();
    await handling;

    expect(events).toEqual([
      "read:first",
      `indexed:${first.receiptId}`,
      "ack:first",
      "read:policy",
      `policy_failed:${policy.receiptId}`,
      "ack:policy",
      "read:transient",
      "retry:transient",
      "read:last",
      `indexed:${last.receiptId}`,
      "ack:last",
    ]);
    expect((await world.stub.getInboundReceipt(first.receiptId))?.workState).toBe("indexed");
    expect((await world.stub.getInboundReceipt(policy.receiptId))?.workState).toBe("policy_failed");
    expect((await world.stub.getInboundReceipt(transient.receiptId))?.workState).toBe("claimed");
    expect((await world.stub.getInboundReceipt(last.receiptId))?.workState).toBe("indexed");
    const listed = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(new Set(listed.items.map((message) => message.id))).toEqual(
      new Set([first.receiptId, last.receiptId]),
    );
    const lastMessage = listed.items.find((message) => message.id === last.receiptId);
    expect(lastMessage?.subject).toBe(lastFixture.expected.subject);
    expect(lastMessage?.attachments).toHaveLength(1);
    const stored = await testEnv.ARCHIVE.get(`attachments/${last.receiptId}/0`);
    if (stored === null || lastFixture.expected.kind !== "indexed") {
      throw new Error("expected the final folded attachment to be indexed");
    }
    const expectedAttachment = lastFixture.expected.attachments[0];
    if (expectedAttachment === undefined) {
      throw new Error("expected folded attachment metadata");
    }
    const bytes = new Uint8Array(await stored.arrayBuffer());
    expect(bytes.byteLength).toBe(expectedAttachment.byteLength);
    expect(await sha256Hex(bytes)).toBe(expectedAttachment.sha256);
  });

  it("completes a duplicate delivery without inserting a second message", async () => {
    const world = await createWorld("queue-duplicate");
    const archived = await archiveRegistered(world, "dup");
    const first = new FakeQueueMessage("dup-1", {
      version: 1,
      receiptId: archived.receiptId,
    });
    const second = new FakeQueueMessage("dup-2", {
      version: 1,
      receiptId: archived.receiptId,
    });

    await runHandler(world, [first]);
    await runHandler(world, [second]);

    expect(first.acked).toBe(true);
    expect(second.acked).toBe(true);
    const listed = await world.stub.listMessageSummaries({
      mailboxScope: "all",
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(archived.receiptId);
    expect((await world.stub.getInboundReceipt(archived.receiptId))?.workState).toBe("indexed");
  });

  it("persists a content failure and acks instead of retrying", async () => {
    const world = await createWorld("queue-policy");
    const archived = await archiveRegistered(world, "policy", oversizedHeaderEml());
    const message = new FakeQueueMessage("policy", {
      version: 1,
      receiptId: archived.receiptId,
    });

    await runHandler(world, [message]);

    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
    expect((await world.stub.getInboundReceipt(archived.receiptId))?.workState).toBe(
      "policy_failed",
    );
    const listed = await world.stub.listMessageSummaries({
      mailboxScope: "all",
    });
    expect(listed.items).toHaveLength(0);
  });
});

type World = {
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
};

async function createWorld(accountName: string): Promise<World> {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const mailbox = parsedInbox();
  const created = await stub.createAddress(
    mailbox.localPart,
    mailbox.domain,
    "Inbox",
    TEST_NOW_ISO,
  );
  expect(created).not.toBeNull();
  return { stub };
}

async function archiveRegistered(world: World, suffix: string, raw = plainTextEml(suffix)) {
  const archived = await archiveInboundReceipt(r2ReceiptArchive(), {
    envelope: { from: SENDER, to: parsedInbox().address },
    advertisedRawSize: raw.byteLength,
    bytes: raw,
    receivedAt: TEST_NOW_ISO,
  });
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

type HandlerOverrides = {
  readonly archive?: ArchiveStore;
  readonly account?: IndexConsumerAccount;
};

async function runHandler(
  world: World,
  messages: FakeQueueMessage[],
  overrides: HandlerOverrides = {},
): Promise<void> {
  await Effect.runPromise(
    handleIndexMessages(Stream.fromIterable(messages), {
      archive: overrides.archive ?? r2ArchiveStore(),
      account: overrides.account ?? indexAccount(world),
      nowIso: TEST_NOW_ISO,
      claimUntilIso: CLAIM_UNTIL_ISO,
    }),
  );
}

function indexAccount(world: World): IndexConsumerAccount {
  return indexAccountFromAsync({
    getInboundReceipt: (receiptId) => world.stub.getInboundReceipt(receiptId),
    getAddressByMailbox: (address) => world.stub.getAddressByMailbox(address),
    claimInboundReceipt: (input) => world.stub.claimInboundReceipt(input),
    acceptInbound: (input) => world.stub.acceptInbound(input),
    completeInboundReceipt: (receiptId) => world.stub.completeInboundReceipt(receiptId),
    failInboundReceiptPolicy: (input) => world.stub.failInboundReceiptPolicy(input),
  });
}

function observedIndexAccount(
  account: IndexConsumerAccount,
  events: string[],
): IndexConsumerAccount {
  return {
    getInboundReceipt: (receiptId) => account.getInboundReceipt(receiptId),
    getAddressByMailbox: (address) => account.getAddressByMailbox(address),
    claimInboundReceipt: (input) => account.claimInboundReceipt(input),
    acceptInbound: (input) => account.acceptInbound(input),
    completeInboundReceipt: (receiptId) =>
      account.completeInboundReceipt(receiptId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push(`indexed:${receiptId}`);
          }),
        ),
      ),
    failInboundReceiptPolicy: (input) =>
      account.failInboundReceiptPolicy(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push(`policy_failed:${input.receiptId}`);
          }),
        ),
      ),
  };
}

function r2ReceiptArchive() {
  return {
    async get(key: string) {
      const object = await testEnv.ARCHIVE.get(key);
      if (object === null) return null;
      return new Uint8Array(await object.arrayBuffer());
    },
    async put(key: string, bytes: Uint8Array) {
      await testEnv.ARCHIVE.put(key, bytes);
    },
  };
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

function orderedArchiveStore(
  archive: ArchiveStore,
  firstRawKey: string,
  policyRawKey: string,
  failingRawKey: string,
  lastRawKey: string,
  firstRead: FirstReadGate,
  events: string[],
): ArchiveStore {
  return {
    get: (key) => {
      if (key === firstRawKey) {
        return Effect.sync(() => {
          events.push("read:first");
          firstRead.started();
        }).pipe(
          Effect.andThen(Effect.promise(() => firstRead.released)),
          Effect.andThen(archive.get(key)),
        );
      }
      if (key === policyRawKey) {
        return Effect.sync(() => {
          events.push("read:policy");
        }).pipe(Effect.andThen(archive.get(key)));
      }
      if (key === failingRawKey) {
        return Effect.sync(() => {
          events.push("read:transient");
        }).pipe(Effect.andThen(Effect.fail(new ArchiveError({ reason: "read_failed" }))));
      }
      if (key === lastRawKey) {
        return Effect.sync(() => {
          events.push("read:last");
        }).pipe(Effect.andThen(archive.get(key)));
      }
      return archive.get(key);
    },
    put: (key, bytes) => archive.put(key, bytes),
  };
}

type FirstReadGate = {
  readonly started: () => void;
  readonly released: Promise<void>;
};

class FakeQueueMessage {
  readonly timestamp = new Date(TEST_NOW_ISO);
  readonly attempts = 1;
  acked = false;
  retried = false;

  readonly id: string;
  readonly body: IndexReceiptWork | { readonly nope: true };
  private readonly settlements: string[] | undefined;

  constructor(
    id: string,
    body: IndexReceiptWork | { readonly nope: true },
    settlements?: string[],
  ) {
    this.id = id;
    this.body = body;
    this.settlements = settlements;
  }

  ack(): void {
    if (this.acked || this.retried) return;
    this.acked = true;
    this.settlements?.push(`ack:${this.id}`);
  }

  retry(): void {
    if (this.acked || this.retried) return;
    this.retried = true;
    this.settlements?.push(`retry:${this.id}`);
  }
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

function oversizedHeaderEml(): Uint8Array {
  const chunk = "x".repeat(76);
  const lines = [`From: ${SENDER}`, `To: ${INBOX}`, `X-Pad: ${chunk}`];
  let headerBytes = lines.reduce((total, line) => total + line.length, 0);
  while (headerBytes <= INBOUND_MIME_LIMITS.maxHeadersSize) {
    lines.push(` ${chunk}`);
    headerBytes += 1 + chunk.length;
  }
  lines.push("Subject: Hello", "", "body");
  return new TextEncoder().encode(lines.join("\r\n"));
}
