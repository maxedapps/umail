import {
  ApprovalTokenHash,
  approvalNotificationIdempotencyKey,
  comparisonKey,
  nodeThreadHandle,
  parseExternalMailAddress,
  type OutboundJobPurpose,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

import { getMcpOAuthPolicy, resolveSendingIdentity } from "./administration.ts";
import {
  defaultPersistThreadingOptions,
  writeOwnRfcIdentityClaim,
  writeThreadedMail,
  type PersistThreadingOptions,
} from "./commands.ts";
import {
  AccountMailContact,
  ApprovalCapabilityWrite,
  ApprovalConvergenceResult,
  ApprovalDecisionResult,
  ApprovalLookupResult,
  ApprovalRequestRow,
  CancelApprovalNotificationInput,
  ClaimDispatchInput,
  ClaimDispatchResult,
  CompleteAttemptInput,
  CompleteAttemptResult,
  DecideApprovalInput,
  ExpireApprovalInput,
  JobListCursor,
  JobViewer,
  ListDueApprovalsInput,
  ListDueApprovalsPage,
  ListOutboundJobsQuery,
  ListPurgeableNotificationsInput,
  ListPurgeableNotificationsPage,
  ListSendWorkInput,
  ListSendWorkPage,
  MAX_OUTBOUND_RECIPIENTS,
  OutboundDispatch,
  OutboundJob,
  OutboundJobPage,
  OutboundJobRow,
  OutboundRequester,
  PurgeNotificationCiphertextInput,
  PurgeNotificationCiphertextResult,
  QUERY_PAGE_DEFAULT,
  QUERY_PAGE_MAX,
  RejectReadyDispatchInput,
  RejectReadyDispatchResult,
  SettleExpiredInFlightInput,
  StoredApproval,
  StoredNotificationCiphertext,
  SubmitOutboundInput,
  SubmitOutboundResult,
} from "./domain.ts";
import {
  AccountStoreUnexpectedError,
  JobAuthorizationError,
  QueryInputError,
  SubmissionConflictError,
  type JobAuthorizationReason,
} from "./errors.ts";
import {
  bindJsonStringArray,
  firstDecoded,
  type AccountSqlRow,
  type AccountSqliteStorage,
} from "./sqlite.ts";

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
       m.node_id AS node_id`;

const operatorPolicy = {
  mailboxIds: "all",
  canRead: true,
  canDelete: true,
  sendMode: { kind: "allow" },
  recipientAllowlist: "any",
  canAdmin: true,
} as const satisfies PrincipalPolicy;

export function submitOutbound(
  storage: AccountSqliteStorage,
  input: SubmitOutboundInput,
  options: PersistThreadingOptions = defaultPersistThreadingOptions,
): SubmitOutboundResult {
  const parsed = Schema.decodeSync(SubmitOutboundInput)(input);
  const to = dedupeAccountMailContacts(parsed.to);
  const cc = dedupeAccountMailContacts(parsed.cc);
  if (to.length === 0) {
    throw new QueryInputError({ reason: "invalid_query" });
  }
  if (to.length + cc.length > MAX_OUTBOUND_RECIPIENTS) {
    throw new QueryInputError({ reason: "invalid_query" });
  }
  return storage.transactionSync(() => {
    const identity = resolveSendingIdentity(storage, parsed.mailboxId, parsed.mailDomain);
    if (identity === null) {
      throw new JobAuthorizationError({ reason: "mailbox_forbidden" });
    }
    const fromAddress = parseExternalMailAddress(identity.address);
    if (fromAddress.kind === "invalid") {
      throw new JobAuthorizationError({ reason: "mailbox_forbidden" });
    }
    const recipients = [...to, ...cc];
    const authorization = authorizeOutbound(storage, parsed.requester, identity.id, recipients);
    if (authorization.kind === "denied") {
      throw new JobAuthorizationError({ reason: authorization.reason });
    }
    const fingerprint = outboundIntentFingerprint({
      mailboxId: identity.id,
      fromAddress: fromAddress.address,
      to,
      cc,
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody,
      inReplyToHeader: parsed.inReplyToHeader,
      referencesHeader: parsed.referencesHeader,
    });
    const existing = readJobByRequesterKey(
      storage,
      parsed.requester.kind,
      parsed.requester.clientId,
      parsed.requestId,
    );
    if (existing !== null) {
      if (existing.row.intent_fingerprint !== fingerprint) {
        throw new SubmissionConflictError({
          requestId: parsed.requestId,
          requesterClientId: parsed.requester.clientId,
        });
      }
      return Schema.decodeSync(SubmitOutboundResult)({
        job: toOutboundJob(existing),
        created: false,
        approval: readApprovalForJob(storage, existing.row.id),
      });
    }
    if (authorization.kind === "require_approval" && parsed.approval === undefined) {
      throw new JobAuthorizationError({ reason: "approval_material_required" });
    }
    const messageId = crypto.randomUUID();
    const fromContact = {
      address: fromAddress.address,
      displayName: identity.displayName,
    };
    writeThreadedMail(
      storage,
      {
        direction: "outbound",
        input: {
          messageId,
          mailboxId: identity.id,
          rfcMessageId: null,
          inReplyToHeader: parsed.inReplyToHeader,
          referencesHeader: parsed.referencesHeader,
          occurredAt: parsed.nowIso,
          nowIso: parsed.nowIso,
          subject: parsed.subject,
          textBody: parsed.textBody,
          htmlBody: parsed.htmlBody,
          hasRemoteImages: parsed.hasRemoteImages,
          from: [fromContact],
          replyTo: [fromContact],
          to,
          cc,
        },
      },
      options,
    );
    const jobId = crypto.randomUUID();
    const state = authorization.kind === "require_approval" ? "waiting_approval" : "ready";
    insertJobRow(
      storage,
      jobId,
      parsed.requester,
      parsed.requestId,
      fingerprint,
      messageId,
      identity.id,
      "message",
      state,
      parsed.nowIso,
    );
    if (authorization.kind === "require_approval") {
      const approval = parsed.approval;
      if (approval === undefined) {
        throw new JobAuthorizationError({ reason: "approval_material_required" });
      }
      const notificationJobId = crypto.randomUUID();
      insertJobRow(
        storage,
        notificationJobId,
        parsed.requester,
        approvalNotificationIdempotencyKey(parsed.requestId),
        fingerprint,
        messageId,
        identity.id,
        "approval_notification",
        "ready",
        parsed.nowIso,
      );
      insertPendingApproval(
        storage,
        jobId,
        notificationJobId,
        parsed.requester,
        approval,
        parsed.nowIso,
      );
    }
    const created = requireJobRecord(storage, jobId);
    return Schema.decodeSync(SubmitOutboundResult)({
      job: toOutboundJob(created),
      created: true,
      approval: readApprovalForJob(storage, jobId),
    });
  });
}

export function lookupApprovalByTokenHash(
  storage: AccountSqliteStorage,
  tokenHash: ApprovalTokenHash,
): ApprovalLookupResult {
  const parsedHash = Schema.decodeSync(ApprovalTokenHash)(tokenHash);
  return storage.transactionSync(() => {
    const approval = readApprovalByTokenHash(storage, parsedHash);
    if (approval === null) {
      return Schema.decodeSync(ApprovalLookupResult)({ kind: "missing" });
    }
    const job = readJobRecord(storage, approval.jobId);
    if (job === null) {
      return Schema.decodeSync(ApprovalLookupResult)({ kind: "missing" });
    }
    return Schema.decodeSync(ApprovalLookupResult)({
      kind: "found",
      approval,
      job: toOutboundJob(job),
    });
  });
}

export function decideApproval(
  storage: AccountSqliteStorage,
  input: DecideApprovalInput,
): ApprovalDecisionResult {
  const parsed = Schema.decodeSync(DecideApprovalInput)(input);
  return storage.transactionSync(() => {
    const approval = readApprovalByTokenHash(storage, parsed.tokenHash);
    if (approval === null) {
      return Schema.decodeSync(ApprovalDecisionResult)({ kind: "missing" });
    }
    if (approval.state !== "pending") {
      return resolvedDecision(storage, approval);
    }
    if (approval.expiresAt <= parsed.nowIso) {
      return Schema.decodeSync(ApprovalDecisionResult)({
        kind: "unavailable",
        state: "pending",
      });
    }
    const job = readJobRecord(storage, approval.jobId);
    if (job === null || job.row.state !== "waiting_approval") {
      return Schema.decodeSync(ApprovalDecisionResult)({
        kind: "unavailable",
        state: "pending",
      });
    }
    storage.sql.exec(
      `UPDATE approval_requests
       SET state = ?, resolved_at = ?
       WHERE id = ? AND state = 'pending' AND expires_at > ?`,
      parsed.decision,
      parsed.nowIso,
      approval.id,
      parsed.nowIso,
    );
    const claimed = readApprovalById(storage, approval.id);
    if (claimed === null || claimed.state !== parsed.decision) {
      return resolvedDecision(storage, requireApprovalById(storage, approval.id));
    }
    if (parsed.decision === "approved") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'waiting_approval'`,
        "ready",
        parsed.nowIso,
        approval.jobId,
      );
    } else {
      rejectJob(storage, approval.jobId, parsed.nowIso, "denied", null);
    }
    return Schema.decodeSync(ApprovalDecisionResult)({
      kind: "claimed",
      state: parsed.decision,
      job: toOutboundJob(requireJobRecord(storage, approval.jobId)),
    });
  });
}

