import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MailArchiveReader } from "../apps/server/src/api/app.ts";
import { connectedMcp } from "../apps/server/test/api/mcp-drivers.ts";
import { issueMcpAccessToken, registerMcpClient } from "../apps/server/test/api/oauth-flow.ts";
import {
  authorized,
  createMailHtmlPolicy,
  createWorld,
  seedMailbox,
  type World,
} from "../apps/server/test/api/world.ts";
import type {
  EmailSender,
  OutboundMail,
  ProviderSendOutcome,
} from "../apps/server/src/mail/email-sender.ts";
import { processInbound, type InboundAccount } from "../apps/server/src/mail/inbound.ts";
import { indexAccountFromAsync } from "../apps/server/test/mail/fakes.ts";
import { consumeIndexReceipt } from "../apps/server/src/mail/process-index.ts";
import {
  consumeSendJob,
  createSendOutcomeBuffer,
  type SendConsumerAccount,
  type SendConsumerPorts,
  type SendOutcomeBuffer,
} from "../apps/server/src/mail/send.ts";
import { FakeEmail, MemoryArchive, MemoryIndex } from "../apps/server/test/mail/fakes.ts";
import { receiptClaimUntilIso, sendClaimUntilIso } from "../apps/server/src/mail/policy.ts";
import {
  MailMessagePage,
  OutboundJobStatus,
  SubmissionRequestId,
} from "../packages/api-contract/src/index.ts";

const NOW_ISO = "2026-08-28T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_1X1_BYTES = Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64"));
const INBOUND_SUBJECT = "Quarterly review";
const AGENT_LABEL = "Local E2E agent";
const SubmitMessageToolOutput = Schema.Struct({ job: OutboundJobStatus });

export type LocalTarget = {
  readonly world: World;
  readonly archive: MemoryArchive;
  readonly sender: FakeEmailSender;
  readonly index: MemoryIndex;
  readonly indexedWork: Array<{ readonly receiptId: string }>;
  readonly outcomes: SendOutcomeBuffer;
  readonly mailboxId: string;
  readonly mailboxAddress: string;
  readonly mcpClientId: string;
  readonly mcpAccessToken: string;
  readonly nowIso: string;
  dispose(): void;
};

export function localAgentLabel(): string {
  return AGENT_LABEL;
}

export async function createLocalTarget(): Promise<LocalTarget> {
  const archive = new MemoryArchive();
  const htmlPolicy = createMailHtmlPolicy();
  const world = await createWorld({
    archive: mailArchiveReaderFrom(archive),
    htmlPolicy,
  });
  const mailbox = await seedMailbox(world);
  const registered = await registerMcpClient(world, { label: "Local E2E MCP" });
  const token = await issueMcpAccessToken(world, registered);
  const mcp = await connectedMcp(world, token.access_token);
  try {
    await mcp.listTools();
  } finally {
    await mcp.close();
  }
  return {
    world,
    archive,
    sender: new FakeEmailSender(),
    index: new MemoryIndex(),
    indexedWork: [],
    outcomes: createSendOutcomeBuffer(),
    mailboxId: mailbox.id,
    mailboxAddress: mailbox.address,
    mcpClientId: registered.clientId,
    mcpAccessToken: token.access_token,
    nowIso: NOW_ISO,
    dispose() {
      world.accountStorage.close();
    },
  };
}

export async function deliverInbound(target: LocalTarget): Promise<{
  readonly messageId: string;
  readonly attachmentId: string;
}> {
  const email = new FakeEmail({
    to: target.mailboxAddress,
    from: "sender@example.com",
    raw: relatedImageEml(target.mailboxAddress),
  });
  const accepted = await processInbound(email, {
    ARCHIVE: target.archive,
    INDEX: target.index,
    ACCOUNT: inboundAccount(target),
    nowIso: () => target.nowIso,
  });
  if (accepted.kind !== "accepted") {
    throw new Error(`inbound was rejected: ${accepted.reason}`);
  }
  await drainIndex(target);
  return requireInboundAttachment(target);
}

export async function redriveIndexedReceipts(target: LocalTarget): Promise<void> {
  await runIndexHandler(target, target.indexedWork);
}

