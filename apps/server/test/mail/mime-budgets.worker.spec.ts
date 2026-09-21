/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { createMailHtmlPolicy } from "@umail/mail-content";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";

import type { InboundPorts } from "../../src/mail/inbound.ts";
import { processInbound } from "../../src/mail/inbound.ts";
import { DEFAULT_MAX_RAW_BYTES, INBOUND_MIME_LIMITS, sha256Hex } from "../../src/mail/policy.ts";
import {
  ArchiveError,
  consumeIndexReceipt,
  IndexFailure,
  type ArchiveStore,
} from "../../src/mail/process-index.ts";
import { ReceiptManifest, receiptManifestKey } from "../../src/mail/archive.ts";
import { receiptClaimUntilIso } from "../../src/mail/policy.ts";
import { FakeEmail } from "./fakes.ts";
import {
  MAIL_CAPACITY_INBOX,
  MAIL_CAPACITY_SUPPORTED_FIXTURES,
  MAIL_CAPACITY_REJECTED_FIXTURES,
  MAIL_CAPACITY_ENCODED_MAXIMUM_FIXTURES,
  maximumRawAttachmentFixture,
  overLineCountFixture,
  overPartCountFixture,
  overReferencesFixture,
  paddedBase64LinesFixture,
  partCountEml,
  plainTextEml,
  type MailCapacityFixture,
} from "./mail-capacity-fixtures.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
  readonly ACCOUNT_ID: string;
};

const testEnv = env as TestEnv;

const INBOX = MAIL_CAPACITY_INBOX;
const SENDER = "sender@example.com";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";
const CLAIM_UNTIL_ISO = receiptClaimUntilIso(Date.parse(TEST_NOW_ISO));

describe("MIME pre-allocation budgets", () => {
  beforeEach(async () => {
    await reset();
  });

  it("rejects newline-heavy MIME before derived writes and records a terminal receipt failure", async () => {
    const outcome = await rejectPreparation(overLineCountFixture().raw);
    expect(outcome.receipt?.workState).toBe("policy_failed");
    expect(outcome.receipt?.policyError).toBe("mime_budget");
    expect(outcome.receipt?.lastError).toBe("mime_budget");
    expect(outcome.manifest?.policyFailure).toBe("mime_budget");
    expect(outcome.messageCount).toBe(0);
    expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
  });

  it("rejects nested/attachment amplification at the part budget", async () => {
    const allowed = await PostalMime.parse(partCountEml(INBOUND_MIME_LIMITS.maxParts), {
      attachmentEncoding: "arraybuffer",
      ...INBOUND_MIME_LIMITS,
    });
    expect(allowed.attachments.length).toBeGreaterThan(0);

    const outcome = await rejectPreparation(overPartCountFixture().raw);
    expect(outcome.receipt?.policyError).toBe("mime_budget");
    expect(outcome.receipt?.lastError).toBe("mime_budget");
    expect(outcome.messageCount).toBe(0);
    expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
  });

  it("rejects a long References header before derived writes", async () => {
    const outcome = await rejectPreparation(overReferencesFixture().raw);
    expect(outcome.receipt?.policyError).toBe("mime_budget");
    expect(outcome.receipt?.lastError).toBe("mime_budget");
    expect(outcome.messageCount).toBe(0);
  });

  it("indexes a short supported message within the measured budgets", async () => {
    const world = await createWorld("mime-budgets-ok");
    const raw = plainTextEml("hello");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
    const accepted = await processInbound(email, world.ports);
    expect(accepted.kind).toBe("accepted");
    await indexQueued(world);
    const listed = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(listed.items).toHaveLength(1);
    const receipt = await world.stub.getInboundReceipt(world.published[0]?.receiptId ?? "");
    expect(receipt?.workState).toBe("indexed");
    expect(receipt?.policyError).toBeNull();
  });

  it("indexes separately padded base64 units near the configured line budget", async () => {
    const world = await createWorld("mime-budgets-padded-lines");
    const fixture = paddedBase64LinesFixture();
    const accepted = await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: fixture.raw }),
      world.ports,
    );
    expect(accepted.kind).toBe("accepted");

    await indexQueued(world);

    const receipt = await world.stub.getInboundReceipt(world.published[0]?.receiptId ?? "");
    expect(receipt?.workState).toBe("indexed");
    await expectIndexedFixture(world, fixture);
  }, 60_000);

  it("indexes a 20 MiB well-formed attachment message through the full pipeline", async () => {
    const world = await createWorld("mime-budgets-max-raw");
    const fixture = maximumRawAttachmentFixture();
    expect(fixture.raw.byteLength).toBe(DEFAULT_MAX_RAW_BYTES);
    const accepted = await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: fixture.raw }),
      world.ports,
    );
    expect(accepted.kind).toBe("accepted");

    await indexQueued(world);

    await expectIndexedFixture(world, fixture);
  }, 60_000);

  it.each(
    MAIL_CAPACITY_SUPPORTED_FIXTURES.filter(
      (descriptor) => descriptor.id !== "padded-base64-lines",
    ),
  )(
    "indexes the supported $id fixture through parsing, sanitization, writes, and SQL",
    async ({ make }) => {
      const fixture = make();
      const world = await createWorld(`mime-capacity-${fixture.id}`);

      const accepted = await processInbound(
        new FakeEmail({ to: INBOX, from: SENDER, raw: fixture.raw }),
        world.ports,
      );
      expect(accepted.kind).toBe("accepted");
      await indexQueued(world);

      await expectIndexedFixture(world, fixture);
    },
    60_000,
  );

  it.each(MAIL_CAPACITY_ENCODED_MAXIMUM_FIXTURES)(
    "indexes the exact-size encoded $id fixture with its expected attachment hash",
    async ({ make }) => {
      const fixture = make();
      expect(fixture.raw.byteLength).toBe(DEFAULT_MAX_RAW_BYTES);
      const world = await createWorld(`mime-capacity-${fixture.id}`);

      const accepted = await processInbound(
        new FakeEmail({ to: INBOX, from: SENDER, raw: fixture.raw }),
        world.ports,
      );
      expect(accepted.kind).toBe("accepted");
      await indexQueued(world);

      await expectIndexedFixture(world, fixture);
    },
    60_000,
  );

  it.each(
    MAIL_CAPACITY_REJECTED_FIXTURES.filter(
      (descriptor) =>
        descriptor.id !== "over-line-count" &&
        descriptor.id !== "over-part-count" &&
        descriptor.id !== "over-references",
    ),
  )(
    "terminates the rejected $id fixture without derived persistence",
    async ({ make }) => {
      const fixture = make();
      if (fixture.expected.kind !== "policy_failed") {
        throw new Error(`expected policy-failure fixture ${fixture.id}`);
      }

      const outcome = await rejectPreparation(fixture.raw);

      expect(outcome.receipt?.workState).toBe("policy_failed");
      expect(outcome.receipt?.policyError).toBe(fixture.expected.reason);
      expect(outcome.receipt?.lastError).toBe(fixture.expected.reason);
      expect(outcome.manifest?.policyFailure).toBe(fixture.expected.reason);
      expect(outcome.messageCount).toBe(0);
      expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
    },
    60_000,
  );
});