export function expirePendingApproval(
  storage: AccountSqliteStorage,
  input: ExpireApprovalInput,
): ApprovalConvergenceResult {
  const parsed = Schema.decodeSync(ExpireApprovalInput)(input);
  return storage.transactionSync(() =>
    convergePendingApproval(storage, parsed.approvalId, parsed.nowIso, "expired", true),
  );
}

export function cancelApprovalAfterNotificationFailure(
  storage: AccountSqliteStorage,
  input: CancelApprovalNotificationInput,
): ApprovalConvergenceResult {
  const parsed = Schema.decodeSync(CancelApprovalNotificationInput)(input);
  return storage.transactionSync(() =>
    convergePendingApproval(
      storage,
      parsed.approvalId,
      parsed.nowIso,
      "cancelled",
      false,
      "notification_failed",
    ),
  );
}

export function claimDispatch(
  storage: AccountSqliteStorage,
  input: ClaimDispatchInput,
): ClaimDispatchResult {
  const parsed = Schema.decodeSync(ClaimDispatchInput)(input);
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, parsed.jobId);
    if (current === null) {
      return Schema.decodeSync(ClaimDispatchResult)({ kind: "missing" });
    }
    if (current.row.state !== "ready") {
      return Schema.decodeSync(ClaimDispatchResult)({
        kind: "not_claimable",
        job: toOutboundJob(current),
      });
    }
    const recipients = loadJobRecipients(storage, current.row.message_id);
    const authorization = authorizeOutbound(
      storage,
      requesterFromRow(current.row),
      current.row.mailbox_id,
      recipients,
    );
    if (authorization.kind === "denied") {
      rejectJob(storage, current.row.id, parsed.nowIso, "policy", authorization.reason);
      return Schema.decodeSync(ClaimDispatchResult)({
        kind: "rejected",
        job: toOutboundJob(requireJobRecord(storage, current.row.id)),
      });
    }
    if (
      current.row.purpose !== "approval_notification" &&
      authorization.kind === "require_approval"
    ) {
      const approval = readApprovalForJob(storage, current.row.id);
      if (approval === null || approval.state !== "approved") {
        rejectJob(storage, current.row.id, parsed.nowIso, "policy", "approval_required");
        return Schema.decodeSync(ClaimDispatchResult)({
          kind: "rejected",
          job: toOutboundJob(requireJobRecord(storage, current.row.id)),
        });
      }
    }
    const attemptId = crypto.randomUUID();
    storage.sql.exec(
      `UPDATE outbound_jobs
       SET state = ?, attempt_id = ?, attempt_claimed_at = ?, claim_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'ready'`,
      "in_flight",
      attemptId,
      parsed.nowIso,
      parsed.claimExpiresAt,
      parsed.nowIso,
      current.row.id,
    );
    const claimed = requireJobRecord(storage, current.row.id);
    if (claimed.row.state !== "in_flight" || claimed.row.attempt_id !== attemptId) {
      return Schema.decodeSync(ClaimDispatchResult)({
        kind: "not_claimable",
        job: toOutboundJob(claimed),
      });
    }
    return Schema.decodeSync(ClaimDispatchResult)({
      kind: "claimed",
      attemptId,
      job: toOutboundJob(claimed),
    });
  });
}

