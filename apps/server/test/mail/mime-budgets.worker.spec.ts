/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import { beforeEach, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import PostalMime from "postal-mime";

import { createMailHtmlPolicy } from "../../src/mail/html-policy.ts";
import { receiveInbound } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/process-index.ts";
import { sha256Hex, WebCrypto } from "../../src/crypto.ts";
import { DEFAULT_MAX_RAW_BYTES, INBOUND_MIME_LIMITS } from "../../src/mail/policy.ts";
import { indexReceipt } from "../../src/mail/process-index.ts";
import { effectAccount, effectBucket, FakeEmail } from "./fakes.ts";
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

layer(WebCrypto)("MIME pre-allocation budgets", (it) => {
  beforeEach(() => reset());

  it.effect("rejects newline-heavy MIME before derived writes and records a policy failure", () =>
    Effect.gen(function* () {
      const outcome = yield* rejectPreparation(overLineCountFixture().raw);
      expect(outcome.receipt?.workState).toBe("policy_failed");
      expect(outcome.receipt?.policyError).toBe("mime_budget");
      expect(outcome.messageCount).toBe(0);
      expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
    }),
  );

  it.effect("rejects nested/attachment amplification at the part budget", () =>
    Effect.gen(function* () {
      const allowed = yield* Effect.promise(() =>
        PostalMime.parse(partCountEml(INBOUND_MIME_LIMITS.maxParts), {
          attachmentEncoding: "arraybuffer",
          ...INBOUND_MIME_LIMITS,
        }),
      );
      expect(allowed.attachments.length).toBeGreaterThan(0);

      const outcome = yield* rejectPreparation(overPartCountFixture().raw);
      expect(outcome.receipt?.policyError).toBe("mime_budget");
      expect(outcome.messageCount).toBe(0);
      expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
    }),
  );

  it.effect("rejects a long References header before derived writes", () =>
    Effect.gen(function* () {
      const outcome = yield* rejectPreparation(overReferencesFixture().raw);
      expect(outcome.receipt?.policyError).toBe("mime_budget");
      expect(outcome.messageCount).toBe(0);
    }),
  );

  it.effect("indexes a short supported message within the measured budgets", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("mime-budgets-ok");
      const raw = plainTextEml("hello");
      yield* receive(world, raw);
      yield* indexQueued(world);
      const listed = yield* listMessages(world);
      expect(listed.items).toHaveLength(1);
      const receipt = yield* receiptOf(world, world.published[0]?.receiptId ?? "");
      expect(receipt?.workState).toBe("indexed");
      expect(receipt?.policyError).toBeNull();
    }),
  );

  it.effect(
    "indexes separately padded base64 units near the configured line budget",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld("mime-budgets-padded-lines");
        const fixture = paddedBase64LinesFixture();
        yield* receive(world, fixture.raw);

        yield* indexQueued(world);

        const receipt = yield* receiptOf(world, world.published[0]?.receiptId ?? "");
        expect(receipt?.workState).toBe("indexed");
        yield* expectIndexedFixture(world, fixture);
      }),
    60_000,
  );

  it.effect(
    "indexes a 20 MiB well-formed attachment message through the full pipeline",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld("mime-budgets-max-raw");
        const fixture = maximumRawAttachmentFixture();
        expect(fixture.raw.byteLength).toBe(DEFAULT_MAX_RAW_BYTES);
        yield* receive(world, fixture.raw);

        yield* indexQueued(world);

        yield* expectIndexedFixture(world, fixture);
      }),
    60_000,
  );

  it.effect.each(
    MAIL_CAPACITY_SUPPORTED_FIXTURES.filter(
      (descriptor) => descriptor.id !== "padded-base64-lines",
    ),
  )(
    "indexes the supported $id fixture through parsing, sanitization, writes, and SQL",
    ({ make }) =>
      Effect.gen(function* () {
        const fixture = make();
        const world = yield* createWorld(`mime-capacity-${fixture.id}`);

        yield* receive(world, fixture.raw);
        yield* indexQueued(world);

        yield* expectIndexedFixture(world, fixture);
      }),
    60_000,
  );

  it.effect.each(MAIL_CAPACITY_ENCODED_MAXIMUM_FIXTURES)(
    "indexes the exact-size encoded $id fixture with its expected attachment hash",
    ({ make }) =>
      Effect.gen(function* () {
        const fixture = make();
        expect(fixture.raw.byteLength).toBe(DEFAULT_MAX_RAW_BYTES);
        const world = yield* createWorld(`mime-capacity-${fixture.id}`);

        yield* receive(world, fixture.raw);
        yield* indexQueued(world);

        yield* expectIndexedFixture(world, fixture);
      }),
    60_000,
  );

  it.effect.each(
    MAIL_CAPACITY_REJECTED_FIXTURES.filter(
      (descriptor) =>
        descriptor.id !== "over-line-count" &&
        descriptor.id !== "over-part-count" &&
        descriptor.id !== "over-references",
    ),
  )(
    "terminates the rejected $id fixture without derived persistence",
    ({ make }) =>
      Effect.gen(function* () {
        const fixture = make();
        if (fixture.expected.kind !== "policy_failed") {
          return yield* Effect.die(new Error(`expected policy-failure fixture ${fixture.id}`));
        }

        const outcome = yield* rejectPreparation(fixture.raw);

        expect(outcome.receipt?.workState).toBe("policy_failed");
        expect(outcome.receipt?.policyError).toBe(fixture.expected.reason);
        expect(outcome.messageCount).toBe(0);
        expect(outcome.archiveKeys.filter((key) => key.startsWith("attachments/"))).toEqual([]);
      }),
    60_000,
  );

  it.effect.each(MAIL_CAPACITY_TEXT_ONLY_FIXTURES)(
    "indexes the $id fixture without HTML when the sanitizer gives up",
    ({ make }) =>
      Effect.gen(function* () {
        const fixture = make();
        const world = yield* createWorld(`mime-text-only-${fixture.id}`);

        yield* receive(world, fixture.raw);
        yield* indexQueued(world);

        const receiptId = world.published[0]?.receiptId ?? "";
        expect((yield* receiptOf(world, receiptId))?.workState).toBe("indexed");
        const messages = yield* listMessages(world);
        expect(messages.items.map((message) => message.id)).toEqual([receiptId]);
        expect((yield* messageBodyOf(world, receiptId))?.htmlBody).toBeNull();
      }),
    60_000,
  );
});

