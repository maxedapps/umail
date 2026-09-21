/// <reference types="@cloudflare/vitest-plugin/types" />

import type {
  ObserveInboundForwardInput,
  RegisterInboundReceiptInput,
} from "../../src/account/domain.ts";
import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  InboundAccount,
  InboundArchive,
  InboundDisposition,
  InboundIndex,
  InboundPorts,
} from "../../src/mail/inbound.ts";
import { processInbound } from "../../src/mail/inbound.ts";
import { inboundMessageId } from "../../src/mail/archive.ts";
import type { IndexReceiptWork } from "../../src/mail/index-payload.ts";
import { DEFAULT_MAX_RAW_BYTES, rawObjectKey, sha256Hex } from "../../src/mail/policy.ts";
import { ReceiptManifest, receiptManifestKey } from "../../src/mail/archive.ts";
import { FakeEmail } from "./fakes.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

type TestEnv = {
  readonly ARCHIVE: R2Bucket;
  readonly INDEX: Queue;
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
  readonly ACCOUNT_ID: string;
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

  it("writes a content-addressed raw object and a versioned envelope manifest", async () => {
    const world = createWorld("receipts-archive");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>Hi</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    const accepted = await processInbound(email, world.ports);

    expect(accepted.kind).toBe("accepted");
    expect(email.rejectReason).toBeNull();
    expect(email.forwards).toEqual([FORWARD_DEST]);
    expect(world.published).toEqual([
      { version: 1, receiptId: expect.stringMatching(/^in_[a-f0-9]{64}$/) },
    ]);

    const receiptId = world.published[0]?.receiptId;
    expect(receiptId).toBeDefined();
    if (receiptId === undefined) return;
    const expectedId = await inboundMessageId(expectDigest(accepted), {
      from: SENDER,
      to: parseOk(INBOX),
    });
    expect(receiptId).toBe(expectedId);

    const rawStored = await testEnv.ARCHIVE.get(rawObjectKey(expectDigest(accepted)));
    expect(rawStored).not.toBeNull();
    expect(new Uint8Array(await requireObject(rawStored).arrayBuffer())).toEqual(raw);

    const manifestStored = await testEnv.ARCHIVE.get(receiptManifestKey(receiptId));
    const manifest = Schema.decodeSync(Schema.fromJsonString(ReceiptManifest))(
      new TextDecoder().decode(await requireObject(manifestStored).arrayBuffer()),
    );
    expect(manifest).toEqual({
      version: 1,
      receiptId,
      digest: expectDigest(accepted),
      rawKey: rawObjectKey(expectDigest(accepted)),
      envelope: { from: SENDER, to: parseOk(INBOX) },
      receivedAt: TEST_NOW_ISO,
      advertisedRawSize: raw.byteLength,
      consumedBytes: raw.byteLength,
    });

    const receipt = await world.account.getInboundReceipt(receiptId);
    expect(receipt).toMatchObject({
      receiptId,
      receivedAt: TEST_NOW_ISO,
      consumedBytes: raw.byteLength,
      advertisedRawSize: raw.byteLength,
      workState: "ready",
      forward: { kind: "success", destination: FORWARD_DEST },
    });
  });

  it("rejects when consumed bytes exceed the policy even if advertised size is small", async () => {
    const world = createWorld("receipts-actual-size");
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>too large actual body</p>");
    const email = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw,
      rawSize: 16,
    });

    const result = await processInbound(email, world.ports, { maxRawBytes: 32 });

    expect(result).toEqual({ kind: "rejected", reason: "message too large" });
    expect(email.rejectReason).toBe("message too large");
    expect(await listArchiveKeys()).toEqual([]);
    expect(world.published).toEqual([]);
    expect(await world.account.getInboundReceipt(await identityFor(raw, INBOX))).toBeNull();
  });

  it("fails the handler when the raw object write fails", async () => {
    const world = createWorld("receipts-raw-fail", {
      archiveFailure: { kind: "prefix", prefix: "raw/" },
    });
    await seedMailbox(world.stub, INBOX);
    const email = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw: plainHtmlEml(INBOX, "<p>raw</p>"),
    });

    await expect(processInbound(email, world.ports)).rejects.toThrow("archive put failed");
    expect(email.rejectReason).toBeNull();
    expect(await listArchiveKeys()).toEqual([]);
    expect(world.published).toEqual([]);
  });

  it("fails the handler when the manifest write fails after a raw write", async () => {
    const world = createWorld("receipts-manifest-fail", {
      archiveFailure: { kind: "prefix", prefix: "receipts/" },
    });
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>manifest</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(processInbound(email, world.ports)).rejects.toThrow("archive put failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    const keys = await listArchiveKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.startsWith("raw/")).toBe(true);
    expect(await world.account.getInboundReceipt(await identityFor(raw, INBOX))).toBeNull();
  });

  it("fails the handler when AccountStore registration fails after a durable archive", async () => {
    const world = createWorld("receipts-register-fail", { accountFailure: { kind: "register" } });
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>register</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(processInbound(email, world.ports)).rejects.toThrow("register failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    const receiptId = await identityFor(raw, INBOX);
    expect(await listArchiveKeys()).toEqual(
      [rawObjectKey(await sha256Hex(raw)), receiptManifestKey(receiptId)].sort(),
    );
    expect(await world.stub.getInboundReceipt(receiptId)).toBeNull();
  });

  it("fails the handler when publication fails after a durable receipt", async () => {
    const world = createWorld("receipts-publish-fail", { publishFailure: true });
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>publish</p>");
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

    await expect(processInbound(email, world.ports)).rejects.toThrow("index send failed");
    expect(email.rejectReason).toBeNull();
    expect(world.published).toEqual([]);
    const receiptId = await identityFor(raw, INBOX);
    const receipt = await world.account.getInboundReceipt(receiptId);
    expect(receipt?.forward).toEqual({ kind: "success", destination: FORWARD_DEST });
    expect(email.forwards).toEqual([FORWARD_DEST]);
  });

  it("keeps distinct receipts for distinct recipients of the same raw bytes", async () => {
    const world = createWorld("receipts-distinct");
    await seedMailbox(world.stub, INBOX);
    await seedMailbox(world.stub, OTHER_INBOX);
    const raw = plainHtmlEml(INBOX, "<p>shared</p>");

    await processInbound(new FakeEmail({ to: INBOX, from: SENDER, raw }), world.ports);
    await processInbound(new FakeEmail({ to: OTHER_INBOX, from: SENDER, raw }), world.ports);

    expect(world.published).toHaveLength(2);
    expect(world.published[0]?.receiptId).not.toBe(world.published[1]?.receiptId);
    const first = await world.account.getInboundReceipt(world.published[0]?.receiptId ?? "");
    const second = await world.account.getInboundReceipt(world.published[1]?.receiptId ?? "");
    expect(first?.envelopeTo).toBe(INBOX);
    expect(second?.envelopeTo).toBe(OTHER_INBOX);
    expect(first?.digest).toBe(second?.digest);
    expect(first?.rawKey).toBe(second?.rawKey);
    const keys = await listArchiveKeys();
    expect(keys.filter((key) => key.startsWith("raw/"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith("receipts/"))).toHaveLength(2);
  });

  it("does not forward to inactive mailboxes or unverified destinations", async () => {
    const inactive = createWorld("receipts-inactive");
    await seedMailbox(inactive.stub, INBOX, { destination: FORWARD_DEST, active: false });
    const inactiveEmail = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw: plainHtmlEml(INBOX, "<p>inactive</p>"),
    });
    const inactiveResult = await processInbound(inactiveEmail, inactive.ports);
    expect(inactiveResult).toEqual({ kind: "rejected", reason: "unknown recipient" });
    expect(inactiveEmail.forwards).toEqual([]);
    expect(await listArchiveKeys()).toEqual([]);

    const unverified = createWorld("receipts-unverified");
    await seedMailbox(unverified.stub, INBOX, { destination: FORWARD_DEST, verified: false });
    const unverifiedEmail = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw: plainHtmlEml(INBOX, "<p>unverified</p>"),
    });
    const accepted = await processInbound(unverifiedEmail, unverified.ports);
    expect(accepted.kind).toBe("accepted");
    expect(unverifiedEmail.forwards).toEqual([]);
    const receipt = await unverified.account.getInboundReceipt(
      unverified.published[0]?.receiptId ?? "",
    );
    expect(receipt?.forward).toEqual({ kind: "none" });
  });

  it("does not native-forward again on duplicate envelope replay", async () => {
    const world = createWorld("receipts-replay");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>replay</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    const firstAccepted = await processInbound(first, world.ports);
    const secondWorld = createWorld("receipts-replay", { nowIso: LATER_NOW_ISO });
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    const secondAccepted = await processInbound(second, secondWorld.ports);

    expect(first.forwards).toEqual([FORWARD_DEST]);
    expect(second.forwards).toEqual([]);
    expect(firstAccepted).toEqual(secondAccepted);
    const receiptId = world.published[0]?.receiptId;
    expect(receiptId).toBe(secondWorld.published[0]?.receiptId);
    const receipt = await world.account.getInboundReceipt(receiptId ?? "");
    expect(receipt?.receivedAt).toBe(TEST_NOW_ISO);
    expect(receipt?.forward).toEqual({ kind: "success", destination: FORWARD_DEST });
  });

  it("records unknown forwarding after interruption and does not overwrite it on replay", async () => {
    const interrupted = createWorld("receipts-unknown", {
      accountFailure: { kind: "observe", observation: "success" },
    });
    await seedMailbox(interrupted.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>unknown</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await expect(processInbound(first, interrupted.ports)).rejects.toThrow("observe failed");
    expect(first.forwards).toEqual([FORWARD_DEST]);
    const receiptId = await identityFor(raw, INBOX);
    expect(await interrupted.account.getInboundReceipt(receiptId)).toMatchObject({
      receivedAt: TEST_NOW_ISO,
      forward: { kind: "unknown", destination: FORWARD_DEST },
    });

    const replay = createWorld("receipts-unknown", { nowIso: LATER_NOW_ISO });
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    second.failNextForward();
    const accepted = await processInbound(second, replay.ports);
    expect(accepted.kind).toBe("accepted");
    expect(second.forwards).toEqual([]);
    expect(await replay.account.getInboundReceipt(receiptId)).toMatchObject({
      receivedAt: TEST_NOW_ISO,
      forward: { kind: "unknown", destination: FORWARD_DEST },
    });
  });

  it("does not overwrite a terminal forwarding observation on a duplicate envelope", async () => {
    const world = createWorld("receipts-terminal");
    await seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
    const raw = plainHtmlEml(INBOX, "<p>terminal</p>");
    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await processInbound(first, world.ports);
    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    second.failNextForward();
    await processInbound(second, createWorld("receipts-terminal").ports);
    const receipt = await world.account.getInboundReceipt(world.published[0]?.receiptId ?? "");
    expect(first.forwards).toEqual([FORWARD_DEST]);
    expect(second.forwards).toEqual([]);
    expect(receipt?.forward).toEqual({ kind: "success", destination: FORWARD_DEST });
  });

  it("rejects advertised oversize without archiving or enqueueing", async () => {
    const world = createWorld("receipts-advertised-oversize");
    await seedMailbox(world.stub, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>Hi</p>");
    const email = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw,
      rawSize: DEFAULT_MAX_RAW_BYTES + 1,
    });
    const result = await processInbound(email, world.ports);
    expect(result).toEqual({ kind: "rejected", reason: "message too large" });
    expect(await listArchiveKeys()).toEqual([]);
    expect(world.published).toEqual([]);
  });
});