export function completeAttempt(
  storage: AccountSqliteStorage,
  input: CompleteAttemptInput,
): CompleteAttemptResult {
  const parsed = Schema.decodeSync(CompleteAttemptInput)(input);
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, parsed.jobId);
    if (current === null) {
      return Schema.decodeSync(CompleteAttemptResult)({ kind: "missing" });
    }
    if (current.row.attempt_id !== parsed.attemptId) {
      return Schema.decodeSync(CompleteAttemptResult)({
        kind: "stale",
        job: toOutboundJob(current),
      });
    }
    if (current.row.state !== "in_flight") {
      return Schema.decodeSync(CompleteAttemptResult)({
        kind: "applied",
        job: toOutboundJob(current),
      });
    }
    if (parsed.outcome.kind === "accepted") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, provider_message_id = ?, rfc_message_id = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "accepted",
        parsed.outcome.providerMessageId,
        parsed.outcome.rfcMessageId,
        parsed.nowIso,
        current.row.id,
        parsed.attemptId,
      );
      const acceptedRfcMessageId = parsed.outcome.rfcMessageId;
      if (acceptedRfcMessageId !== null && current.row.purpose === "message") {
        storage.sql.exec(
          `UPDATE messages
           SET rfc_message_id = ?, updated_at = ?
           WHERE id = ? AND rfc_message_id IS NULL`,
          acceptedRfcMessageId,
          parsed.nowIso,
          current.row.message_id,
        );
        if (current.row.node_id !== null) {
          writeOwnRfcIdentityClaim(storage, {
            nodeId: current.row.node_id,
            rfcMessageId: acceptedRfcMessageId,
          });
        }
      }
    } else if (parsed.outcome.kind === "rejected") {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, failure_class = ?, failure_detail = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "rejected",
        parsed.outcome.failureClass,
        parsed.outcome.failureDetail,
        parsed.nowIso,
        current.row.id,
        parsed.attemptId,
      );
    } else {
      storage.sql.exec(
        `UPDATE outbound_jobs
         SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'in_flight' AND attempt_id = ?`,
        "unknown",
        parsed.nowIso,
        current.row.id,
        parsed.attemptId,
      );
    }
    return Schema.decodeSync(CompleteAttemptResult)({
      kind: "applied",
      job: toOutboundJob(requireJobRecord(storage, current.row.id)),
    });
  });
}