type World = {
  readonly ports: InboundPorts;
  readonly published: { readonly version: 1; readonly receiptId: string }[];
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
};

async function createWorld(accountName: string): Promise<World> {
  const published: { readonly version: 1; readonly receiptId: string }[] = [];
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  await seedInbox(stub);
  const ports: InboundPorts = {
    ARCHIVE: {
      async get(key) {
        const object = await testEnv.ARCHIVE.get(key);
        if (object === null) return null;
        return new Uint8Array(await object.arrayBuffer());
      },
      async put(key, bytes) {
        await testEnv.ARCHIVE.put(key, bytes);
      },
    },
    INDEX: {
      async send(payload) {
        published.push(payload);
        await testEnv.INDEX.send(payload);
      },
    },
    ACCOUNT: {
      registerInboundReceipt(input) {
        return stub.registerInboundReceipt(input);
      },
      observeInboundForward(input) {
        return stub.observeInboundForward(input);
      },
      getInboundReceipt(receiptId) {
        return stub.getInboundReceipt(receiptId);
      },
      getAddressByMailbox(address) {
        return stub.getAddressByMailbox(address);
      },
      getDestination(id) {
        return stub.getDestination(id);
      },
    },
    nowIso: () => TEST_NOW_ISO,
  };
  return { ports, published, stub };
}

