/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";

import { inboundMessageId } from "../../src/mail/archive.ts";
import { receiveInbound, type InboundDeps } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/process-index.ts";
import { DEFAULT_MAX_RAW_BYTES, rawObjectKey, sha256Hex } from "../../src/mail/policy.ts";
import { effectAccount, effectBucket, FakeEmail } from "./fakes.ts";
import type { AccountStoreTestHost } from "../account/worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as TestEnv;

const INBOX = "inbox@umail.example.com";
const OTHER_INBOX = "other@umail.example.com";
const SENDER = "sender@example.com";
const FORWARD_DEST = "owner@example.com";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";
const LATER_NOW_ISO = "2026-01-02T00:00:00.000Z";

describe("inbound receipts", () => {
  beforeEach(async () => {
    await reset();
  });

  it("archives the raw bytes by digest, registers a ready receipt, forwards and publishes", async () => {
    const world = createWorld("receipts-archive");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>Hi</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await world.receive(email);

    const receiptId = await identityFor(raw, INBOX);
    expect(email.rejectReason).toBeNull();
    expect(email.forwards).toEqual([FORWARD_DEST]);
    expect(world.published).toEqual([{ version: 1, receiptId }]);
    const rawKey = rawObjectKey(await sha256Hex(raw));
    expect(await listArchiveKeys()).toEqual([rawKey]);
    const stored = await testEnv.ARCHIVE.get(rawKey);
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(raw);
    expect(await world.stub.getInboundReceipt(receiptId)).toEqual({
      receiptId,
      envelopeFrom: SENDER,
      envelopeTo: INBOX,
      rawKey,
      receivedAt: TEST_NOW_ISO,
      forwardOutcome: "success",
      forwardDestination: FORWARD_DEST,
      workState: "ready",
      policyError: null,
      retryAfter: "2026-01-01T00:05:00.000Z",
    });
  });

  it("rejects when the bytes read exceed the limit even if the advertised size is small", async () => {
    const world = createWorld("receipts-actual-size");
    await seedMailbox(world.stub, INBOX);
    const raw = new Uint8Array(DEFAULT_MAX_RAW_BYTES + 1);
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw, rawSize: 16 });

    await world.receive(email);

    expect(email.rejectReason).toBe("message too large");
    expect(await listArchiveKeys()).toEqual([]);
    expect(world.published).toEqual([]);
  });

  it("rejects advertised oversize without archiving or publishing", async () => {
    const world = createWorld("receipts-advertised-oversize");
    await seedMailbox(world.stub, INBOX);
    const email = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw: plainHtmlEml(INBOX, "<p>Hi</p>"),
      rawSize: DEFAULT_MAX_RAW_BYTES + 1,
    });

    await world.receive(email);

    expect(email.rejectReason).toBe("message too large");
    expect(await listArchiveKeys()).toEqual([]);
    expect(world.published).toEqual([]);
  });

  it("fails the handler when the raw object write fails", async () => {
    const world = createWorld("receipts-raw-fail", { fail: "archive" });
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>raw</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(world.receive(email)).rejects.toThrow("archive put failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    expect(await world.stub.getInboundReceipt(await identityFor(raw, INBOX))).toBeNull();
  });

  it("fails the handler when registration fails after a durable archive", async () => {
    const world = createWorld("receipts-register-fail", { fail: "register" });
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>register</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(world.receive(email)).rejects.toThrow("register failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    expect(await listArchiveKeys()).toEqual([rawObjectKey(await sha256Hex(raw))]);
    expect(await world.stub.getInboundReceipt(await identityFor(raw, INBOX))).toBeNull();
  });

  it("fails the handler when publication fails after a durable receipt", async () => {
    const world = createWorld("receipts-publish-fail", { fail: "publish" });
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>publish</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(world.receive(email)).rejects.toThrow("index send failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    const receipt = await world.stub.getInboundReceipt(await identityFor(raw, INBOX));
    expect(receipt?.workState).toBe("ready");
    expect(receipt).toMatchObject({ forwardOutcome: "success", forwardDestination: FORWARD_DEST });
  });

  it("keeps distinct receipts for distinct recipients of the same raw bytes", async () => {
    const world = createWorld("receipts-distinct");
    await seedMailbox(world.stub, INBOX);
    await seedMailbox(world.stub, OTHER_INBOX);
    const raw = plainHtmlEml(INBOX, "<p>shared</p>");

    await world.receive(new FakeEmail({ to: INBOX, from: SENDER, raw }));
    await world.receive(new FakeEmail({ to: OTHER_INBOX, from: SENDER, raw }));

    const first = await world.stub.getInboundReceipt(await identityFor(raw, INBOX));
    const second = await world.stub.getInboundReceipt(await identityFor(raw, OTHER_INBOX));
    expect(world.published.map((work) => work.receiptId)).toEqual([
      first?.receiptId,
      second?.receiptId,
    ]);
    expect(first?.receiptId).not.toBe(second?.receiptId);
    expect(first?.envelopeTo).toBe(INBOX);
    expect(second?.envelopeTo).toBe(OTHER_INBOX);
    expect(first?.rawKey).toBe(second?.rawKey);
    expect(await listArchiveKeys()).toEqual([first?.rawKey]);
  });

  it("rejects mail for an inactive mailbox without forwarding it", async () => {
    const inactive = createWorld("receipts-inactive");
    await seedMailbox(inactive.stub, INBOX, { destination: FORWARD_DEST, active: false });
    const inactiveEmail = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw: plainHtmlEml(INBOX, "<p>inactive</p>"),
    });
    await inactive.receive(inactiveEmail);
    expect(inactiveEmail.rejectReason).toBe("unknown recipient");
    expect(inactiveEmail.forwards).toEqual([]);
    expect(await listArchiveKeys()).toEqual([]);
  });

  // Cloudflare refuses a destination that has not been verified yet, among other reasons.
  it("records a refused forward and still accepts the message", async () => {
    const world = createWorld("receipts-forward-fail");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>forward</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
    email.failNextForward();

    await world.receive(email);

    const receiptId = await identityFor(raw, INBOX);
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([{ version: 1, receiptId }]);
    expect(await world.stub.getInboundReceipt(receiptId)).toMatchObject({
      forwardOutcome: "failure",
      forwardDestination: FORWARD_DEST,
    });
  });

  it("does not native-forward again on duplicate envelope replay", async () => {
    const world = createWorld("receipts-replay");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>replay</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await world.receive(first);
    const replay = createWorld("receipts-replay", { nowIso: LATER_NOW_ISO });
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await replay.receive(second);

    const receiptId = await identityFor(raw, INBOX);
    expect(first.forwards).toEqual([FORWARD_DEST]);
    expect(second.forwards).toEqual([]);
    expect(world.published).toEqual([{ version: 1, receiptId }]);
    expect(replay.published).toEqual([{ version: 1, receiptId }]);
    const receipt = await world.stub.getInboundReceipt(receiptId);
    expect(receipt?.receivedAt).toBe(TEST_NOW_ISO);
    expect(receipt).toMatchObject({ forwardOutcome: "success", forwardDestination: FORWARD_DEST });
  });

  it("records unknown forwarding after interruption and does not overwrite it on replay", async () => {
    const interrupted = createWorld("receipts-unknown", { fail: "observe-success" });
    await seedMailbox(interrupted.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>unknown</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await expect(interrupted.receive(first)).rejects.toThrow("observe failed");
    expect(first.forwards).toEqual([FORWARD_DEST]);
    const receiptId = await identityFor(raw, INBOX);
    expect(await interrupted.stub.getInboundReceipt(receiptId)).toMatchObject({
      receivedAt: TEST_NOW_ISO,
      forwardOutcome: "unknown",
      forwardDestination: FORWARD_DEST,
    });

    const replay = createWorld("receipts-unknown", { nowIso: LATER_NOW_ISO });
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    second.failNextForward();
    await replay.receive(second);
    expect(second.forwards).toEqual([]);
    expect(replay.published).toEqual([{ version: 1, receiptId }]);
    expect(await replay.stub.getInboundReceipt(receiptId)).toMatchObject({
      receivedAt: TEST_NOW_ISO,
      forwardOutcome: "unknown",
      forwardDestination: FORWARD_DEST,
    });
  });

  it("does not overwrite a settled forwarding observation on a duplicate envelope", async () => {
    const world = createWorld("receipts-settled");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>settled</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await world.receive(first);
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    second.failNextForward();
    await world.receive(second);

    const receipt = await world.stub.getInboundReceipt(await identityFor(raw, INBOX));
    expect(first.forwards).toEqual([FORWARD_DEST]);
    expect(second.forwards).toEqual([]);
    expect(receipt).toMatchObject({ forwardOutcome: "success", forwardDestination: FORWARD_DEST });
  });
});

