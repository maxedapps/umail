/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseMailboxAddress } from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import { beforeEach, expect, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { inboundMessageId } from "../../src/mail/archive.ts";
import { receiveInbound, type InboundDeps } from "../../src/mail/inbound.ts";
import type { IndexReceiptWork } from "../../src/mail/process-index.ts";
import { sha256Hex, WebCrypto } from "../../src/crypto.ts";
import { DEFAULT_MAX_RAW_BYTES, rawObjectKey } from "../../src/mail/policy.ts";
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

layer(WebCrypto)("inbound receipts", (it) => {
  beforeEach(() => reset());

  it.effect(
    "archives the raw bytes by digest, registers a ready receipt, forwards and publishes",
    () =>
      Effect.gen(function* () {
        const world = createWorld("receipts-archive");
        yield* seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
        const raw = plainHtmlEml(INBOX, "<p>Hi</p>");
        const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

        yield* world.receive(email);

        const receiptId = yield* identityFor(raw, INBOX);
        expect(email.rejectReason).toBeNull();
        expect(email.forwards).toEqual([FORWARD_DEST]);
        expect(world.published).toEqual([{ version: 1, receiptId }]);
        const rawKey = rawObjectKey(yield* sha256Hex(raw));
        expect(yield* listArchiveKeys).toEqual([rawKey]);
        const stored = yield* effectBucket(testEnv.ARCHIVE).get(rawKey);
        expect(
          new Uint8Array(stored === null ? new ArrayBuffer(0) : yield* stored.arrayBuffer()),
        ).toEqual(raw);
        expect(yield* receiptOf(world.stub, receiptId)).toEqual({
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
      }),
  );

  it.effect(
    "rejects when the bytes read exceed the limit even if the advertised size is small",
    () =>
      Effect.gen(function* () {
        const world = createWorld("receipts-actual-size");
        yield* seedMailbox(world.stub, INBOX);
        const raw = new Uint8Array(DEFAULT_MAX_RAW_BYTES + 1);
        const email = new FakeEmail({ to: INBOX, from: SENDER, raw, rawSize: 16 });

        yield* world.receive(email);

        expect(email.rejectReason).toBe("message too large");
        expect(yield* listArchiveKeys).toEqual([]);
        expect(world.published).toEqual([]);
      }),
  );

  it.effect("rejects advertised oversize without archiving or publishing", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-advertised-oversize");
      yield* seedMailbox(world.stub, INBOX);
      const email = new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: plainHtmlEml(INBOX, "<p>Hi</p>"),
        rawSize: DEFAULT_MAX_RAW_BYTES + 1,
      });

      yield* world.receive(email);

      expect(email.rejectReason).toBe("message too large");
      expect(yield* listArchiveKeys).toEqual([]);
      expect(world.published).toEqual([]);
    }),
  );

  it.effect("fails the handler when the raw object write fails", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-raw-fail", { fail: "archive" });
      yield* seedMailbox(world.stub, INBOX);
      const raw = plainHtmlEml(INBOX, "<p>raw</p>");
      const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

      yield* expectDefect(world.receive(email), "archive put failed");
      expect(email.rejectReason).toBeNull();
      expect(world.published).toEqual([]);
      expect(yield* receiptOf(world.stub, yield* identityFor(raw, INBOX))).toBeNull();
    }),
  );

  it.effect("fails the handler when registration fails after a durable archive", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-register-fail", { fail: "register" });
      yield* seedMailbox(world.stub, INBOX);
      const raw = plainHtmlEml(INBOX, "<p>register</p>");
      const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

      yield* expectDefect(world.receive(email), "register failed");
      expect(email.rejectReason).toBeNull();
      expect(world.published).toEqual([]);
      expect(yield* listArchiveKeys).toEqual([rawObjectKey(yield* sha256Hex(raw))]);
      expect(yield* receiptOf(world.stub, yield* identityFor(raw, INBOX))).toBeNull();
    }),
  );

  it.effect("fails the handler when publication fails after a durable receipt", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-publish-fail", { fail: "publish" });
      yield* seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
      const raw = plainHtmlEml(INBOX, "<p>publish</p>");
      const email = new FakeEmail({ to: INBOX, from: SENDER, raw });

      yield* expectDefect(world.receive(email), "index send failed");
      expect(email.rejectReason).toBeNull();
      expect(world.published).toEqual([]);
      const receipt = yield* receiptOf(world.stub, yield* identityFor(raw, INBOX));
      expect(receipt?.workState).toBe("ready");
      expect(receipt).toMatchObject({
        forwardOutcome: "success",
        forwardDestination: FORWARD_DEST,
      });
    }),
  );

  it.effect("keeps distinct receipts for distinct recipients of the same raw bytes", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-distinct");
      yield* seedMailbox(world.stub, INBOX);
      yield* seedMailbox(world.stub, OTHER_INBOX);
      const raw = plainHtmlEml(INBOX, "<p>shared</p>");

      yield* world.receive(new FakeEmail({ to: INBOX, from: SENDER, raw }));
      yield* world.receive(new FakeEmail({ to: OTHER_INBOX, from: SENDER, raw }));

      const first = yield* receiptOf(world.stub, yield* identityFor(raw, INBOX));
      const second = yield* receiptOf(world.stub, yield* identityFor(raw, OTHER_INBOX));
      expect(world.published.map((work) => work.receiptId)).toEqual([
        first?.receiptId,
        second?.receiptId,
      ]);
      expect(first?.receiptId).not.toBe(second?.receiptId);
      expect(first?.envelopeTo).toBe(INBOX);
      expect(second?.envelopeTo).toBe(OTHER_INBOX);
      expect(first?.rawKey).toBe(second?.rawKey);
      expect(yield* listArchiveKeys).toEqual([first?.rawKey]);
    }),
  );

  it.effect("rejects mail for an inactive mailbox without forwarding it", () =>
    Effect.gen(function* () {
      const inactive = createWorld("receipts-inactive");
      yield* seedMailbox(inactive.stub, INBOX, { destination: FORWARD_DEST, active: false });
      const inactiveEmail = new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: plainHtmlEml(INBOX, "<p>inactive</p>"),
      });
      yield* inactive.receive(inactiveEmail);
      expect(inactiveEmail.rejectReason).toBe("unknown recipient");
      expect(inactiveEmail.forwards).toEqual([]);
      expect(yield* listArchiveKeys).toEqual([]);
    }),
  );

  // Cloudflare refuses a destination that has not been verified yet, among other reasons.
  it.effect("records a refused forward and still accepts the message", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-forward-fail");
      yield* seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
      const raw = plainHtmlEml(INBOX, "<p>forward</p>");
      const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
      email.failNextForward();

      yield* world.receive(email);

      const receiptId = yield* identityFor(raw, INBOX);
      expect(email.rejectReason).toBeNull();
      expect(world.published).toEqual([{ version: 1, receiptId }]);
      expect(yield* receiptOf(world.stub, receiptId)).toMatchObject({
        forwardOutcome: "failure",
        forwardDestination: FORWARD_DEST,
      });
    }),
  );

  it.effect("does not native-forward again on duplicate envelope replay", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-replay");
      yield* seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
      const raw = plainHtmlEml(INBOX, "<p>replay</p>");
      const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
      yield* world.receive(first);
      const replay = createWorld("receipts-replay", { nowIso: LATER_NOW_ISO });
      const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
      yield* replay.receive(second);

      const receiptId = yield* identityFor(raw, INBOX);
      expect(first.forwards).toEqual([FORWARD_DEST]);
      expect(second.forwards).toEqual([]);
      expect(world.published).toEqual([{ version: 1, receiptId }]);
      expect(replay.published).toEqual([{ version: 1, receiptId }]);
      const receipt = yield* receiptOf(world.stub, receiptId);
      expect(receipt?.receivedAt).toBe(TEST_NOW_ISO);
      expect(receipt).toMatchObject({
        forwardOutcome: "success",
        forwardDestination: FORWARD_DEST,
      });
    }),
  );

  it.effect(
    "records unknown forwarding after interruption and does not overwrite it on replay",
    () =>
      Effect.gen(function* () {
        const interrupted = createWorld("receipts-unknown", { fail: "observe-success" });
        yield* seedMailbox(interrupted.stub, INBOX, { destination: FORWARD_DEST });
        const raw = plainHtmlEml(INBOX, "<p>unknown</p>");
        const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
        yield* expectDefect(interrupted.receive(first), "observe failed");
        expect(first.forwards).toEqual([FORWARD_DEST]);
        const receiptId = yield* identityFor(raw, INBOX);
        expect(yield* receiptOf(interrupted.stub, receiptId)).toMatchObject({
          receivedAt: TEST_NOW_ISO,
          forwardOutcome: "unknown",
          forwardDestination: FORWARD_DEST,
        });

        const replay = createWorld("receipts-unknown", { nowIso: LATER_NOW_ISO });
        const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
        second.failNextForward();
        yield* replay.receive(second);
        expect(second.forwards).toEqual([]);
        expect(replay.published).toEqual([{ version: 1, receiptId }]);
        expect(yield* receiptOf(replay.stub, receiptId)).toMatchObject({
          receivedAt: TEST_NOW_ISO,
          forwardOutcome: "unknown",
          forwardDestination: FORWARD_DEST,
        });
      }),
  );

  it.effect("does not overwrite a settled forwarding observation on a duplicate envelope", () =>
    Effect.gen(function* () {
      const world = createWorld("receipts-settled");
      yield* seedMailbox(world.stub, INBOX, { destination: FORWARD_DEST });
      const raw = plainHtmlEml(INBOX, "<p>settled</p>");
      const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
      yield* world.receive(first);
      const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
      second.failNextForward();
      yield* world.receive(second);

      const receipt = yield* receiptOf(world.stub, yield* identityFor(raw, INBOX));
      expect(first.forwards).toEqual([FORWARD_DEST]);
      expect(second.forwards).toEqual([]);
      expect(receipt).toMatchObject({
        forwardOutcome: "success",
        forwardDestination: FORWARD_DEST,
      });
    }),
  );
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
          : Effect.promise(() => {
              published.push(body);
              return testEnv.INDEX.send(body);
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
    receive: (email: FakeEmail) => receiveInbound(email, deps),
  };
}