type ArchivePutFailure =
  | { readonly kind: "none" }
  | { readonly kind: "prefix"; readonly prefix: string };

type AccountFailure =
  | { readonly kind: "none" }
  | { readonly kind: "register" }
  | { readonly kind: "observe"; readonly observation: "unknown" | "success" | "failure" };

type WorldOptions = {
  readonly archiveFailure?: ArchivePutFailure;
  readonly accountFailure?: AccountFailure;
  readonly publishFailure?: boolean;
  readonly nowIso?: string;
};

function createWorld(accountName: string, options: WorldOptions = {}) {
  const published: IndexReceiptWork[] = [];
  const stub = testEnv.ACCOUNT_STORE.getByName(accountName);
  const archiveFailure = options.archiveFailure ?? { kind: "none" };
  const accountFailure = options.accountFailure ?? { kind: "none" };
  const publishFailure = options.publishFailure === true;
  const nowIso = options.nowIso ?? TEST_NOW_ISO;
  const account = wrappingAccount(stub, accountFailure);
  const ports: InboundPorts = {
    ARCHIVE: wrappingArchive(archiveFailure),
    INDEX: wrappingIndex(published, publishFailure),
    ACCOUNT: account,
    nowIso: () => nowIso,
  };
  return { ports, published, account, stub };
}

