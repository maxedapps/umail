/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  ApprovalTokenHash,
  parseExternalMailAddress,
  parseMailboxAddress,
  SubmissionRequestId,
} from "@umail/api-contract";
import { env, reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vitest";

import type { IndexReceiptWork } from "../../src/mail/indexing.ts";
import { runMailRecovery } from "../../src/mail/recovery.ts";
import type { SendJobWork } from "../../src/mail/send.ts";
import type { AccountStoreTestHost } from "../account/worker-host.ts";

type TestEnv = {
  readonly ACCOUNT_STORE: DurableObjectNamespace<AccountStoreTestHost>;
};

const testEnv = env as TestEnv;

const RECEIVED_AT = "2026-01-01T00:00:00.000Z";
// Receipts become due five minutes after they arrive.
const DUE_AT = "2026-01-01T00:05:00.000Z";

describe("mail recovery cron handler", () => {
  beforeEach(async () => {
    await reset();
  });

  it("publishes due receipts to INDEX and ready send jobs to SEND", async () => {
    const stub = testEnv.ACCOUNT_STORE.getByName("recovery-wiring");
    await stub.registerInboundReceipt({
      receiptId: "in_ready",
      envelopeFrom: "sender@example.com",
      envelopeTo: "inbox@umail.example.com",
      rawKey: "raw/in_ready.eml",
      receivedAt: RECEIVED_AT,
    });
    const mailbox = parseMailboxAddress("inbox@umail.example.com");
    const recipient = parseExternalMailAddress("recipient@example.com");
    if (mailbox.kind === "invalid" || recipient.kind !== "ok")
      throw new Error("expected addresses");
    const created = await stub.createAddress(
      mailbox.localPart,
      mailbox.domain,
      undefined,
      RECEIVED_AT,
    );
    if (created === null) throw new Error("expected address");
    const submitted = await stub.submitOutbound({
      requestId: Schema.decodeSync(SubmissionRequestId)("11111111-1111-4111-8111-111111111111"),
      requester: { kind: "operator", clientId: "cli", label: "AgentMail CLI" },
      mailboxId: created.id,
      subject: "Hello",
      textBody: "body",
      htmlBody: null,
      hasRemoteImages: false,
      to: [{ address: recipient.address, displayName: null }],
      cc: [],
      inReplyToHeader: null,
      referencesHeader: null,
      nowIso: RECEIVED_AT,
      approval: {
        approvalId: "approval-unused",
        tokenHash: Schema.decodeSync(ApprovalTokenHash)("0".repeat(64)),
        expiresAt: DUE_AT,
      },
    });

    const indexed: IndexReceiptWork[] = [];
    const sent: SendJobWork[] = [];
    await Effect.runPromise(
      runMailRecovery(
        {
          account: {
            redriveDueInboundReceipts: (input) =>
              Effect.promise(() => stub.redriveDueInboundReceipts(input)),
            recoverOutbound: (input) => Effect.promise(() => stub.recoverOutbound(input)),
          },
          index: { send: (body) => Effect.sync(() => void indexed.push(body)) },
          send: { send: (body) => Effect.sync(() => void sent.push(body)) },
        },
        DUE_AT,
      ),
    );

    expect(indexed).toEqual([{ version: 1, receiptId: "in_ready" }]);
    expect(sent).toEqual([{ version: 1, jobId: submitted.job.jobId }]);
  });
});