export async function submitApprovedReply(target: LocalTarget, inboundMessageId: string) {
  const client = await connectedMcp(target.world, target.mcpAccessToken);
  try {
    const result = await client.callTool({
      name: "umail_submit_message",
      arguments: {
        intent: "reply",
        requestId: Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID()),
        fromAddressId: target.mailboxId,
        replyToMessageId: inboundMessageId,
        replyMode: "reply",
        subject: `Re: ${INBOUND_SUBJECT}`,
        text: "Thanks, the logo arrived.",
      },
    });
    if (result.isError === true) {
      throw new Error("MCP reply submission failed");
    }
    const output = Schema.decodeUnknownSync(SubmitMessageToolOutput)(result.structuredContent);
    const token = target.world.approvalTokens.at(-1);
    if (token === undefined) {
      throw new Error("expected an approval token after the reply");
    }
    return { job: output.job, token };
  } finally {
    await client.close();
  }
}

export async function dispatchReadySends(target: LocalTarget, replay: boolean): Promise<number> {
  const page = await Effect.runPromise(
    target.world.account.listSendWork({
      kind: "ready",
      nowIso: target.nowIso,
    }),
  );
  const work = page.items.map((job) => ({ version: 1 as const, jobId: job.jobId }));
  await runSendHandler(target, work);
  if (replay) {
    await runSendHandler(target, work);
  }
  return target.sender.calls;
}

export async function readJob(target: LocalTarget, jobId: string) {
  const response = await target.world.fetch(
    `http://umail.test/jobs/${jobId}`,
    authorized(target.world),
  );
  if (!response.ok) {
    throw new Error(`job status read failed: ${response.status} ${await response.text()}`);
  }
  return Schema.decodeUnknownSync(OutboundJobStatus)(await response.json());
}

export async function readAttachment(target: LocalTarget, messageId: string, attachmentId: string) {
  const response = await target.world.fetch(
    `http://umail.test/messages/${messageId}/attachments/${attachmentId}`,
    authorized(target.world),
  );
  if (!response.ok) {
    throw new Error(`attachment read failed: ${response.status} ${await response.text()}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    contentType: response.headers.get("content-type") ?? "",
    byteLength: bytes.byteLength,
    matchesPng: bytesEqual(bytes, PNG_1X1_BYTES),
  };
}

export async function countInboundMessages(target: LocalTarget): Promise<number> {
  const response = await target.world.fetch(
    "http://umail.test/messages?direction=inbound",
    authorized(target.world),
  );
  if (!response.ok) {
    throw new Error(`inbound list failed: ${response.status} ${await response.text()}`);
  }
  return Schema.decodeUnknownSync(MailMessagePage)(await response.json()).items.length;
}

export async function postPolicyFromOrigin(
  target: LocalTarget,
  origin: string,
  label: string,
): Promise<number> {
  const headers = new Headers({
    cookie: target.world.sessionCookie,
    origin,
    "content-type": "application/x-www-form-urlencoded",
  });
  const response = await target.world.fetch(
    `http://umail.test/clients/${encodeURIComponent(target.mcpClientId)}/policy`,
    {
      method: "POST",
      redirect: "manual",
      headers,
      body: new URLSearchParams({
        label,
        mailboxIds: "all",
        canRead: "on",
        sendMode: "allow",
        recipientAllowlist: "any",
        active: "on",
      }).toString(),
    },
  );
  return response.status;
}

export async function policyLabel(target: LocalTarget): Promise<string> {
  const policy = await Effect.runPromise(
    target.world.account.getMcpOAuthPolicy(target.mcpClientId),
  );
  if (policy === null) {
    throw new Error("expected the local MCP policy to exist");
  }
  return policy.label;
}

export async function signupStatus(target: LocalTarget): Promise<number> {
  const response = await target.world.fetch("http://umail.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "intruder",
      email: "intruder@example.com",
      password: "intruder-passphrase",
    }),
  });
  return response.status;
}

class FakeEmailSender implements EmailSender {
  readonly mails: OutboundMail[] = [];
  calls = 0;
  next: ProviderSendOutcome = {
    kind: "accepted",
    providerMessageId: "prov-local-e2e",
    rfcMessageId: null,
  };

  send(mail: OutboundMail): Effect.Effect<ProviderSendOutcome> {
    return Effect.sync(() => {
      this.calls += 1;
      this.mails.push(mail);
      return this.next;
    });
  }
}

function mailArchiveReaderFrom(archive: MemoryArchive): MailArchiveReader {
  return {
    get: (key) => Effect.sync(() => archive.objects.get(key) ?? null),
  };
}