function wrappingArchive(failure: ArchivePutFailure): InboundArchive {
  return {
    async get(key) {
      const object = await testEnv.ARCHIVE.get(key);
      if (object === null) return null;
      return new Uint8Array(await object.arrayBuffer());
    },
    async put(key, bytes) {
      if (failure.kind === "prefix" && key.startsWith(failure.prefix)) {
        throw new Error("archive put failed");
      }
      await testEnv.ARCHIVE.put(key, bytes);
    },
  };
}

function wrappingAccount(
  stub: DurableObjectStub<AccountStoreTestHost>,
  failure: AccountFailure,
): InboundAccount {
  return {
    async registerInboundReceipt(input: RegisterInboundReceiptInput) {
      if (failure.kind === "register") {
        throw new Error("register failed");
      }
      return stub.registerInboundReceipt(input);
    },
    async observeInboundForward(input: ObserveInboundForwardInput) {
      if (failure.kind === "observe" && input.observation.kind === failure.observation) {
        throw new Error("observe failed");
      }
      return stub.observeInboundForward(input);
    },
    async getInboundReceipt(receiptId: string) {
      return stub.getInboundReceipt(receiptId);
    },
    async getAddressByMailbox(address: string) {
      return stub.getAddressByMailbox(address);
    },
    async getDestination(id: string) {
      return stub.getDestination(id);
    },
  };
}