export function settleExpiredInFlight(
  storage: AccountSqliteStorage,
  input: SettleExpiredInFlightInput,
): CompleteAttemptResult {
  const parsed = Schema.decodeSync(SettleExpiredInFlightInput)(input);
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, parsed.jobId);
    if (current === null) {
      return Schema.decodeSync(CompleteAttemptResult)({ kind: "missing" });
    }
    if (
      current.row.state !== "in_flight" ||
      current.row.attempt_id !== parsed.attemptId ||
      current.row.claim_expires_at === null ||
      current.row.claim_expires_at > parsed.nowIso
    ) {
      return Schema.decodeSync(CompleteAttemptResult)({
        kind: "stale",
        job: toOutboundJob(current),
      });
    }
    storage.sql.exec(
      `UPDATE outbound_jobs
       SET state = ?, updated_at = ?
       WHERE id = ? AND state = 'in_flight' AND attempt_id = ? AND claim_expires_at <= ?`,
      "unknown",
      parsed.nowIso,
      current.row.id,
      parsed.attemptId,
      parsed.nowIso,
    );
    const settled = requireJobRecord(storage, current.row.id);
    if (settled.row.state !== "unknown") {
      return Schema.decodeSync(CompleteAttemptResult)({
        kind: "stale",
        job: toOutboundJob(settled),
      });
    }
    return Schema.decodeSync(CompleteAttemptResult)({
      kind: "applied",
      job: toOutboundJob(settled),
    });
  });
}

export function rejectReadyDispatch(
  storage: AccountSqliteStorage,
  input: RejectReadyDispatchInput,
): RejectReadyDispatchResult {
  const parsed = Schema.decodeSync(RejectReadyDispatchInput)(input);
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, parsed.jobId);
    if (current === null) {
      return Schema.decodeSync(RejectReadyDispatchResult)({ kind: "missing" });
    }
    if (current.row.state !== "ready") {
      return Schema.decodeSync(RejectReadyDispatchResult)({
        kind: "stale",
        job: toOutboundJob(current),
      });
    }
    rejectJob(storage, current.row.id, parsed.nowIso, "provider", parsed.failureDetail);
    const rejected = requireJobRecord(storage, current.row.id);
    if (rejected.row.state !== "rejected") {
      return Schema.decodeSync(RejectReadyDispatchResult)({
        kind: "stale",
        job: toOutboundJob(rejected),
      });
    }
    return Schema.decodeSync(RejectReadyDispatchResult)({
      kind: "rejected",
      job: toOutboundJob(rejected),
    });
  });
}

export function getOutboundDispatch(
  storage: AccountSqliteStorage,
  jobId: string,
): OutboundDispatch | null {
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, jobId);
    if (current === null) {
      return null;
    }
    const content = readDispatchContent(storage, current.row.message_id);
    if (content === null) {
      throw new AccountStoreUnexpectedError({
        cause: `Outbound job ${jobId} is missing message content`,
      });
    }
    const participants = loadDispatchParticipants(storage, current.row.message_id);
    return Schema.decodeSync(OutboundDispatch)({
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
        loadDispatchReferences(storage, current.row.message_id),
      ),
      notification: readLiveNotification(storage, current.row.id),
    });
  });
}

export function listSendWork(
  storage: AccountSqliteStorage,
  input: ListSendWorkInput,
): ListSendWorkPage {
  const parsed = Schema.decodeSync(ListSendWorkInput)(input);
  const limit = pageLimit(parsed.limit);
  return storage.transactionSync(() => {
    const rows =
      parsed.kind === "ready"
        ? listReadySendRows(storage, parsed.cursor, limit)
        : listExpiredInFlightRows(storage, parsed.nowIso, parsed.cursor, limit);
    return toSendWorkPage(rows, limit);
  });
}

export function listDuePendingApprovals(
  storage: AccountSqliteStorage,
  input: ListDueApprovalsInput,
): ListDueApprovalsPage {
  const parsed = Schema.decodeSync(ListDueApprovalsInput)(input);
  const limit = pageLimit(parsed.limit);
  return storage.transactionSync(() => {
    const rows = Schema.decodeUnknownSync(Schema.Array(ApprovalRequestRow))(
      storage.sql
        .exec(
          `SELECT id, job_id, token_hash, state, requester_client_id, requester_label,
                  created_at, resolved_at, expires_at
           FROM approval_requests
           WHERE state = 'pending' AND expires_at <= ?
           ORDER BY expires_at ASC, id ASC
           LIMIT ?`,
          parsed.nowIso,
          limit + 1,
        )
        .toArray(),
    );
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? { expiresAt: last.expires_at, approvalId: last.id }
        : null;
    return Schema.decodeSync(ListDueApprovalsPage)({
      items: pageRows.map(toStoredApproval),
      nextCursor,
    });
  });
}

