/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";

import { createMailHtmlPolicy } from "../../src/mail/html-policy.ts";
import type { MessageConflictError } from "../../src/account/errors.ts";
import { inboundMessageId } from "../../src/mail/archive.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { INBOUND_MIME_LIMITS, rawObjectKey } from "../../src/mail/policy.ts";
import { indexReceipt, type IndexDeps } from "../../src/mail/process-index.ts";
import { effectAccount, effectBucket, runWithCrypto } from "./fakes.ts";
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

describe("index consumer", () => {
  beforeEach(async () => {
    await reset();
  });

  it("indexes a registered receipt with its attachment", async () => {
    const world = await createWorld("index-ok");
    const fixture = foldedBase64Fixture();
    if (fixture.expected.kind !== "indexed") {
      throw new Error("expected the folded attachment fixture to be indexed");
    }
    const receiptId = await archiveRegistered(world, fixture.raw);

    await run(world, receiptId);

    expect((await world.stub.getInboundReceipt(receiptId))?.workState).toBe("indexed");
    const listed = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
    expect(listed.items[0]?.subject).toBe(fixture.expected.subject);
    const expectedAttachment = fixture.expected.attachments[0];
    const stored = await testEnv.ARCHIVE.get(`attachments/${receiptId}/0`);
    const bytes = new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(bytes.byteLength).toBe(expectedAttachment?.byteLength);
    expect(await runWithCrypto(sha256Hex(bytes))).toBe(expectedAttachment?.sha256);
  });

  it("acks a duplicate delivery without storing a second message", async () => {
    const world = await createWorld("index-duplicate");
    const receiptId = await archiveRegistered(world, plainTextEml("dup"));

    await run(world, receiptId);
    await run(world, receiptId);

    const listed = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
  });

  it("stores one message when two deliveries of a receipt run concurrently", async () => {
    const world = await createWorld("index-concurrent");
    const receiptId = await archiveRegistered(world, plainTextEml("race"));

    await Promise.all([run(world, receiptId), run(world, receiptId)]);

    expect((await world.stub.getInboundReceipt(receiptId))?.workState).toBe("indexed");
    const listed = await world.stub.listMessageSummaries({ mailboxScope: "all" });
    expect(listed.items.map((message) => message.id)).toEqual([receiptId]);
  });

  it("fails on a raw read error and leaves the receipt ready for a retry", async () => {
    const world = await createWorld("index-read-fail");
    const receiptId = await archiveRegistered(world, plainTextEml("read"));
    const archive = effectBucket(testEnv.ARCHIVE);

    await expect(
      run(world, receiptId, {
        archive: { ...archive, get: () => Effect.die(new Error("R2 read failed")) },
      }),
    ).rejects.toThrow("R2 read failed");
    expect((await world.stub.getInboundReceipt(receiptId))?.workState).toBe("ready");
    expect((await world.stub.listMessageSummaries({ mailboxScope: "all" })).items).toEqual([]);

    await run(world, receiptId);
    expect((await world.stub.getInboundReceipt(receiptId))?.workState).toBe("indexed");
  });

  it("records a content-policy failure and acks it", async () => {
    const world = await createWorld("index-policy");
    const receiptId = await archiveRegistered(world, oversizedHeaderEml());

    await run(world, receiptId);

    expect(await world.stub.getInboundReceipt(receiptId)).toMatchObject({
      workState: "policy_failed",
      policyError: "parse_failed",
    });
    expect((await world.stub.listMessageSummaries({ mailboxScope: "all" })).items).toEqual([]);
  });

  it("treats a message conflict that arrives as a plain RPC error object as indexed", async () => {
    const world = await createWorld("index-conflict");
    const receiptId = await archiveRegistered(world, plainTextEml("conflict"));
    const account = effectAccount(world.stub);
    // Alchemy's DO bridge delivers expected errors as plain `{ _tag, ... }` objects.
    const conflict = { _tag: "MessageConflictError", messageId: receiptId };

    await expect(
      run(world, receiptId, {
        account: {
          ...account,
          acceptInbound: () => Effect.fail(conflict as MessageConflictError),
        },
      }),
    ).resolves.toBeUndefined();
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

async function archiveRegistered(world: World, raw: Uint8Array): Promise<string> {
  const digest = await runWithCrypto(sha256Hex(raw));
  const receiptId = await runWithCrypto(
    inboundMessageId(digest, { from: SENDER, to: parsedInbox().address }),
  );
  await testEnv.ARCHIVE.put(rawObjectKey(digest), raw);
  await world.stub.registerInboundReceipt({
    receiptId,
    envelopeFrom: SENDER,
    envelopeTo: INBOX,
    rawKey: rawObjectKey(digest),
    receivedAt: TEST_NOW_ISO,
  });
  return receiptId;
}

function run(world: World, receiptId: string, overrides: Partial<IndexDeps<never>> = {}) {
  return Effect.runPromise(
    indexReceipt(receiptId, {
      archive: effectBucket(testEnv.ARCHIVE),
      account: effectAccount(world.stub),
      htmlPolicy: createMailHtmlPolicy(),
      nowIso: TEST_NOW_ISO,
      ...overrides,
    }),
  );
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
