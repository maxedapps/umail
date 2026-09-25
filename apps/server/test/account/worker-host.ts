import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ApprovalTokenHash, MailDomain } from "@umail/api-contract";

import {
  acceptInbound,
  applyAccountSchema,
  failInboundReceiptPolicy,
  getInboundReceipt,
  observeInboundForward,
  redriveDueInboundReceipts,
  registerInboundReceipt,
  writeThreadedMail,
} from "../../src/account/commands.ts";
import { runDueWork, type DueWorkPorts } from "../../src/account/due-work.ts";
import { accountMigrations, type AccountMigration } from "../../src/account/migrations.ts";
import {
  claimJob,
  completeAttempt,
  decideApproval,
  expireDueApprovals,
  getOutboundJob,
  listOutboundJobs,
  lookupApprovalByTokenHash,
  readDispatch,
  settleAbandonedClaims,
  submitOutbound,
} from "../../src/account/jobs.ts";
import {
  createAddress,
  getAddress,
  getAddressByMailbox,
  listAddresses,
  listSendingIdentities,
  patchAddress,
  resolveSendingIdentity,
  setAddressForwarding,
} from "../../src/account/administration.ts";
import {
  getMessageBody,
  getMessageSource,
  getStoredAttachment,
  listMessageSummaries,
  listThreadMessageSummaries,
  listThreadSummaries,
  markThreadRead,
  softDeleteThread,
  threadMessagesSql,
} from "../../src/account/queries.ts";
import {
  SchemaMigrationRow,
  type AcceptInboundInput,
  type AcceptOutboundInput,
  type ClaimJobInput,
  type CompleteAttemptInput,
  type DecideApprovalInput,
  type FailInboundReceiptPolicyInput,
  type JobViewer,
  type ListMessageSummariesQuery,
  type ListOutboundJobsQuery,
  type ListThreadMessageSummariesQuery,
  type ListThreadSummariesQuery,
  type MailboxScope,
  type ObserveInboundForwardInput,
  type PatchAddressInput,
  type RegisterInboundReceiptInput,
  type SubmitOutboundInput,
} from "../../src/account/domain.ts";

import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Layer from "effect/Layer";

import { WebCrypto } from "../../src/crypto.ts";

const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";

const NameRow = Schema.Struct({
  name: Schema.String,
});

const QueryPlanRow = Schema.Struct({
  detail: Schema.String,
});

const FAILING_MIGRATION = {
  version: 11,
  name: "0011_fail",
  sql: `CREATE TABLE fail_marker (
  id TEXT PRIMARY KEY NOT NULL
);
INSERT INTO fail_marker (id) VALUES ('x');
INSERT INTO fail_marker (id) VALUES ('x');
`,
} as const satisfies AccountMigration;

export class AccountStoreTestHost extends DurableObject {
  #activationError: unknown;
  #ready = false;
  #lastId = 0;