type WorldOptions = {
  readonly fail?: "archive" | "register" | "observe-success" | "publish";
  readonly nowIso?: string;
};

function createWorld(accountName: string, options: WorldOptions = {}) {
  const published: IndexReceiptWork[] = [];
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const account = effectAccount(stub);
  const archive = effectBucket(testEnv.ARCHIVE);
  const deps: InboundDeps<never> = {
    archive: {
      put: (key, value) =>
        options.fail === "archive"
          ? Effect.die(new Error("archive put failed"))
          : archive.put(key, value),
    },
    index: {
      send: (body) =>
        options.fail === "publish"
          ? Effect.die(new Error("index send failed"))
          : Effect.promise(async () => {
              published.push(body);
              await testEnv.INDEX.send(body);
            }),
    },
    account: {
      ...account,
      registerInboundReceipt: (input) =>
        options.fail === "register"
          ? Effect.die(new Error("register failed"))
          : account.registerInboundReceipt(input),
      observeInboundForward: (input) =>
        options.fail === "observe-success" && input.observation.kind === "success"
          ? Effect.die(new Error("observe failed"))
          : account.observeInboundForward(input),
    },
    nowIso: options.nowIso ?? TEST_NOW_ISO,
  };
  return {
    stub,
    published,
    receive: (email: FakeEmail) => Effect.runPromise(receiveInbound(email, deps)),
  };
}