export function listPurgeableNotifications(
  storage: AccountSqliteStorage,
  input: ListPurgeableNotificationsInput,
): ListPurgeableNotificationsPage {
  const parsed = Schema.decodeSync(ListPurgeableNotificationsInput)(input);
  const limit = pageLimit(parsed.limit);
  return storage.transactionSync(() => {
    const rows = Schema.decodeUnknownSync(Schema.Array(NotificationWorkRow))(
      storage.sql
        .exec(
          `SELECT n.id AS id,
                  n.approval_id AS approval_id,
                  n.job_id AS job_id,
                  n.key_version AS key_version,
                  n.nonce AS nonce,
                  n.ciphertext AS ciphertext,
                  n.expires_at AS expires_at,
                  n.created_at AS created_at,
                  n.purged_at AS purged_at
           FROM approval_notifications n
           JOIN approval_requests a ON a.id = n.approval_id
           WHERE n.purged_at IS NULL
             AND (n.expires_at <= ? OR a.state IN ('approved', 'denied', 'expired', 'cancelled'))
           ORDER BY n.created_at ASC, n.id ASC
           LIMIT ?`,
          parsed.nowIso,
          limit + 1,
        )
        .toArray(),
    );
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? { createdAt: last.created_at, notificationId: last.id }
        : null;
    return Schema.decodeSync(ListPurgeableNotificationsPage)({
      items: pageRows.map(toStoredNotification),
      nextCursor,
    });
  });
}

export function purgeNotificationCiphertext(
  storage: AccountSqliteStorage,
  input: PurgeNotificationCiphertextInput,
): PurgeNotificationCiphertextResult {
  const parsed = Schema.decodeSync(PurgeNotificationCiphertextInput)(input);
  return storage.transactionSync(() => {
    const current = readNotificationRow(storage, parsed.notificationId);
    if (current === null) {
      return Schema.decodeSync(PurgeNotificationCiphertextResult)({ kind: "missing" });
    }
    if (current.purged_at !== null) {
      return Schema.decodeSync(PurgeNotificationCiphertextResult)({
        kind: "already_purged",
        notificationId: current.id,
      });
    }
    storage.sql.exec(
      `UPDATE approval_notifications
       SET ciphertext = ?, nonce = ?, purged_at = ?
       WHERE id = ? AND purged_at IS NULL`,
      "",
      "",
      parsed.nowIso,
      parsed.notificationId,
    );
    const updated = readNotificationRow(storage, parsed.notificationId);
    if (updated === null || updated.purged_at === null) {
      return Schema.decodeSync(PurgeNotificationCiphertextResult)({ kind: "missing" });
    }
    return Schema.decodeSync(PurgeNotificationCiphertextResult)({
      kind: "purged",
      notificationId: updated.id,
    });
  });
}

export function getOutboundJob(
  storage: AccountSqliteStorage,
  jobId: string,
  viewer: JobViewer,
): OutboundJob | null {
  const parsedViewer = Schema.decodeSync(JobViewer)(viewer);
  return storage.transactionSync(() => {
    const current = readJobRecord(storage, jobId);
    if (
      current === null ||
      !viewerCanSee(parsedViewer, current.row.requester_kind, current.row.requester_client_id)
    ) {
      return null;
    }
    return toOutboundJob(current);
  });
}

