import {
  OPERATOR_POLICY,
  approvalNotificationIdempotencyKey,
  comparisonKey,
  parseExternalMailAddress,
  type ApprovalTokenHash,
  type OutboundJobPurpose,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

import { getMcpOAuthPolicy, resolveSendingIdentity } from "./administration.ts";
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
  type ClaimDispatchInput,
  type ClaimDispatchResult,
  type CompleteAttemptInput,
  type CompleteAttemptResult,
  type DecideApprovalInput,
  type JobViewer,
  type ListOutboundJobsQuery,
  type OutboundDispatch,
  type OutboundJob,
  type OutboundJobPage,
  type OutboundRequester,
  type RejectReadyDispatchInput,
  type RejectReadyDispatchResult,
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
    const authorization = authorizeOutbound(storage, input.requester, identity.id, recipients);
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
    const messageId = crypto.randomUUID();
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
    const jobId = crypto.randomUUID();
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
      const notificationJobId = crypto.randomUUID();
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
    // A due approval expires on its POST; Recovery's `recoverOutbound` sweeps the rest.
    if (approval.expiresAt <= input.nowIso) {
      storage.sql.exec(
        `UPDATE approval_requests
         SET state = 'expired', resolved_at = ?
         WHERE id = ? AND state = 'pending'`,
        input.nowIso,
        approval.id,
      );
      rejectJob(storage, approval.jobId, input.nowIso, "expired", null);
      return resolvedDecision(storage, { ...approval, state: "expired" });
    }
    const job = readJob(storage, "j.id = ?", approval.jobId);
    if (job === null || job.state !== "waiting_approval") {
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
      rejectJob(storage, approval.jobId, input.nowIso, "denied", null);
    }
    return {
      kind: "claimed",
      state: input.decision,
      job: toOutboundJob(requireJob(storage, approval.jobId)),
    };
  });
}

export function claimDispatch(
  storage: AccountSqliteStorage,
  input: ClaimDispatchInput,
): ClaimDispatchResult {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", input.jobId);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.state !== "ready") {
      return { kind: "not_claimable", job: toOutboundJob(current) };
    }
    const participants =
      loadParticipantsByMessageIds(storage, [current.message_id]).get(current.message_id) ??
      emptyParticipants();
    const authorization = authorizeOutbound(
      storage,
      requesterFromRow(current),
      current.mailbox_id,
      [...participants.to, ...participants.cc],
    );
    if (authorization.kind === "denied") {
      rejectJob(storage, current.id, input.nowIso, "policy", authorization.reason);
      cancelApprovalOfFailedNotification(storage, current, input.nowIso);
      return {
        kind: "rejected",
        job: toOutboundJob(requireJob(storage, current.id)),
      };
    }
    if (current.purpose !== "approval_notification" && authorization.kind === "require_approval") {
      const approval = readApproval(storage, "job_id", current.id);
      if (approval === null || approval.state !== "approved") {
        rejectJob(storage, current.id, input.nowIso, "policy", "approval_required");
        return {
          kind: "rejected",
          job: toOutboundJob(requireJob(storage, current.id)),
        };
      }
    }
    // The `state = 'ready'` guard is what makes a send at-most-once.
    const attemptId = crypto.randomUUID();
    storage.sql.exec(
      `UPDATE outbound_jobs
       SET state = ?, attempt_id = ?, attempt_claimed_at = ?, claim_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'ready'`,
      "in_flight",
      attemptId,
      input.nowIso,
      input.claimExpiresAt,
      input.nowIso,
      current.id,
    );
    return {
      kind: "claimed",
      attemptId,
      job: toOutboundJob(requireJob(storage, current.id)),
    };
  });
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
      cancelApprovalOfFailedNotification(storage, current, input.nowIso);
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

export function rejectReadyDispatch(
  storage: AccountSqliteStorage,
  input: RejectReadyDispatchInput,
): RejectReadyDispatchResult {
  return storage.transactionSync(() => {
    const current = readJob(storage, "j.id = ?", input.jobId);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.state !== "ready") {
      return { kind: "stale", job: toOutboundJob(current) };
    }
    rejectJob(storage, current.id, input.nowIso, "provider", input.failureDetail);
    cancelApprovalOfFailedNotification(storage, current, input.nowIso);
    return {
      kind: "rejected",
      job: toOutboundJob(requireJob(storage, current.id)),
    };
  });
}

