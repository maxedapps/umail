import {
  approvalNotificationIdempotencyKey,
  comparisonKey,
  parseExternalMailAddress,
  type ApprovalTokenHash,
  type OutboundJobFailureClass,
  type OutboundJobPurpose,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

import { resolveSendingIdentity } from "./administration.ts";
import {
  emptyParticipants,
  loadParticipantsByMessageIds,
  loadReferencesByMessageIds,
  pageLimit,
  writeThreadedMail,
} from "./commands.ts";
import {
  ApprovalRequestRow,
  OutboundJobRow,
  type AccountMailContact,
  type ApprovalCapabilityWrite,
  type ApprovalDecisionResult,
  type ApprovalLookupResult,
  type ClaimJobInput,
  type ClaimJobResult,
  type CompleteAttemptInput,
  type CompleteAttemptResult,
  type DecideApprovalInput,
  type JobViewer,
  type ListOutboundJobsQuery,
  type NewSubmissionIds,
  type OutboundDispatch,
  type OutboundJob,
  type OutboundJobPage,
  type OutboundRequester,
  type StoredApproval,
  type SubmitOutboundInput,
  type SubmitOutboundResult,
} from "./domain.ts";
import {
  JobAuthorizationError,
  SubmissionConflictError,
  type JobAuthorizationReason,
} from "./errors.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";
import { linkThread } from "./threading.ts";

const JOB_SELECT = `j.id AS id,
       j.requester_kind AS requester_kind,
       j.requester_client_id AS requester_client_id,
       j.requester_label AS requester_label,
       j.idempotency_key AS idempotency_key,
       j.intent_fingerprint AS intent_fingerprint,
       j.message_id AS message_id,
       j.mailbox_id AS mailbox_id,
       j.purpose AS purpose,
       j.state AS state,
       j.attempt_id AS attempt_id,
       j.attempt_claimed_at AS attempt_claimed_at,
       j.claim_expires_at AS claim_expires_at,
       j.provider_message_id AS provider_message_id,
       j.rfc_message_id AS rfc_message_id,
       j.failure_class AS failure_class,
       j.failure_detail AS failure_detail,
       j.created_at AS created_at,
       j.updated_at AS updated_at,
       m.thread_id AS thread_id`;

export function submitOutbound(
  storage: AccountSqliteStorage,
  input: SubmitOutboundInput,
  ids: NewSubmissionIds,
): SubmitOutboundResult {
  const to = dedupeAccountMailContacts(input.to);
  const cc = dedupeAccountMailContacts(input.cc);
  return storage.transactionSync(() => {
    const identity = resolveSendingIdentity(storage, input.mailboxId);
    if (identity === null) {
      throw new JobAuthorizationError({ reason: "mailbox_forbidden" });
    }
    const fromAddress = parseExternalMailAddress(identity.address);
    if (fromAddress.kind === "invalid") {
      throw new JobAuthorizationError({ reason: "mailbox_forbidden" });
    }
    const recipients = [...to, ...cc];
    const authorization = authorizeOutbound(input.policy, identity.id, recipients);
    if (authorization.kind === "denied") {
      throw new JobAuthorizationError({ reason: authorization.reason });
    }
    const fingerprint = outboundIntentFingerprint({
      mailboxId: identity.id,
      fromAddress: fromAddress.address,
      to,
      cc,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      inReplyToHeader: input.inReplyToHeader,
      referencesHeader: input.referencesHeader,
    });
    const existing = readJob(
      storage,
      "j.requester_kind = ? AND j.requester_client_id = ? AND j.idempotency_key = ?",
      input.requester.kind,
      input.requester.clientId,
      input.requestId,
    );
    if (existing !== null) {
      if (existing.intent_fingerprint !== fingerprint) {
        throw new SubmissionConflictError({
          requestId: input.requestId,
          requesterClientId: input.requester.clientId,
        });
      }
      return {
        job: toOutboundJob(existing),
        created: false,
        approval: readApproval(storage, "job_id", existing.id),
      };
    }
    const { messageId, jobId, notificationJobId } = ids;
    const fromContact = {
      address: fromAddress.address,
      displayName: identity.displayName,
    };
    writeThreadedMail(storage, {
      direction: "outbound",
      input: {
        messageId,
        mailboxId: identity.id,
        rfcMessageId: null,
        inReplyToHeader: input.inReplyToHeader,
        referencesHeader: input.referencesHeader,
        occurredAt: input.nowIso,
        nowIso: input.nowIso,
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        hasRemoteImages: input.hasRemoteImages,
        from: [fromContact],
        replyTo: [fromContact],
        to,
        cc,
      },
    });
    const needsApproval = authorization.kind === "require_approval";
    insertJobRow(
      storage,
      jobId,
      input.requester,
      input.requestId,
      fingerprint,
      messageId,
      identity.id,
      "message",
      needsApproval ? "waiting_approval" : "ready",
      input.nowIso,
    );
    if (needsApproval) {
      insertJobRow(
        storage,
        notificationJobId,
        input.requester,
        approvalNotificationIdempotencyKey(input.requestId),
        fingerprint,
        messageId,
        identity.id,
        "approval_notification",
        "ready",
        input.nowIso,
      );
      insertPendingApproval(
        storage,
        jobId,
        notificationJobId,
        input.requester,
        input.approval,
        input.nowIso,
      );
    }
    return {
      job: toOutboundJob(requireJob(storage, jobId)),
      created: true,
      approval: readApproval(storage, "job_id", jobId),
    };
  });
}

export function lookupApprovalByTokenHash(
  storage: AccountSqliteStorage,
  tokenHash: ApprovalTokenHash,
): ApprovalLookupResult {
  return storage.transactionSync(() => {
    const approval = readApproval(storage, "token_hash", tokenHash);
    if (approval === null) {
      return { kind: "missing" };
    }
    const job = readJob(storage, "j.id = ?", approval.jobId);
    if (job === null) {
      return { kind: "missing" };
    }
    return { kind: "found", approval, job: toOutboundJob(job) };
  });
}

export function decideApproval(
  storage: AccountSqliteStorage,
  input: DecideApprovalInput,
): ApprovalDecisionResult {
  return storage.transactionSync(() => {
    const approval = readApproval(storage, "token_hash", input.tokenHash);
    if (approval === null) {
      return { kind: "missing" };
    }
    if (approval.state !== "pending") {
      return resolvedDecision(storage, approval);
    }
    // A due approval can no longer be decided; the store's alarm is its only expiry writer.
    const job = readJob(storage, "j.id = ?", approval.jobId);
    if (approval.expiresAt <= input.nowIso || job === null || job.state !== "waiting_approval") {
      return { kind: "unavailable", state: "pending" };
    }
    storage.sql.exec(
      `UPDATE approval_requests
       SET state = ?, resolved_at = ?
       WHERE id = ? AND state = 'pending'`,
      input.decision,
      input.nowIso,
      approval.id,
    );
    if (input.decision === "approved") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'waiting_approval'`,
        "ready",
        input.nowIso,
        approval.jobId,
      );
    } else {
      rejectUndispatched(storage, [job.message_id], { failureClass: "denied" }, input.nowIso);
    }
    return {
      kind: "claimed",
      state: input.decision,
      job: toOutboundJob(requireJob(storage, approval.jobId)),
    };
  });
}

// The `state = 'ready'` guard makes a send at-most-once: only the claim moves a job out of `ready`,
// and an expired claim settles `unknown`, never back to `ready`.
export function claimJob(storage: AccountSqliteStorage, input: ClaimJobInput): ClaimJobResult {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", input.jobId);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.state !== "ready") {
      return { kind: "not_claimable", job: toOutboundJob(current) };
    }
    const rejection = claimRejection(storage, current, input.policy);
    if (rejection !== null) {
      rejectUndispatched(
        storage,
        [current.message_id],
        { failureClass: "policy", failureDetail: rejection },
        input.nowIso,
      );
      return { kind: "rejected", job: toOutboundJob(requireJob(storage, current.id)) };
    }
    storage.sql.exec(
      `UPDATE outbound_jobs
       SET state = ?, attempt_id = ?, attempt_claimed_at = ?, claim_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'ready'`,
      "in_flight",
      input.attemptId,
      input.nowIso,
      input.claimExpiresAt,
      input.nowIso,
      current.id,
    );
    return {
      kind: "claimed",
      attemptId: input.attemptId,
      job: toOutboundJob(requireJob(storage, current.id)),
    };
  });
}

// Rechecks the requester's current policy; the job may have waited for approval since submit.
function claimRejection(
  storage: AccountSqliteStorage,
  job: OutboundJobRow,
  policy: PrincipalPolicy | null,
): JobAuthorizationReason | "approval_required" | null {
  const participants =
    loadParticipantsByMessageIds(storage, [job.message_id]).get(job.message_id) ??
    emptyParticipants();
  const authorization = authorizeOutbound(policy, job.mailbox_id, [
    ...participants.to,
    ...participants.cc,
  ]);
  if (authorization.kind === "denied") {
    return authorization.reason;
  }
  // An approval notification needs no approval itself; a message that does is sent once approved.
  if (
    job.purpose === "message" &&
    authorization.kind === "require_approval" &&
    readApproval(storage, "job_id", job.id)?.state !== "approved"
  ) {
    return "approval_required";
  }
  return null;
}

export function completeAttempt(
  storage: AccountSqliteStorage,
  input: CompleteAttemptInput,
): CompleteAttemptResult {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", input.jobId);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.attempt_id !== input.attemptId) {
      return { kind: "stale", job: toOutboundJob(current) };
    }
    if (current.state !== "in_flight") {
      return { kind: "applied", job: toOutboundJob(current) };
    }
    const outcome = input.outcome;
    if (outcome.kind === "accepted") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, provider_message_id = ?, rfc_message_id = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "accepted",
        outcome.providerMessageId,
        outcome.rfcMessageId,
        input.nowIso,
        current.id,
        input.attemptId,
      );
      if (outcome.rfcMessageId !== null && current.purpose === "message") {
        storage.sql.exec(
          `UPDATE messages
           SET rfc_message_id = ?, updated_at = ?
           WHERE id = ? AND rfc_message_id IS NULL`,
          outcome.rfcMessageId,
          input.nowIso,
          current.message_id,
        );
        linkThread(storage, current.message_id);
      }
    } else if (outcome.kind === "rejected") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, failure_class = ?, failure_detail = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "rejected",
        "provider",
        outcome.failureDetail,
        input.nowIso,
        current.id,
        input.attemptId,
      );
      // Without its notification nobody can decide the approval. A notification that settled
      // `unknown` may have arrived, so only a rejected one gives up on the message.
      if (current.purpose === "approval_notification") {
        rejectUndispatched(
          storage,
          [current.message_id],
          { failureClass: "notification_failed", failureDetail: outcome.failureDetail },
          input.nowIso,
        );
      }
    } else {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "unknown",
        input.nowIso,
        current.id,
        input.attemptId,
      );
    }
    return {
      kind: "applied",
      job: toOutboundJob(requireJob(storage, current.id)),
    };
  });
}

export function readDispatch(
  storage: AccountSqliteStorage,
  jobId: string,
): OutboundDispatch | null {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", jobId);
    if (current === null) {
      return null;
    }
    const content = readDispatchContent(storage, current.message_id);
    if (content === null) {
      throw new Error(`Outbound job ${jobId} is missing message content`);
    }
    const participants =
      loadParticipantsByMessageIds(storage, [current.message_id]).get(current.message_id) ??
      emptyParticipants();
    return {
      job: toOutboundJob(current),
      subject: content.subject ?? "",
      textBody: content.text_body,
      htmlBody: content.html_body,
      hasRemoteImages: content.has_remote_images === 1,
      from: firstContact(participants.from),
      replyTo: firstContact(participants.replyTo),
      to: participants.to,
      cc: participants.cc,
      inReplyToHeader: content.in_reply_to_rfc_message_id,
      referencesHeader: joinStoredReferences(
        loadReferencesByMessageIds(storage, [current.message_id]).get(current.message_id) ?? [],
      ),
      approval: readPendingNotificationApproval(storage, current.id),
    };
  });
}

// The oldest ready jobs, for the store's due-work pass to send.
export function readyJobIds(storage: AccountSqliteStorage, limit: number): ReadonlyArray<string> {
  return Schema.decodeUnknownSync(Schema.Array(JobIdRow))(
    storage.sql
      .exec(
        `SELECT id FROM outbound_jobs
         WHERE state = 'ready'
         ORDER BY created_at, id
         LIMIT ?`,
        limit,
      )
      .toArray(),
  ).map((row) => row.id);
}

// Expires every due approval and rejects the work still waiting on it.
export function expireDueApprovals(storage: AccountSqliteStorage, nowIso: string): void {
  storage.transactionSync(() => {
    const expired = Schema.decodeUnknownSync(Schema.Array(MessageIdRow))(
      storage.sql
        .exec(
          `SELECT j.message_id AS message_id
           FROM approval_requests a
           JOIN outbound_jobs j ON j.id = a.job_id
           WHERE a.state = 'pending' AND a.expires_at <= ?`,
          nowIso,
        )
        .toArray(),
    );
    storage.sql.exec(
      `UPDATE approval_requests
       SET state = 'expired', resolved_at = ?
       WHERE state = 'pending' AND expires_at <= ?`,
      nowIso,
      nowIso,
    );
    rejectUndispatched(
      storage,
      expired.map((row) => row.message_id),
      { failureClass: "expired" },
      nowIso,
    );
  });
}

// A claim that outlived its expiry was interrupted mid-send, so the mail may have gone out. It
// settles `unknown` and is never sent again.
export function settleAbandonedClaims(storage: AccountSqliteStorage, nowIso: string): void {
  storage.sql.exec(
    `UPDATE outbound_jobs
     SET state = 'unknown', updated_at = ?
     WHERE state = 'in_flight' AND claim_expires_at <= ?`,
    nowIso,
    nowIso,
  );
}

export function getOutboundJob(
  storage: AccountSqliteStorage,
  jobId: string,
  viewer: JobViewer,
): OutboundJob | null {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", jobId);
    if (
      current === null ||
      !viewerCanSee(viewer, current.requester_kind, current.requester_client_id)
    ) {
      return null;
    }
    return toOutboundJob(current);
  });
}

export function listOutboundJobs(
  storage: AccountSqliteStorage,
  query: ListOutboundJobsQuery,
): OutboundJobPage {
  const limit = pageLimit(query.limit);
  return storage.transactionSync(() => {
    const clauses: Array<string> = [];
    const binds: Array<string | number> = [];
    if (query.viewer.kind === "mcp") {
      clauses.push("j.requester_kind = ?", "j.requester_client_id = ?");
      binds.push("mcp");
      binds.push(query.viewer.clientId);
    }
    if (query.cursor !== undefined) {
      clauses.push("(j.created_at < ? OR (j.created_at = ? AND j.id < ?))");
      binds.push(query.cursor.at, query.cursor.at, query.cursor.id);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = Schema.decodeUnknownSync(Schema.Array(OutboundJobRow))(
      storage.sql
        .exec(
          `SELECT ${JOB_SELECT}
           FROM outbound_jobs j
           JOIN messages m ON m.id = j.message_id
           ${where}
           ORDER BY j.created_at DESC, j.id DESC
           LIMIT ?`,
          ...binds,
          limit + 1,
        )
        .toArray(),
    );
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toOutboundJob),
      nextCursor:
        rows.length > limit && last !== undefined ? { at: last.created_at, id: last.id } : null,
    };
  });
}

// Rejects every job of these messages that has not been sent, and cancels the approvals they
// wait on. Jobs already claimed or settled are left alone.
export function rejectUndispatched(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
  failure: {
    readonly failureClass: Exclude<OutboundJobFailureClass, "provider">;
    readonly failureDetail?: string | undefined;
  },
  nowIso: string,
): void {
  if (messageIds.length === 0) {
    return;
  }
  const boundIds = bindJsonStringArray(messageIds);
  storage.sql.exec(
    `UPDATE approval_requests
     SET state = 'cancelled', resolved_at = ?
     WHERE state = 'pending'
       AND job_id IN (
         SELECT id FROM outbound_jobs
         WHERE message_id IN (SELECT value FROM json_each(?))
           AND state IN ('waiting_approval', 'ready')
       )`,
    nowIso,
    boundIds,
  );
  storage.sql.exec(
    `UPDATE outbound_jobs
     SET state = 'rejected', failure_class = ?, failure_detail = ?, updated_at = ?
     WHERE message_id IN (SELECT value FROM json_each(?))
       AND state IN ('waiting_approval', 'ready')`,
    failure.failureClass,
    failure.failureDetail ?? null,
    nowIso,
    boundIds,
  );
}

function insertPendingApproval(
  storage: AccountSqliteStorage,
  messageJobId: string,
  notificationJobId: string,
  requester: OutboundRequester,
  approval: ApprovalCapabilityWrite,
  nowIso: string,
): void {
  storage.sql.exec(
    `INSERT INTO approval_requests (
       id, job_id, notification_job_id, token_hash, state, requester_client_id, requester_label,
       created_at, resolved_at, expires_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?)`,
    approval.approvalId,
    messageJobId,
    notificationJobId,
    approval.tokenHash,
    requester.clientId,
    requester.label,
    nowIso,
    approval.expiresAt,
  );
}

function insertJobRow(
  storage: AccountSqliteStorage,
  jobId: string,
  requester: OutboundRequester,
  idempotencyKey: string,
  fingerprint: string,
  messageId: string,
  mailboxId: string,
  purpose: OutboundJobPurpose,
  state: "waiting_approval" | "ready",
  nowIso: string,
): void {
  storage.sql.exec(
    `INSERT INTO outbound_jobs (
       id, requester_kind, requester_client_id, requester_label, idempotency_key,
       intent_fingerprint, message_id, mailbox_id, purpose, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId,
    requester.kind,
    requester.clientId,
    requester.label,
    idempotencyKey,
    fingerprint,
    messageId,
    mailboxId,
    purpose,
    state,
    nowIso,
    nowIso,
  );
}

function resolvedDecision(
  storage: AccountSqliteStorage,
  approval: StoredApproval,
): ApprovalDecisionResult {
  if (approval.state === "pending") {
    return { kind: "unavailable", state: "pending" };
  }
  const job = readJob(storage, "j.id = ?", approval.jobId);
  return {
    kind: "resolved",
    state: approval.state,
    job: job === null ? null : toOutboundJob(job),
    expiresAt: approval.expiresAt,
  };
}

function authorizeOutbound(
  policy: PrincipalPolicy | null,
  mailboxId: string,
  recipients: ReadonlyArray<AccountMailContact>,
):
  | { readonly kind: "allow" }
  | { readonly kind: "require_approval" }
  | { readonly kind: "denied"; readonly reason: JobAuthorizationReason } {
  if (policy === null) {
    return { kind: "denied", reason: "client_inactive" };
  }
  if (!mailboxInPolicy(policy.mailboxIds, mailboxId)) {
    return { kind: "denied", reason: "mailbox_forbidden" };
  }
  if (policy.sendMode.kind === "deny") {
    return { kind: "denied", reason: "send_denied" };
  }
  if (
    policy.recipientAllowlist !== "any" &&
    !allRecipientsIn(policy.recipientAllowlist, recipients)
  ) {
    return { kind: "denied", reason: "recipient_not_allowed" };
  }
  if (policy.sendMode.kind === "allow") {
    return { kind: "allow" };
  }
  if (allRecipientsIn(policy.sendMode.preapprovedRecipients, recipients)) {
    return { kind: "allow" };
  }
  return { kind: "require_approval" };
}

function mailboxInPolicy(mailboxIds: PrincipalPolicy["mailboxIds"], mailboxId: string): boolean {
  if (mailboxIds === "all") {
    return true;
  }
  return mailboxIds.includes(mailboxId);
}

function allRecipientsIn(
  addresses: ReadonlyArray<AccountMailContact["address"]>,
  recipients: ReadonlyArray<AccountMailContact>,
): boolean {
  const allowed = new Set(addresses.map(comparisonKey));
  return recipients.every((recipient) => allowed.has(comparisonKey(recipient.address)));
}

function outboundIntentFingerprint(input: {
  readonly mailboxId: string;
  readonly fromAddress: string;
  readonly to: ReadonlyArray<AccountMailContact>;
  readonly cc: ReadonlyArray<AccountMailContact>;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
}): string {
  return JSON.stringify([
    input.mailboxId,
    input.fromAddress,
    input.to.map((contact) => [contact.address, contact.displayName]),
    input.cc.map((contact) => [contact.address, contact.displayName]),
    input.subject,
    input.textBody,
    input.htmlBody,
    input.inReplyToHeader,
    input.referencesHeader,
  ]);
}

function dedupeAccountMailContacts(
  contacts: ReadonlyArray<AccountMailContact>,
): ReadonlyArray<AccountMailContact> {
  const seen = new Set<string>();
  const deduped: Array<AccountMailContact> = [];
  for (const contact of contacts) {
    const key = comparisonKey(contact.address);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(contact);
  }
  return deduped;
}

function readJob(
  storage: AccountSqliteStorage,
  where: string,
  ...binds: ReadonlyArray<string>
): OutboundJobRow | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(OutboundJobRow),
    storage.sql
      .exec(
        `SELECT ${JOB_SELECT}
         FROM outbound_jobs j
         JOIN messages m ON m.id = j.message_id
         WHERE ${where}`,
        ...binds,
      )
      .toArray(),
  );
  return row ?? null;
}

function requireJob(storage: AccountSqliteStorage, jobId: string): OutboundJobRow {
  const job = readJob(storage, "j.id = ?", jobId);
  if (job === null) {
    throw new Error(`Missing outbound job ${jobId}`);
  }
  return job;
}

function readApproval(
  storage: AccountSqliteStorage,
  column: "token_hash" | "job_id",
  value: string,
): StoredApproval | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(ApprovalRequestRow),
    storage.sql
      .exec(
        `SELECT id, job_id, token_hash, state, requester_client_id, requester_label,
                created_at, resolved_at, expires_at
         FROM approval_requests
         WHERE ${column} = ?`,
        value,
      )
      .toArray(),
  );
  return row === undefined ? null : toStoredApproval(row);
}