export function listOutboundJobs(
  storage: AccountSqliteStorage,
  input: ListOutboundJobsQuery,
): OutboundJobPage {
  const query = Schema.decodeSync(ListOutboundJobsQuery)(input);
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
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.jobId);
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
    const nextCursor =
      rows.length > limit && last !== undefined
        ? Schema.decodeSync(JobListCursor)({
            createdAt: last.created_at,
            jobId: last.id,
          })
        : null;
    return Schema.decodeSync(OutboundJobPage)({
      items: pageRows.map((row) => toOutboundJob({ row })),
      nextCursor,
    });
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
  const approvalId = crypto.randomUUID();
  storage.sql.exec(
    `INSERT INTO approval_requests (
       id, job_id, token_hash, state, requester_client_id, requester_label,
       created_at, resolved_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    approvalId,
    messageJobId,
    approval.tokenHash,
    "pending",
    requester.clientId,
    requester.label,
    nowIso,
    null,
    approval.expiresAt,
  );
  storage.sql.exec(
    `INSERT INTO approval_notifications (
       id, approval_id, job_id, key_version, nonce, ciphertext, expires_at, created_at, purged_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    approvalId,
    notificationJobId,
    approval.notification.keyVersion,
    approval.notification.nonce,
    approval.notification.ciphertext,
    approval.expiresAt,
    nowIso,
    null,
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

function convergePendingApproval(
  storage: AccountSqliteStorage,
  approvalId: string,
  nowIso: string,
  state: "expired" | "cancelled",
  requireDue: boolean,
  failureClass: "expired" | "cancelled" | "notification_failed" = state,
): ApprovalConvergenceResult {
  const approval = readApprovalById(storage, approvalId);
  if (approval === null) {
    return Schema.decodeSync(ApprovalConvergenceResult)({ kind: "missing" });
  }
  if (approval.state !== "pending") {
    const job = readJobRecord(storage, approval.jobId);
    return Schema.decodeSync(ApprovalConvergenceResult)({
      kind: "resolved",
      state: approval.state,
      job: job === null ? null : toOutboundJob(job),
    });
  }
  if (requireDue && approval.expiresAt > nowIso) {
    return Schema.decodeSync(ApprovalConvergenceResult)({ kind: "pending" });
  }
  storage.sql.exec(
    `UPDATE approval_requests
     SET state = ?, resolved_at = ?
     WHERE id = ? AND state = 'pending'`,
    state,
    nowIso,
    approvalId,
  );
  const updated = requireApprovalById(storage, approvalId);
  if (updated.state !== state) {
    const job = readJobRecord(storage, approval.jobId);
    if (updated.state === "pending") {
      return Schema.decodeSync(ApprovalConvergenceResult)({ kind: "pending" });
    }
    return Schema.decodeSync(ApprovalConvergenceResult)({
      kind: "resolved",
      state: updated.state,
      job: job === null ? null : toOutboundJob(job),
    });
  }
  rejectJob(storage, approval.jobId, nowIso, failureClass, null);
  return Schema.decodeSync(ApprovalConvergenceResult)({
    kind: "transitioned",
    state,
    job: toOutboundJob(requireJobRecord(storage, approval.jobId)),
  });
}

function resolvedDecision(
  storage: AccountSqliteStorage,
  approval: StoredApproval,
): ApprovalDecisionResult {
  if (approval.state === "pending") {
    return Schema.decodeSync(ApprovalDecisionResult)({
      kind: "unavailable",
      state: "pending",
    });
  }
  const job = readJobRecord(storage, approval.jobId);
  return Schema.decodeSync(ApprovalDecisionResult)({
    kind: "resolved",
    state: approval.state,
    job: job === null ? null : toOutboundJob(job),
  });
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
    return { state: "active", policy: operatorPolicy };
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

function loadJobRecipients(
  storage: AccountSqliteStorage,
  messageId: string,
): ReadonlyArray<AccountMailContact> {
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        address: Schema.String,
        display_name: Schema.NullOr(Schema.String),
      }),
    ),
  )(
    storage.sql
      .exec(
        `SELECT address, display_name
         FROM message_participants
         WHERE message_id = ? AND role IN ('to', 'cc')
         ORDER BY role, position`,
        messageId,
      )
      .toArray(),
  );
  return rows.map((row) =>
    Schema.decodeSync(AccountMailContact)({
      address: row.address,
      displayName: row.display_name,
    }),
  );
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

type JobRecord = {
  readonly row: OutboundJobRow;
};

function readJobByRequesterKey(
  storage: AccountSqliteStorage,
  requesterKind: OutboundRequester["kind"],
  requesterClientId: string,
  requestId: string,
): JobRecord | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(OutboundJobRow),
    storage.sql
      .exec(
        `SELECT ${JOB_SELECT}
         FROM outbound_jobs j
         JOIN messages m ON m.id = j.message_id
         WHERE j.requester_kind = ?
           AND j.requester_client_id = ?
           AND j.idempotency_key = ?`,
        requesterKind,
        requesterClientId,
        requestId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return { row };
}

function readJobRecord(storage: AccountSqliteStorage, jobId: string): JobRecord | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(OutboundJobRow),
    storage.sql
      .exec(
        `SELECT ${JOB_SELECT}
         FROM outbound_jobs j
         JOIN messages m ON m.id = j.message_id
         WHERE j.id = ?`,
        jobId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return { row };
}

function requireJobRecord(storage: AccountSqliteStorage, jobId: string): JobRecord {
  const job = readJobRecord(storage, jobId);
  if (job === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing outbound job ${jobId}`,
    });
  }
  return job;
}

function readApprovalByTokenHash(
  storage: AccountSqliteStorage,
  tokenHash: ApprovalTokenHash,
): StoredApproval | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(ApprovalRequestRow),
    storage.sql
      .exec(
        `SELECT id, job_id, token_hash, state, requester_client_id, requester_label,
                created_at, resolved_at, expires_at
         FROM approval_requests
         WHERE token_hash = ?`,
        tokenHash,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toStoredApproval(row);
}

function readApprovalById(
  storage: AccountSqliteStorage,
  approvalId: string,
): StoredApproval | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(ApprovalRequestRow),
    storage.sql
      .exec(
        `SELECT id, job_id, token_hash, state, requester_client_id, requester_label,
                created_at, resolved_at, expires_at
         FROM approval_requests
         WHERE id = ?`,
        approvalId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toStoredApproval(row);
}

function requireApprovalById(storage: AccountSqliteStorage, approvalId: string): StoredApproval {
  const approval = readApprovalById(storage, approvalId);
  if (approval === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing approval ${approvalId}`,
    });
  }
  return approval;
}