const seedMailbox = Effect.fn("seedMailbox")(function* (
  stub: DurableObjectStub<AccountStoreTestHost>,
  address: string,
  options: {
    readonly destination?: string;
    readonly active?: boolean;
  } = {},
) {
  const normalized = parseOk(address);
  const created = yield* Effect.promise(() =>
    stub.createAddress(normalized.localPart, normalized.domain, "Inbox", TEST_NOW_ISO),
  );
  if (created === null) {
    return yield* Effect.die(new Error("expected seeded mailbox"));
  }
  const destination = options.destination;
  if (destination !== undefined) {
    yield* Effect.promise(() => stub.setAddressForwarding(created.id, destination, TEST_NOW_ISO));
  }
  if (options.active === false) {
    const patched = yield* Effect.promise(() =>
      stub.patchAddress(created.id, { active: false }, TEST_NOW_ISO),
    );
    if (patched === null) {
      return yield* Effect.die(new Error("expected mailbox patch"));
    }
  }
});

function receiptOf(stub: DurableObjectStub<AccountStoreTestHost>, receiptId: string) {
  return Effect.promise(() => stub.getInboundReceipt(receiptId));
}

const listArchiveKeys = Effect.promise(() => testEnv.ARCHIVE.list()).pipe(
  Effect.map((listed) => listed.objects.map((object) => object.key).sort()),
);

const identityFor = Effect.fn("identityFor")(function* (raw: Uint8Array, to: string) {
  const digest = yield* sha256Hex(raw);
  return yield* inboundMessageId(digest, { from: SENDER, to: parseOk(to).address });
});

const expectDefect = Effect.fn("expectDefect")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string,
) {
  const exit = yield* Effect.exit(effect);
  expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "succeeded").toContain(message);
});

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
