/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";

import { createMailHtmlPolicy } from "../../src/mail/html-policy.ts";
import { receiveInbound } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/process-index.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { DEFAULT_MAX_RAW_BYTES, INBOUND_MIME_LIMITS } from "../../src/mail/policy.ts";
import { indexReceipt } from "../../src/mail/process-index.ts";
import { effectAccount, effectBucket, FakeEmail, runWithCrypto } from "./fakes.ts";
import {
  MAIL_CAPACITY_INBOX,
  MAIL_CAPACITY_SUPPORTED_FIXTURES,
  MAIL_CAPACITY_REJECTED_FIXTURES,
  MAIL_CAPACITY_TEXT_ONLY_FIXTURES,
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
import type { AccountStoreTestHost } from "../account/worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as TestEnv;

const INBOX = MAIL_CAPACITY_INBOX;
const SENDER = "sender@example.com";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";

describe("MIME pre-allocation budgets", () => {
  beforeEach(async () => {
    await reset();
  });

  it("rejects newline-heavy MIME before derived writes and records a policy failure", async () => {
    const outcome = await rejectPreparation(overLineCountFixture().raw);
    expect(outcome.receipt?.workState).toBe("policy_failed");
    expect(outcome.receipt?.policyError).toBe("mime_budget");
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
    expect(outcome.messageCount).toBe(0);
    expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
  });

  it("rejects a long References header before derived writes", async () => {
    const outcome = await rejectPreparation(overReferencesFixture().raw);
    expect(outcome.receipt?.policyError).toBe("mime_budget");
    expect(outcome.messageCount).toBe(0);
  });

  it("indexes a short supported message within the measured budgets", async () => {
    const world = await createWorld("mime-budgets-ok");
    const raw = plainTextEml("hello");
    await receive(world, raw);
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
    await receive(world, fixture.raw);

    await indexQueued(world);

    const receipt = await world.stub.getInboundReceipt(world.published[0]?.receiptId ?? "");
    expect(receipt?.workState).toBe("indexed");
    await expectIndexedFixture(world, fixture);
  }, 60_000);

  it("indexes a 20 MiB well-formed attachment message through the full pipeline", async () => {
    const world = await createWorld("mime-budgets-max-raw");
    const fixture = maximumRawAttachmentFixture();
    expect(fixture.raw.byteLength).toBe(DEFAULT_MAX_RAW_BYTES);
    await receive(world, fixture.raw);

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

      await receive(world, fixture.raw);
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

      await receive(world, fixture.raw);
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
      expect(outcome.messageCount).toBe(0);
      expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
    },
    60_000,
  );

  it.each(MAIL_CAPACITY_TEXT_ONLY_FIXTURES)(
    "indexes the $id fixture without HTML when the sanitizer gives up",
    async ({ make }) => {
      const fixture = make();
      const world = await createWorld(`mime-text-only-${fixture.id}`);

      await receive(world, fixture.raw);
      await indexQueued(world);

      const receiptId = world.published[0]?.receiptId ?? "";
      expect((await world.stub.getInboundReceipt(receiptId))?.workState).toBe("indexed");
      const messages = await world.stub.listMessageSummaries({ mailboxScope: "all" });
      expect(messages.items.map((message) => message.id)).toEqual([receiptId]);
      expect((await world.stub.getMessageBody(receiptId, "all"))?.htmlBody).toBeNull();
    },
    60_000,
  );
});

type World = {
  readonly published: IndexReceiptWork[];
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
};

async function createWorld(accountName: string): Promise<World> {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  await seedInbox(stub);
  return { published: [], stub };
}

async function receive(world: World, raw: Uint8Array): Promise<void> {
  const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
  await runWithCrypto(
    receiveInbound(email, {
      archive: effectBucket(testEnv.ARCHIVE),
      index: {
        send: (body) =>
          Effect.promise(async () => {
            world.published.push(body);
            await testEnv.INDEX.send(body);
          }),
      },
      account: effectAccount(world.stub),
      nowIso: TEST_NOW_ISO,
    }),
  );
  expect(email.rejectReason).toBeNull();
}

async function rejectPreparation(raw: Uint8Array) {
  const world = await createWorld(`mime-budget-${String(raw.byteLength)}`);
  await receive(world, raw);
  await indexQueued(world);
  await indexQueued(world);
  const receipt = await world.stub.getInboundReceipt(world.published[0]?.receiptId ?? "");
  const listed = await testEnv.ARCHIVE.list();
  const messages = await world.stub.listMessageSummaries({ mailboxScope: "all" });
  return {
    receipt,
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
    indexReceipt(receiptId, {
      archive: effectBucket(testEnv.ARCHIVE),
      account: effectAccount(world.stub),
      htmlPolicy: createMailHtmlPolicy(),
      nowIso: TEST_NOW_ISO,
    }),
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
    expect(await runWithCrypto(sha256Hex(bytes))).toBe(expected.sha256);
  }
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