export function getOutboundDispatch(
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

// One Recovery pass over outbound work. An expired claim settles `unknown` and never returns to
// `ready`, so a job is never sent twice; due approvals expire; the oldest ready jobs are returned
// for publishing. SendConsumer's claim makes a repeated publish harmless.
export function recoverOutbound(
  storage: AccountSqliteStorage,
  input: { readonly nowIso: string; readonly limit: number },
): ReadonlyArray<string> {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE outbound_jobs
       SET state = 'unknown', updated_at = ?
       WHERE state = 'in_flight' AND claim_expires_at <= ?`,
      input.nowIso,
      input.nowIso,
    );
    const expired = Schema.decodeUnknownSync(Schema.Array(ApprovalJobIdRow))(
      storage.sql
        .exec(
          `UPDATE approval_requests
           SET state = 'expired', resolved_at = ?
           WHERE state = 'pending' AND expires_at <= ?
           RETURNING job_id`,
          input.nowIso,
          input.nowIso,
        )
        .toArray(),
    );
    for (const row of expired) {
      rejectJob(storage, row.job_id, input.nowIso, "expired", null);
    }
    return Schema.decodeUnknownSync(Schema.Array(JobIdRow))(
      storage.sql
        .exec(
          `SELECT id FROM outbound_jobs
           WHERE state = 'ready'
           ORDER BY created_at, id
           LIMIT ?`,
          input.limit,
        )
        .toArray(),
    ).map((row) => row.id);
  });
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

export function cancelUndispatchedJobsForMessages(
  storage: AccountSqliteStorage,
  messageIds: ReadonlyArray<string>,
  cancelledAt: string,
): void {
  if (messageIds.length === 0) {
    return;
  }
  const boundIds = bindJsonStringArray(messageIds);
  storage.sql.exec(
    `UPDATE approval_requests
     SET state = ?, resolved_at = ?
     WHERE state = 'pending'
       AND job_id IN (
         SELECT id FROM outbound_jobs
         WHERE message_id IN (SELECT value FROM json_each(?))
           AND state IN ('waiting_approval', 'ready')
       )`,
    "cancelled",
    cancelledAt,
    boundIds,
  );
  storage.sql.exec(
    `UPDATE outbound_jobs
     SET state = ?, failure_class = ?, updated_at = ?
     WHERE message_id IN (SELECT value FROM json_each(?))
       AND state IN ('waiting_approval', 'ready')`,
    "rejected",
    "cancelled",
    cancelledAt,
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

// Without its notification nobody can decide the approval, so a rejected notification cancels it and
// rejects the parked message. A notification that settled `unknown` may have arrived, so it keeps
// the approval waiting.
function cancelApprovalOfFailedNotification(
  storage: AccountSqliteStorage,
  job: OutboundJobRow,
  nowIso: string,
): void {
  if (job.purpose !== "approval_notification") {
    return;
  }
  const cancelled = Schema.decodeUnknownSync(Schema.Array(ApprovalJobIdRow))(
    storage.sql
      .exec(
        `UPDATE approval_requests
         SET state = 'cancelled', resolved_at = ?
         WHERE notification_job_id = ? AND state = 'pending'
         RETURNING job_id`,
        nowIso,
        job.id,
      )
      .toArray(),
  );
  for (const row of cancelled) {
    rejectJob(storage, row.job_id, nowIso, "notification_failed", null);
  }
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
  };
}

function rejectJob(
  storage: AccountSqliteStorage,
  jobId: string,
  nowIso: string,
  failureClass: "denied" | "expired" | "cancelled" | "notification_failed" | "policy" | "provider",
  failureDetail: string | null,
): void {
  storage.sql.exec(
    `UPDATE outbound_jobs
     SET state = ?, failure_class = ?, failure_detail = ?, updated_at = ?
     WHERE id = ? AND state IN ('waiting_approval', 'ready')`,
    "rejected",
    failureClass,
    failureDetail,
    nowIso,
    jobId,
  );
}

function authorizeOutbound(
  storage: AccountSqliteStorage,
  requester: OutboundRequester,
  mailboxId: string,
  recipients: ReadonlyArray<AccountMailContact>,
):
  | { readonly kind: "allow" }
  | { readonly kind: "require_approval" }
  | { readonly kind: "denied"; readonly reason: JobAuthorizationReason } {
  const policy = loadRequesterPolicy(storage, requester);
  if (policy === null || policy.state !== "active") {
    return { kind: "denied", reason: "client_inactive" };
  }
  if (!mailboxInPolicy(policy.policy.mailboxIds, mailboxId)) {
    return { kind: "denied", reason: "mailbox_forbidden" };
  }
  if (policy.policy.sendMode.kind === "deny") {
    return { kind: "denied", reason: "send_denied" };
  }
  if (!recipientsAllowed(policy.policy.recipientAllowlist, recipients)) {
    return { kind: "denied", reason: "recipient_not_allowed" };
  }
  if (policy.policy.sendMode.kind === "allow") {
    return { kind: "allow" };
  }
  if (recipientsPreapproved(policy.policy.sendMode.preapprovedRecipients, recipients)) {
    return { kind: "allow" };
  }
  return { kind: "require_approval" };
}

function loadRequesterPolicy(
  storage: AccountSqliteStorage,
  requester: OutboundRequester,
): { readonly state: "active" | "disabled" | "revoked"; readonly policy: PrincipalPolicy } | null {
  if (requester.kind === "operator") {
    return { state: "active", policy: OPERATOR_POLICY };
  }
  const stored = getMcpOAuthPolicy(storage, requester.clientId);
  if (stored === null) {
    return null;
  }
  return { state: stored.state, policy: stored.policy };
}

function mailboxInPolicy(mailboxIds: PrincipalPolicy["mailboxIds"], mailboxId: string): boolean {
  if (mailboxIds === "all") {
    return true;
  }
  return mailboxIds.includes(mailboxId);
}

function recipientsAllowed(
  allowlist: PrincipalPolicy["recipientAllowlist"],
  recipients: ReadonlyArray<AccountMailContact>,
): boolean {
  if (allowlist === "any") {
    return true;
  }
  const allowed = new Set(allowlist.map(comparisonKey));
  for (const recipient of recipients) {
    if (!allowed.has(comparisonKey(recipient.address))) {
      return false;
    }
  }
  return true;
}

function recipientsPreapproved(
  preapproved: ReadonlyArray<AccountMailContact["address"]>,
  recipients: ReadonlyArray<AccountMailContact>,
): boolean {
  const allowed = new Set(preapproved.map(comparisonKey));
  for (const recipient of recipients) {
    if (!allowed.has(comparisonKey(recipient.address))) {
      return false;
    }
  }
  return true;
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
    threadHandle: row.thread_id,
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

const ApprovalJobIdRow = Schema.Struct({ job_id: Schema.String });

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