function readApprovalForJob(storage: AccountSqliteStorage, jobId: string): StoredApproval | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(ApprovalRequestRow),
    storage.sql
      .exec(
        `SELECT id, job_id, token_hash, state, requester_client_id, requester_label,
                created_at, resolved_at, expires_at
         FROM approval_requests
         WHERE job_id = ?`,
        jobId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toStoredApproval(row);
}

function toStoredApproval(row: ApprovalRequestRow): StoredApproval {
  return Schema.decodeSync(StoredApproval)({
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
  });
}

function toOutboundJob(record: JobRecord): OutboundJob {
  const nodeId = record.row.node_id;
  if (nodeId === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Outbound job ${record.row.id} is missing a thread node`,
    });
  }
  const threadHandle = nodeThreadHandle(nodeId);
  if (threadHandle === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Thread node id ${nodeId} is not a UUID`,
    });
  }
  return Schema.decodeSync(OutboundJob)({
    jobId: record.row.id,
    requestId: record.row.idempotency_key,
    requester: requesterFromRow(record.row),
    messageId: record.row.message_id,
    threadHandle,
    mailboxId: record.row.mailbox_id,
    purpose: record.row.purpose,
    state: record.row.state,
    attemptId: record.row.attempt_id,
    providerMessageId: record.row.provider_message_id,
    rfcMessageId: record.row.rfc_message_id,
    failureClass: record.row.failure_class,
    failureDetail: record.row.failure_detail,
    createdAt: record.row.created_at,
    updatedAt: record.row.updated_at,
  });
}

function requesterFromRow(row: OutboundJobRow): OutboundRequester {
  return Schema.decodeSync(OutboundRequester)({
    kind: row.requester_kind,
    clientId: row.requester_client_id,
    label: row.requester_label,
  });
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

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return QUERY_PAGE_DEFAULT;
  }
  if (limit < 1) {
    return 1;
  }
  if (limit > QUERY_PAGE_MAX) {
    return QUERY_PAGE_MAX;
  }
  return limit;
}

const DispatchContentRow = Schema.Struct({
  subject: Schema.NullOr(Schema.String),
  text_body: Schema.NullOr(Schema.String),
  html_body: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  in_reply_to_rfc_message_id: Schema.NullOr(Schema.String),
});

const DispatchParticipantRow = Schema.Struct({
  role: Schema.Literals(["from", "reply_to", "to", "cc"]),
  address: Schema.String,
  display_name: Schema.NullOr(Schema.String),
});

const NotificationWorkRow = Schema.Struct({
  id: Schema.String,
  approval_id: Schema.String,
  job_id: Schema.String,
  key_version: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
  purged_at: Schema.NullOr(Schema.String),
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

type DispatchParticipants = {
  readonly from: ReadonlyArray<AccountMailContact>;
  readonly replyTo: ReadonlyArray<AccountMailContact>;
  readonly to: ReadonlyArray<AccountMailContact>;
  readonly cc: ReadonlyArray<AccountMailContact>;
};

function loadDispatchParticipants(
  storage: AccountSqliteStorage,
  messageId: string,
): DispatchParticipants {
  const rows = Schema.decodeUnknownSync(Schema.Array(DispatchParticipantRow))(
    storage.sql
      .exec(
        `SELECT role, address, display_name
         FROM message_participants
         WHERE message_id = ?
         ORDER BY role, position`,
        messageId,
      )
      .toArray(),
  );
  const from: Array<AccountMailContact> = [];
  const replyTo: Array<AccountMailContact> = [];
  const to: Array<AccountMailContact> = [];
  const cc: Array<AccountMailContact> = [];
  for (const row of rows) {
    const contact = Schema.decodeSync(AccountMailContact)({
      address: row.address,
      displayName: row.display_name,
    });
    if (row.role === "from") {
      from.push(contact);
    } else if (row.role === "reply_to") {
      replyTo.push(contact);
    } else if (row.role === "to") {
      to.push(contact);
    } else {
      cc.push(contact);
    }
  }
  return { from, replyTo, to, cc } satisfies DispatchParticipants;
}

function loadDispatchReferences(
  storage: AccountSqliteStorage,
  messageId: string,
): ReadonlyArray<string> {
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        rfc_message_id: Schema.String,
      }),
    ),
  )(
    storage.sql
      .exec(
        `SELECT rfc_message_id
         FROM message_references
         WHERE message_id = ?
         ORDER BY position`,
        messageId,
      )
      .toArray(),
  );
  return rows.map((row) => row.rfc_message_id);
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