  // Deterministic ids stand in for the ids production draws from Crypto.
  #nextId(prefix: string): string {
    this.#lastId += 1;
    return `${prefix}-${String(this.#lastId)}`;
  }

  acceptInbound(input: AcceptInboundInput) {
    this.#ensureReady();
    return acceptInbound(this.ctx.storage, input);
  }

  acceptInboundWithReceipt(input: AcceptInboundInput) {
    this.#ensureReady();
    registerInboundReceipt(this.ctx.storage, {
      receiptId: input.messageId,
      envelopeFrom: "sender@example.com",
      envelopeTo: "inbox@umail.example.com",
      rawKey: `raw/${input.messageId}`,
      receivedAt: input.occurredAt,
    });
    const accepted = acceptInbound(this.ctx.storage, input);
    if (accepted === null) {
      throw new Error(`Receipt ${input.messageId} was already settled`);
    }
    return accepted;
  }

  // Stores an outbound message as already sent, as a thread fixture.
  acceptOutbound(input: AcceptOutboundInput) {
    this.#ensureReady();
    return this.ctx.storage.transactionSync(() => {
      const result = writeThreadedMail(this.ctx.storage, { direction: "outbound", input });
      this.ctx.storage.sql.exec(
        `INSERT INTO outbound_jobs (
           id, requester_kind, requester_client_id, requester_label, idempotency_key,
           intent_fingerprint, message_id, mailbox_id, purpose, state, created_at, updated_at
         ) VALUES (?, 'operator', 'cli', 'AgentMail CLI', ?, '', ?, ?, 'message', 'accepted', ?, ?)`,
        this.#nextId("job"),
        input.messageId,
        input.messageId,
        input.mailboxId,
        input.nowIso,
        input.nowIso,
      );
      return result;
    });
  }

  registerInboundReceipt(input: RegisterInboundReceiptInput) {
    this.#ensureReady();
    return registerInboundReceipt(this.ctx.storage, input);
  }

  observeInboundForward(input: ObserveInboundForwardInput) {
    this.#ensureReady();
    return observeInboundForward(this.ctx.storage, input);
  }

  getInboundReceipt(receiptId: string) {
    this.#ensureReady();
    return getInboundReceipt(this.ctx.storage, receiptId);
  }

  removeInboundReceiptForIntegrityTest(receiptId: string) {
    this.#ensureReady();
    this.ctx.storage.sql.exec("DELETE FROM inbound_receipts WHERE id = ?", receiptId);
  }

  removeOutboundJobForIntegrityTest(messageId: string) {
    this.#ensureReady();
    this.ctx.storage.sql.exec("DELETE FROM outbound_jobs WHERE message_id = ?", messageId);
  }

  failInboundReceiptPolicy(input: FailInboundReceiptPolicyInput) {
    this.#ensureReady();
    return failInboundReceiptPolicy(this.ctx.storage, input);
  }

  redriveDueInboundReceipts(input: { readonly nowIso: string; readonly limit: number }) {
    this.#ensureReady();
    return redriveDueInboundReceipts(this.ctx.storage, input);
  }

  listMessageSummaries(input: ListMessageSummariesQuery) {
    this.#ensureReady();
    return listMessageSummaries(this.ctx.storage, input);
  }

  listThreadSummaries(input: ListThreadSummariesQuery) {
    this.#ensureReady();
    return listThreadSummaries(this.ctx.storage, input);
  }

  listThreadMessageSummaries(handle: string, input: ListThreadMessageSummariesQuery) {
    this.#ensureReady();
    return listThreadMessageSummaries(this.ctx.storage, handle, input);
  }

  getMessageBody(messageId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getMessageBody(this.ctx.storage, messageId, mailboxScope);
  }

  getStoredAttachment(messageId: string, attachmentId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getStoredAttachment(this.ctx.storage, messageId, attachmentId, mailboxScope);
  }

  getMessageSource(messageId: string, mailboxScope: MailboxScope) {
    this.#ensureReady();
    return getMessageSource(this.ctx.storage, messageId, mailboxScope);
  }

  markThreadRead(handle: string, isRead: boolean, mailboxScope: MailboxScope, nowIso: string) {
    this.#ensureReady();
    markThreadRead(this.ctx.storage, handle, isRead, mailboxScope, nowIso);
  }

  softDeleteThread(handle: string, mailboxScope: MailboxScope, deletedAt: string) {
    this.#ensureReady();
    softDeleteThread(this.ctx.storage, handle, mailboxScope, deletedAt);
  }

  listAddresses() {
    this.#ensureReady();
    return listAddresses(this.ctx.storage);
  }

  getAddress(id: string) {
    this.#ensureReady();
    return getAddress(this.ctx.storage, id);
  }

  getAddressByMailbox(address: string) {
    this.#ensureReady();
    return getAddressByMailbox(this.ctx.storage, address);
  }

  createAddress(
    localPart: string,
    mailDomain: MailDomain,
    displayName: string | undefined,
    nowIso: string,
  ) {
    this.#ensureReady();
    return createAddress(
      this.ctx.storage,
      this.#nextId("address"),
      localPart,
      mailDomain,
      displayName,
      nowIso,
    );
  }

  patchAddress(id: string, payload: PatchAddressInput, nowIso: string) {
    this.#ensureReady();
    return patchAddress(this.ctx.storage, id, payload, nowIso);
  }

  listSendingIdentities(mailboxScope: MailboxScope = "all") {
    this.#ensureReady();
    return listSendingIdentities(this.ctx.storage, mailboxScope);
  }

  resolveSendingIdentity(id: string) {
    this.#ensureReady();
    return resolveSendingIdentity(this.ctx.storage, id);
  }

  setAddressForwarding(addressId: string, forwardTo: string | null, nowIso: string) {
    this.#ensureReady();
    return setAddressForwarding(this.ctx.storage, addressId, forwardTo, nowIso);
  }

  submitOutbound(input: SubmitOutboundInput) {
    this.#ensureReady();
    return submitOutbound(this.ctx.storage, input, {
      messageId: this.#nextId("message"),
      jobId: this.#nextId("job"),
      notificationJobId: this.#nextId("job"),
    });
  }

  lookupApprovalByTokenHash(tokenHash: ApprovalTokenHash) {
    this.#ensureReady();
    return lookupApprovalByTokenHash(this.ctx.storage, tokenHash);
  }

  decideApproval(input: DecideApprovalInput) {
    this.#ensureReady();
    return decideApproval(this.ctx.storage, input);
  }

  claimJob(input: Omit<ClaimJobInput, "attemptId">) {
    this.#ensureReady();
    return claimJob(this.ctx.storage, { ...input, attemptId: this.#nextId("attempt") });
  }

  completeAttempt(input: CompleteAttemptInput) {
    this.#ensureReady();
    return completeAttempt(this.ctx.storage, input);
  }

  readDispatch(jobId: string) {
    this.#ensureReady();
    return readDispatch(this.ctx.storage, jobId);
  }

  expireDueApprovals(nowIso: string) {
    this.#ensureReady();
    expireDueApprovals(this.ctx.storage, nowIso);
  }

  settleAbandonedClaims(nowIso: string) {
    this.#ensureReady();
    settleAbandonedClaims(this.ctx.storage, nowIso);
  }

  // Specs install fake ports with `runInDurableObject` before running the alarm.
  dueWorkPorts: DueWorkPorts<never> | undefined;

  override async alarm() {
    this.#ensureReady();
    if (this.dueWorkPorts === undefined) throw new Error("dueWorkPorts not installed");
    await Effect.runPromise(
      runDueWork(this.ctx.storage, this.dueWorkPorts, Date.now()).pipe(
        Effect.provide(Layer.merge(WebCrypto, RuntimeContext.phantom)),
      ),
    );
  }

  getOutboundJob(jobId: string, viewer: JobViewer) {
    this.#ensureReady();
    return getOutboundJob(this.ctx.storage, jobId, viewer);
  }

  listOutboundJobs(input: ListOutboundJobsQuery) {
    this.#ensureReady();
    return listOutboundJobs(this.ctx.storage, input);
  }

  listTables() {
    this.#ensureReady();
    return this.#tables();
  }

  listMigrations() {
    this.#ensureReady();
    return this.#migrations();
  }

  explainThreadOpen() {
    this.#ensureReady();
    return Schema.decodeUnknownSync(Schema.Array(QueryPlanRow))(
      this.ctx.storage.sql
        .exec(`EXPLAIN QUERY PLAN ${threadMessagesSql(false, "all")}`, "thread-id", 50)
        .toArray(),
    ).map((row) => row.detail);
  }

  listMessageColumns() {
    this.#ensureReady();
    return Schema.decodeUnknownSync(Schema.Array(NameRow))(
      this.ctx.storage.sql.exec("PRAGMA table_info(messages)").toArray(),
    ).map((row) => row.name);
  }

  applyFailingMigration() {
    this.#ensureReady();
    applyAccountSchema(this.ctx.storage, TEST_NOW_ISO, [...accountMigrations, FAILING_MIGRATION]);
  }

  installUnsupportedSchema(version: number) {
    this.#ensureReady();
    this.ctx.storage.sql.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      version,
      "future_schema",
      TEST_NOW_ISO,
    );
  }

  installOldSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY NOT NULL)");
    this.ctx.storage.sql.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      9,
      "0009_account",
      TEST_NOW_ISO,
    );
  }

  inspectUninitializedSchema() {
    return { tables: this.#tables(), migrations: this.#migrations() };
  }

  #tables() {
    return Schema.decodeUnknownSync(Schema.Array(NameRow))(
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .toArray(),
    ).map((row) => row.name);
  }

  #migrations() {
    return Schema.decodeUnknownSync(Schema.Array(SchemaMigrationRow))(
      this.ctx.storage.sql
        .exec("SELECT version, name FROM schema_migrations ORDER BY version")
        .toArray(),
    );
  }

  #ensureReady(): void {
    if (this.#activationError !== undefined) {
      throw this.#activationError;
    }
    if (this.#ready) return;
    try {
      applyAccountSchema(this.ctx.storage, TEST_NOW_ISO);
      this.#ready = true;
    } catch (cause) {
      this.#activationError = cause;
      throw cause;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("account-store-test-host", { status: 200 });
  },
};