function wrappingIndex(published: IndexReceiptWork[], fail: boolean): InboundIndex {
  return {
    async send(payload) {
      if (fail) {
        throw new Error("index send failed");
      }
      published.push(payload);
      await testEnv.INDEX.send(payload);
    },
  };
}

async function seedMailbox(
  stub: DurableObjectStub<AccountStoreTestHost>,
  address: string,
  options: {
    readonly destination?: string | null;
    readonly verified?: boolean;
    readonly active?: boolean;
  } = {},
): Promise<void> {
  const normalized = parseMailboxAddress(address);
  if (normalized.kind === "invalid") {
    throw new Error("test fixture address is invalid");
  }
  const created = await stub.createAddress(
    normalized.localPart,
    normalized.domain,
    "Inbox",
    TEST_NOW_ISO,
  );
  if (created === null) {
    throw new Error("expected seeded mailbox");
  }
  if (options.destination !== undefined && options.destination !== null) {
    const destination = await stub.insertDestination(
      `${created.id}-cf`,
      options.destination,
      options.verified === false ? null : TEST_NOW_ISO,
      TEST_NOW_ISO,
    );
    if (options.verified !== false) {
      const attached = await stub.setAddressForwarding(created.id, destination.id, TEST_NOW_ISO);
      if (attached === null) {
        throw new Error("expected forwarding destination to attach");
      }
    }
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
  const digest = await sha256Hex(raw);
  return inboundMessageId(digest, { from: SENDER, to: parseOk(to) });
}

function expectDigest(disposition: InboundDisposition): string {
  if (disposition.kind === "rejected") {
    throw new Error("expected accepted inbound");
  }
  return disposition.digest;
}

function parseOk(address: string) {
  const parsed = parseMailboxAddress(address);
  if (parsed.kind === "invalid") {
    throw new Error("expected valid mailbox address");
  }
  return parsed.address;
}

type ArchiveObjectBytes = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

function requireObject(object: ArchiveObjectBytes | null): ArchiveObjectBytes {
  if (object === null) {
    throw new Error("expected R2 object");
  }
  return object;
}

function encodeEml(value: string): Uint8Array {
  return new TextEncoder().encode(value.replaceAll("\n", "\r\n"));
}

function plainHtmlEml(to: string, html: string): Uint8Array {
  return encodeEml(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Subject: Hello",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\n"),
  );
}