function inboundAccount(target: LocalTarget): InboundAccount {
  const account = target.world.account;
  return {
    registerInboundReceipt: (input) => Effect.runPromise(account.registerInboundReceipt(input)),
    observeInboundForward: (input) => Effect.runPromise(account.observeInboundForward(input)),
    getInboundReceipt: (receiptId) => Effect.runPromise(account.getInboundReceipt(receiptId)),
    getAddressByMailbox: (address) => Effect.runPromise(account.getAddressByMailbox(address)),
    getDestination: (id) => Effect.runPromise(account.getDestination(id)),
  };
}

function indexAccount(target: LocalTarget) {
  const account = target.world.account;
  return indexAccountFromAsync({
    getInboundReceipt: (receiptId) => Effect.runPromise(account.getInboundReceipt(receiptId)),
    getAddressByMailbox: (address) => Effect.runPromise(account.getAddressByMailbox(address)),
    claimInboundReceipt: (input) => Effect.runPromise(account.claimInboundReceipt(input)),
    acceptInbound: (input) => Effect.runPromise(account.acceptInbound(input)),
    completeInboundReceipt: (receiptId) =>
      Effect.runPromise(account.completeInboundReceipt(receiptId)),
    failInboundReceiptPolicy: (input) => Effect.runPromise(account.failInboundReceiptPolicy(input)),
  });
}

function sendPorts(target: LocalTarget): SendConsumerPorts {
  return {
    account: sendAccount(target),
    sender: target.sender,
    htmlPolicy: target.world.deps.htmlPolicy,
    applicationUrl: target.world.deps.applicationUrl,
    nowIso: target.nowIso,
    claimExpiresAt: sendClaimUntilIso(NOW_MS),
    outcomes: target.outcomes,
    notification: {
      keyring: target.world.deps.notification.keyring,
      applicationUrl: target.world.deps.applicationUrl,
      mailDomain: target.world.deps.mailDomain,
      approvalAdminEmail: target.world.deps.approvalAdminEmail,
    },
  };
}

function sendAccount(target: LocalTarget): SendConsumerAccount {
  return target.world.account;
}

async function drainIndex(target: LocalTarget): Promise<void> {
  const queued = target.index.payloads.splice(0);
  target.indexedWork.push(...queued);
  await runIndexHandler(target, queued);
}

async function runIndexHandler(
  target: LocalTarget,
  payloads: ReadonlyArray<{ readonly receiptId: string }>,
): Promise<void> {
  const account = indexAccount(target);
  for (const payload of payloads) {
    await Effect.runPromise(
      consumeIndexReceipt(
        payload.receiptId,
        target.archive.asStore(),
        target.world.deps.htmlPolicy,
        account,
        target.nowIso,
        receiptClaimUntilIso(NOW_MS),
      ),
    );
  }
}

async function runSendHandler(
  target: LocalTarget,
  payloads: ReadonlyArray<{ readonly version: 1; readonly jobId: string }>,
): Promise<void> {
  const ports = sendPorts(target);
  for (const payload of payloads) {
    await Effect.runPromise(consumeSendJob(payload.jobId, ports));
  }
}

async function requireInboundAttachment(target: LocalTarget) {
  const response = await target.world.fetch(
    "http://umail.test/messages?direction=inbound",
    authorized(target.world),
  );
  if (!response.ok) {
    throw new Error(`inbound list failed: ${response.status} ${await response.text()}`);
  }
  const page = Schema.decodeUnknownSync(MailMessagePage)(await response.json());
  const inbound = page.items[0];
  if (inbound === undefined || inbound.direction !== "inbound") {
    throw new Error("expected one indexed inbound message");
  }
  const attachment = inbound.attachments[0];
  if (attachment === undefined) {
    throw new Error("expected the inbound logo attachment");
  }
  return { messageId: inbound.id, attachmentId: attachment.id };
}

function relatedImageEml(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: sender@example.com",
      `To: ${to}`,
      `Subject: ${INBOUND_SUBJECT}`,
      "Message-ID: <inbound-e2e@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="bound1"',
      "",
      "--bound1",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><p>Please review</p><img src="cid:logo@umail" alt="logo"></body></html>',
      "--bound1",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: inline; filename="logo.png"',
      "Content-ID: <logo@umail>",
      "",
      PNG_1X1_BASE64,
      "--bound1--",
      "",
    ]
      .join("\n")
      .replaceAll("\n", "\r\n"),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
