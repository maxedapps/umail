/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import { beforeEach, expect, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { createMailHtmlPolicy } from "../../src/mail/html-policy.ts";
import type { MessageConflictError } from "../../src/account/errors.ts";
import { inboundMessageId } from "../../src/mail/archive.ts";
import { sha256Hex, WebCrypto } from "../../src/crypto.ts";
import { INBOUND_MIME_LIMITS, rawObjectKey } from "../../src/mail/policy.ts";
import { indexReceipt, type IndexDeps } from "../../src/mail/process-index.ts";
import { effectAccount, effectBucket } from "./fakes.ts";
import { foldedBase64Fixture } from "./mail-capacity-fixtures.ts";
import type { AccountStoreTestHost } from "../account/worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as TestEnv;

const INBOX = "inbox@umail.example.com";
const SENDER = "sender@example.com";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";

layer(WebCrypto)("index consumer", (it) => {
  beforeEach(() => reset());

  it.effect("indexes a registered receipt with its attachment", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-ok");
      const fixture = indexedFoldedBase64Fixture();
      const receiptId = yield* archiveRegistered(world, fixture.raw);

      yield* run(world, receiptId);

      expect((yield* receiptOf(world, receiptId))?.workState).toBe("indexed");
      const listed = yield* listMessages(world);
      expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
      expect(listed.items[0]?.subject).toBe(fixture.expected.subject);
      const expectedAttachment = fixture.expected.attachments[0];
      const stored = yield* effectBucket(testEnv.ARCHIVE).get(`attachments/${receiptId}/0`);
      const bytes = new Uint8Array(
        stored === null ? new ArrayBuffer(0) : yield* stored.arrayBuffer(),
      );
      expect(bytes.byteLength).toBe(expectedAttachment?.byteLength);
      expect(yield* sha256Hex(bytes)).toBe(expectedAttachment?.sha256);
    }),
  );

  it.effect("acks a duplicate delivery without storing a second message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-duplicate");
      const receiptId = yield* archiveRegistered(world, plainTextEml("dup"));

      yield* run(world, receiptId);
      yield* run(world, receiptId);

      const listed = yield* listMessages(world);
      expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
    }),
  );

  it.effect("stores one message when two deliveries of a receipt run concurrently", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-concurrent");
      const receiptId = yield* archiveRegistered(world, plainTextEml("race"));

      yield* Effect.all([run(world, receiptId), run(world, receiptId)], { concurrency: 2 });

      expect((yield* receiptOf(world, receiptId))?.workState).toBe("indexed");
      const listed = yield* listMessages(world);
      expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
    }),
  );

  it.effect("fails on a raw read error and leaves the receipt ready for a retry", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-read-fail");
      const receiptId = yield* archiveRegistered(world, plainTextEml("read"));
      const archive = effectBucket(testEnv.ARCHIVE);

      const exit = yield* Effect.exit(
        run(world, receiptId, {
          archive: { ...archive, get: () => Effect.die(new Error("R2 read failed")) },
        }),
      );
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "succeeded").toContain(
        "R2 read failed",
      );
      expect((yield* receiptOf(world, receiptId))?.workState).toBe("ready");
      expect((yield* listMessages(world)).items).toEqual([]);

      yield* run(world, receiptId);
      expect((yield* receiptOf(world, receiptId))?.workState).toBe("indexed");
    }),
  );

  it.effect("records a content-policy failure and acks it", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-policy");
      const receiptId = yield* archiveRegistered(world, oversizedHeaderEml());

      yield* run(world, receiptId);

      expect(yield* receiptOf(world, receiptId)).toMatchObject({
        workState: "policy_failed",
        policyError: "parse_failed",
      });
      expect((yield* listMessages(world)).items).toEqual([]);
    }),
  );

  it.effect("treats a message conflict that arrives as a plain RPC error object as indexed", () =>
    Effect.gen(function* () {
      const world = yield* createWorld("index-conflict");
      const receiptId = yield* archiveRegistered(world, plainTextEml("conflict"));
      const account = effectAccount(world.stub);
      // Alchemy's DO bridge delivers expected errors as plain `{ _tag, ... }` objects.
      const conflict = { _tag: "MessageConflictError", messageId: receiptId };

      expect(
        yield* run(world, receiptId, {
          account: {
            ...account,
            acceptInbound: () => Effect.fail(conflict as MessageConflictError),
          },
        }),
      ).toBeUndefined();
    }),
  );
});

type World = {
  readonly stub: DurableObjectStub<AccountStoreTestHost>;
};

const createWorld = Effect.fn("createWorld")(function* (accountName: string) {
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const mailbox = parsedInbox();
  const created = yield* Effect.promise(() =>
    stub.createAddress(mailbox.localPart, mailbox.domain, "Inbox", TEST_NOW_ISO),
  );
  expect(created).not.toBeNull();
  return { stub };
});

const archiveRegistered = Effect.fn("archiveRegistered")(function* (world: World, raw: Uint8Array) {
  const digest = yield* sha256Hex(raw);
  const receiptId = yield* inboundMessageId(digest, { from: SENDER, to: parsedInbox().address });
  yield* Effect.promise(() => testEnv.ARCHIVE.put(rawObjectKey(digest), raw));
  yield* Effect.promise(() =>
    world.stub.registerInboundReceipt({
      receiptId,
      envelopeFrom: SENDER,
      envelopeTo: INBOX,
      rawKey: rawObjectKey(digest),
      receivedAt: TEST_NOW_ISO,
    }),
  );
  return receiptId;
});

function receiptOf(world: World, receiptId: string) {
  return Effect.promise(() => world.stub.getInboundReceipt(receiptId));
}

function listMessages(world: World) {
  return Effect.promise(() => world.stub.listMessageSummaries({ mailboxScope: "all" }));
}

function run(world: World, receiptId: string, overrides: Partial<IndexDeps<never>> = {}) {
  return indexReceipt(receiptId, {
    archive: effectBucket(testEnv.ARCHIVE),
    account: effectAccount(world.stub),
    htmlPolicy: createMailHtmlPolicy(),
    nowIso: TEST_NOW_ISO,
    ...overrides,
  });
}

function indexedFoldedBase64Fixture() {
  const fixture = foldedBase64Fixture();
  if (fixture.expected.kind !== "indexed") {
    throw new Error("expected the folded attachment fixture to be indexed");
  }
  return { raw: fixture.raw, expected: fixture.expected };
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
    ].join("\r\n"),
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