async function rejectPreparation(raw: Uint8Array) {
  const world = await createWorld(`mime-budget-${String(raw.byteLength)}`);
  const accepted = await processInbound(
    new FakeEmail({ to: INBOX, from: SENDER, raw }),
    world.ports,
  );
  expect(accepted.kind).toBe("accepted");
  await indexQueued(world);
  await indexQueued(world);
  const receiptId = world.published[0]?.receiptId ?? "";
  const receipt = await world.stub.getInboundReceipt(receiptId);
  const manifestStored = await testEnv.ARCHIVE.get(receiptManifestKey(receiptId));
  const manifest =
    manifestStored === null
      ? null
      : Schema.decodeSync(Schema.fromJsonString(ReceiptManifest))(
          new TextDecoder().decode(await manifestStored.arrayBuffer()),
        );
  const listed = await testEnv.ARCHIVE.list();
  const messages = await world.stub.listMessageSummaries({ mailboxScope: "all" });
  return {
    receipt,
    manifest,
    messageCount: messages.items.length,
    archiveKeys: listed.objects.map((object) => object.key).sort(),
  };
}

async function indexQueued(world: World): Promise<void> {
  const receiptId = world.published[0]?.receiptId;
  if (receiptId === undefined) {
    throw new Error("expected queued receipt work");
  }
  await Effect.runPromise(
    consumeIndexReceipt(
      receiptId,
      r2ArchiveStore(),
      createMailHtmlPolicy(),
      {
        getInboundReceipt: (id) =>
          Effect.tryPromise({
            try: () => world.stub.getInboundReceipt(id),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
        getAddressByMailbox: (address) =>
          Effect.tryPromise({
            try: () => world.stub.getAddressByMailbox(address),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
        claimInboundReceipt: (input) =>
          Effect.tryPromise({
            try: () => world.stub.claimInboundReceipt(input),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
        acceptInbound: (input) =>
          Effect.tryPromise({
            try: () => world.stub.acceptInbound(input),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
        completeInboundReceipt: (id) =>
          Effect.tryPromise({
            try: () => world.stub.completeInboundReceipt(id),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
        failInboundReceiptPolicy: (input) =>
          Effect.tryPromise({
            try: () => world.stub.failInboundReceiptPolicy(input),
            catch: () => new IndexFailure({ reason: "sql_failed" }),
          }),
      },
      TEST_NOW_ISO,
      CLAIM_UNTIL_ISO,
    ),
  );
}

async function expectIndexedFixture(world: World, fixture: MailCapacityFixture): Promise<void> {
  if (fixture.expected.kind !== "indexed") {
    throw new Error(`expected indexed fixture ${fixture.id}`);
  }
  const receiptId = world.published[0]?.receiptId;
  if (receiptId === undefined) {
    throw new Error(`expected queued receipt for ${fixture.id}`);
  }
  const receipt = await world.stub.getInboundReceipt(receiptId);
  expect(receipt?.workState).toBe("indexed");
  expect(receipt?.policyError).toBeNull();
  expect(receipt?.lastError).toBeNull();

  const messages = await world.stub.listMessageSummaries({ mailboxScope: "all" });
  expect(messages.items).toHaveLength(1);
  const message = messages.items[0];
  expect(message?.id).toBe(receiptId);
  expect(message?.subject).toBe(fixture.expected.subject);
  expect(message?.hasRemoteImages).toBe(fixture.expected.hasRemoteImages);
  expect(
    message?.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })),
  ).toEqual(
    fixture.expected.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.byteLength,
    })),
  );

  const body = await world.stub.getMessageBody(receiptId, "all");
  expect(body?.textBody).toEqual(
    fixture.expected.textIncludes === null
      ? null
      : expect.stringContaining(fixture.expected.textIncludes),
  );
  expect(body?.htmlBody).toEqual(
    fixture.expected.htmlIncludes === null
      ? null
      : expect.stringContaining(fixture.expected.htmlIncludes),
  );

  const stored = await testEnv.ARCHIVE.list({ prefix: `attachments/${receiptId}/` });
  expect(stored.objects).toHaveLength(fixture.expected.attachments.length);
  for (const [position, expected] of fixture.expected.attachments.entries()) {
    const object = await testEnv.ARCHIVE.get(`attachments/${receiptId}/${String(position)}`);
    if (object === null) {
      throw new Error(`expected attachment ${String(position)} for ${fixture.id}`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(await sha256Hex(bytes)).toBe(expected.sha256);
  }
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

async function seedInbox(stub: DurableObjectStub<AccountStoreTestHost>): Promise<void> {
  const normalized = parseMailboxAddress(INBOX);
  if (normalized.kind === "invalid") {
    throw new Error("test fixture address is invalid");
  }
  const created = await stub.createAddress(
    normalized.localPart,
    normalized.domain,
    "Inbox",
    TEST_NOW_ISO,
  );
  expect(created).not.toBeNull();
}