type World = {
  readonly published: IndexReceiptWork[];
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
};

const createWorld = Effect.fn("createWorld")(function* (accountName: string) {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  yield* seedInbox(stub);
  const world: World = { published: [], stub };
  return world;
});

const receive = Effect.fn("receive")(function* (world: World, raw: Uint8Array) {
  const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
  yield* receiveInbound(email, {
    archive: effectBucket(testEnv.ARCHIVE),
    index: {
      send: (body) =>
        Effect.promise(() => {
          world.published.push(body);
          return testEnv.INDEX.send(body);
        }),
    },
    account: effectAccount(world.stub),
    nowIso: TEST_NOW_ISO,
  });
  expect(email.rejectReason).toBeNull();
});

const rejectPreparation = Effect.fn("rejectPreparation")(function* (raw: Uint8Array) {
  const world = yield* createWorld(`mime-budget-${String(raw.byteLength)}`);
  yield* receive(world, raw);
  yield* indexQueued(world);
  yield* indexQueued(world);
  const receipt = yield* receiptOf(world, world.published[0]?.receiptId ?? "");
  const listed = yield* Effect.promise(() => testEnv.ARCHIVE.list());
  const messages = yield* listMessages(world);
  return {
    receipt,
    messageCount: messages.items.length,
    archiveKeys: listed.objects.map((object) => object.key).sort(),
  };
});

const indexQueued = Effect.fn("indexQueued")(function* (world: World) {
  const receiptId = world.published[0]?.receiptId;
  if (receiptId === undefined) {
    return yield* Effect.die(new Error("expected queued receipt work"));
  }
  yield* indexReceipt(receiptId, {
    archive: effectBucket(testEnv.ARCHIVE),
    account: effectAccount(world.stub),
    htmlPolicy: createMailHtmlPolicy(),
    nowIso: TEST_NOW_ISO,
  });
});

const expectIndexedFixture = Effect.fn("expectIndexedFixture")(function* (
  world: World,
  fixture: MailCapacityFixture,
) {
  if (fixture.expected.kind !== "indexed") {
    return yield* Effect.die(new Error(`expected indexed fixture ${fixture.id}`));
  }
  const receiptId = world.published[0]?.receiptId;
  if (receiptId === undefined) {
    return yield* Effect.die(new Error(`expected queued receipt for ${fixture.id}`));
  }
  const receipt = yield* receiptOf(world, receiptId);
  expect(receipt?.workState).toBe("indexed");
  expect(receipt?.policyError).toBeNull();

  const messages = yield* listMessages(world);
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

  const body = yield* messageBodyOf(world, receiptId);
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

  const stored = yield* Effect.promise(() =>
    testEnv.ARCHIVE.list({ prefix: `attachments/${receiptId}/` }),
  );
  expect(stored.objects).toHaveLength(fixture.expected.attachments.length);
  const archive = effectBucket(testEnv.ARCHIVE);
  for (const [position, expected] of fixture.expected.attachments.entries()) {
    const object = yield* archive.get(`attachments/${receiptId}/${String(position)}`);
    if (object === null) {
      return yield* Effect.die(
        new Error(`expected attachment ${String(position)} for ${fixture.id}`),
      );
    }
    const bytes = new Uint8Array(yield* object.arrayBuffer());
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(yield* sha256Hex(bytes)).toBe(expected.sha256);
  }
});

function receiptOf(world: World, receiptId: string) {
  return Effect.promise(() => world.stub.getInboundReceipt(receiptId));
}

function listMessages(world: World) {
  return Effect.promise(() => world.stub.listMessageSummaries({ mailboxScope: "all" }));
}

function messageBodyOf(world: World, receiptId: string) {
  return Effect.promise(() => world.stub.getMessageBody(receiptId, "all"));
}

const seedInbox = Effect.fn("seedInbox")(function* (stub: DurableObjectStub<AccountStoreTestHost>) {
  const normalized = parseMailboxAddress(INBOX);
  if (normalized.kind === "invalid") {
    return yield* Effect.die(new Error("test fixture address is invalid"));
  }
  const created = yield* Effect.promise(() =>
    stub.createAddress(normalized.localPart, normalized.domain, "Inbox", TEST_NOW_ISO),
  );
  expect(created).not.toBeNull();
});