function toStoredApproval(row: ApprovalRequestRow): StoredApproval {
  return {
    id: row.id,
    jobId: row.job_id,
    tokenHash: row.token_hash,
    state: row.state,
    requester: {
      clientId: row.requester_client_id,
      label: row.requester_label,
    },
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
  };
}

function toOutboundJob(row: OutboundJobRow): OutboundJob {
  return {
    jobId: row.id,
    requestId: row.idempotency_key,
    requester: requesterFromRow(row),
    messageId: row.message_id,
    threadId: row.thread_id,
    mailboxId: row.mailbox_id,
    purpose: row.purpose,
    state: row.state,
    attemptId: row.attempt_id,
    providerMessageId: row.provider_message_id,
    rfcMessageId: row.rfc_message_id,
    failureClass: row.failure_class,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requesterFromRow(row: OutboundJobRow): OutboundRequester {
  return {
    kind: row.requester_kind,
    clientId: row.requester_client_id,
    label: row.requester_label,
  };
}

function viewerCanSee(
  viewer: JobViewer,
  requesterKind: OutboundRequester["kind"],
  requesterClientId: string,
): boolean {
  if (viewer.kind === "operator") {
    return true;
  }
  return requesterKind === "mcp" && viewer.clientId === requesterClientId;
}

const DispatchContentRow = Schema.Struct({
  subject: Schema.NullOr(Schema.String),
  text_body: Schema.NullOr(Schema.String),
  html_body: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  in_reply_to_rfc_message_id: Schema.NullOr(Schema.String),
});

function readDispatchContent(
  storage: AccountSqliteStorage,
  messageId: string,
): typeof DispatchContentRow.Type | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(DispatchContentRow),
    storage.sql
      .exec(
        `SELECT subject, text_body, html_body, has_remote_images, in_reply_to_rfc_message_id
         FROM messages
         WHERE id = ?`,
        messageId,
      )
      .toArray(),
  );
  return row ?? null;
}

function joinStoredReferences(ids: ReadonlyArray<string>): string | null {
  if (ids.length === 0) {
    return null;
  }
  return ids.join(" ");
}

function firstContact(contacts: ReadonlyArray<AccountMailContact>): AccountMailContact | null {
  return contacts[0] ?? null;
}

const JobIdRow = Schema.Struct({ id: Schema.String });

const MessageIdRow = Schema.Struct({ message_id: Schema.String });

const NotificationApprovalRow = Schema.Struct({
  id: Schema.String,
  expires_at: Schema.String,
});

function readPendingNotificationApproval(
  storage: AccountSqliteStorage,
  notificationJobId: string,
): OutboundDispatch["approval"] {
  const row = firstDecoded(
    Schema.decodeUnknownSync(NotificationApprovalRow),
    storage.sql
      .exec(
        `SELECT id, expires_at FROM approval_requests
         WHERE notification_job_id = ? AND state = 'pending'`,
        notificationJobId,
      )
      .toArray(),
  );
  return row === undefined ? null : { approvalId: row.id, expiresAt: row.expires_at };
}