async function seedMailbox(
  stub: DurableObjectStub<AccountStoreTestHost>,
  address: string,
  options: {
    readonly destination?: string;
    readonly active?: boolean;
  } = {},
): Promise<void> {
  const normalized = parseOk(address);
  const created = await stub.createAddress(
    normalized.localPart,
    normalized.domain,
    "Inbox",
    TEST_NOW_ISO,
  );
  if (created === null) {
    throw new Error("expected seeded mailbox");
  }
  if (options.destination !== undefined) {
    await stub.setAddressForwarding(created.id, options.destination, TEST_NOW_ISO);
  }
  if (options.active === false) {
    const patched = await stub.patchAddress(created.id, { active: false }, TEST_NOW_ISO);
    if (patched === null) {
      throw new Error("expected mailbox patch");
    }
  }
}

async function listArchiveKeys(): Promise<string[]> {
  const listed = await testEnv.ARCHIVE.list();
  return listed.objects.map((object) => object.key).sort();
}

async function identityFor(raw: Uint8Array, to: string): Promise<string> {
  return inboundMessageId(await sha256Hex(raw), { from: SENDER, to: parseOk(to).address });
}

function parseOk(address: string) {
  const parsed = parseMailboxAddress(address);
  if (parsed.kind === "invalid") {
    throw new Error("expected valid mailbox address");
  }
  return parsed;
}

function plainHtmlEml(to: string, html: string): Uint8Array {
  return new TextEncoder().encode(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Subject: Hello",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\r\n"),
  );
}