function readLiveNotification(
  storage: AccountSqliteStorage,
  jobId: string,
): StoredNotificationCiphertext | null {
  const row = readNotificationByJobId(storage, jobId);
  if (row === null || row.purged_at !== null || row.ciphertext.length === 0) {
    return null;
  }
  return toStoredNotification(row);
}

function readNotificationByJobId(
  storage: AccountSqliteStorage,
  jobId: string,
): typeof NotificationWorkRow.Type | null {
  return (
    firstDecoded(
      Schema.decodeUnknownSync(NotificationWorkRow),
      storage.sql
        .exec(
          `SELECT id, approval_id, job_id, key_version, nonce, ciphertext, expires_at, created_at, purged_at
           FROM approval_notifications
           WHERE job_id = ?`,
          jobId,
        )
        .toArray(),
    ) ?? null
  );
}

function readNotificationRow(
  storage: AccountSqliteStorage,
  notificationId: string,
): typeof NotificationWorkRow.Type | null {
  return (
    firstDecoded(
      Schema.decodeUnknownSync(NotificationWorkRow),
      storage.sql
        .exec(
          `SELECT id, approval_id, job_id, key_version, nonce, ciphertext, expires_at, created_at, purged_at
           FROM approval_notifications
           WHERE id = ?`,
          notificationId,
        )
        .toArray(),
    ) ?? null
  );
}

function toStoredNotification(row: typeof NotificationWorkRow.Type): StoredNotificationCiphertext {
  return Schema.decodeSync(StoredNotificationCiphertext)({
    id: row.id,
    approvalId: row.approval_id,
    jobId: row.job_id,
    keyVersion: row.key_version,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    expiresAt: row.expires_at,
    purgedAt: row.purged_at,
  });
}

function listReadySendRows(
  storage: AccountSqliteStorage,
  cursor: JobListCursor | undefined,
  limit: number,
): ReadonlyArray<AccountSqlRow> {
  if (cursor === undefined) {
    return storage.sql
      .exec(
        `SELECT ${JOB_SELECT}
         FROM outbound_jobs j
         JOIN messages m ON m.id = j.message_id
         WHERE j.state = ?
         ORDER BY j.created_at ASC, j.id ASC
         LIMIT ?`,
        "ready",
        limit + 1,
      )
      .toArray();
  }
  return storage.sql
    .exec(
      `SELECT ${JOB_SELECT}
       FROM outbound_jobs j
       JOIN messages m ON m.id = j.message_id
       WHERE j.state = ?
         AND (j.created_at > ? OR (j.created_at = ? AND j.id > ?))
       ORDER BY j.created_at ASC, j.id ASC
       LIMIT ?`,
      "ready",
      cursor.createdAt,
      cursor.createdAt,
      cursor.jobId,
      limit + 1,
    )
    .toArray();
}

function listExpiredInFlightRows(
  storage: AccountSqliteStorage,
  nowIso: string,
  cursor: JobListCursor | undefined,
  limit: number,
): ReadonlyArray<AccountSqlRow> {
  if (cursor === undefined) {
    return storage.sql
      .exec(
        `SELECT ${JOB_SELECT}
         FROM outbound_jobs j
         JOIN messages m ON m.id = j.message_id
         WHERE j.state = ?
           AND j.claim_expires_at IS NOT NULL
           AND j.claim_expires_at <= ?
         ORDER BY j.created_at ASC, j.id ASC
         LIMIT ?`,
        "in_flight",
        nowIso,
        limit + 1,
      )
      .toArray();
  }
  return storage.sql
    .exec(
      `SELECT ${JOB_SELECT}
       FROM outbound_jobs j
       JOIN messages m ON m.id = j.message_id
       WHERE j.state = ?
         AND j.claim_expires_at IS NOT NULL
         AND j.claim_expires_at <= ?
         AND (j.created_at > ? OR (j.created_at = ? AND j.id > ?))
       ORDER BY j.created_at ASC, j.id ASC
       LIMIT ?`,
      "in_flight",
      nowIso,
      cursor.createdAt,
      cursor.createdAt,
      cursor.jobId,
      limit + 1,
    )
    .toArray();
}

function toSendWorkPage(rows: ReadonlyArray<AccountSqlRow>, limit: number): ListSendWorkPage {
  const decoded = Schema.decodeUnknownSync(Schema.Array(OutboundJobRow))(rows);
  const pageRows = decoded.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    decoded.length > limit && last !== undefined
      ? Schema.decodeSync(JobListCursor)({
          createdAt: last.created_at,
          jobId: last.id,
        })
      : null;
  return Schema.decodeSync(ListSendWorkPage)({
    items: pageRows.map((row) => toOutboundJob({ row })),
    nextCursor,
  });
}
