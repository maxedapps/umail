import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { dispatchJob, type DispatchPorts } from "../mail/dispatch.ts";
import type { IndexReceiptWork } from "../mail/process-index.ts";
import { redriveDueInboundReceipts } from "./commands.ts";
import { expireDueApprovals, readyJobIds, settleAbandonedClaims } from "./jobs.ts";
import type { AccountSqliteStorage } from "./sqlite.ts";

// The store's single alarm; the Durable Object storage provides it.
export interface AccountAlarm {
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type AccountStorage = AccountSqliteStorage & AccountAlarm;

export type DueWorkPorts<R> = DispatchPorts & {
  readonly index: { send(body: IndexReceiptWork): Effect.Effect<void, Error, R> };
};

const SEND_BATCH_SIZE = 10;
const REDRIVE_BATCH_SIZE = 50;
export const FAILED_STEP_RETRY_MS = 60_000;

// One value per kind of due work.
type DueWork<A> = {
  readonly approvals: A;
  readonly ready: A;
  readonly claims: A;
  readonly receipts: A;
};

// One pass over everything the store has due: expire approvals, send ready jobs, settle abandoned
// claims, and redrive stuck receipts. The steps are independent and never fail the pass; the
// alarm is then set for the earliest remaining work.
export const runDueWork = <R>(
  storage: AccountStorage,
  ports: DueWorkPorts<R>,
  nowMs: number,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const failed = {
      approvals: yield* attempt(
        { step: "expire" },
        Effect.sync(() => expireDueApprovals(storage, nowIso)),
      ),
      ready: yield* sendReadyJobs(storage, ports, nowMs),
      claims: yield* attempt(
        { step: "settle" },
        Effect.sync(() => settleAbandonedClaims(storage, nowIso)),
      ),
      receipts: yield* attempt(
        { step: "redrive" },
        Effect.gen(function* () {
          const receiptIds = yield* Effect.sync(() =>
            redriveDueInboundReceipts(storage, { nowIso, limit: REDRIVE_BATCH_SIZE }),
          );
          for (const receiptId of receiptIds) {
            yield* ports.index.send({ version: 1, receiptId });
          }
        }),
      ),
    } satisfies DueWork<boolean>;
    yield* Effect.promise(() => armDueWork(storage, nowMs, failed));
  });

// Sets the alarm to the earliest due work, or clears it. Due times come from committed state and the
// alarm is set in the same synchronous turn, so the last caller always wins with fresh state. A
// failed step waits at least FAILED_STEP_RETRY_MS, so stuck work cannot spin the alarm.
export function armDueWork(
  storage: AccountStorage,
  nowMs: number,
  failed?: DueWork<boolean>,
): Promise<void> {
  const due = dueTimes(storage);
  let next: number | null = null;
  for (const source of ["approvals", "ready", "claims", "receipts"] as const) {
    const at = due[source];
    if (at === null) continue;
    const floored = failed?.[source] === true ? Math.max(at, nowMs + FAILED_STEP_RETRY_MS) : at;
    next = next === null ? floored : Math.min(next, floored);
  }
  return next === null ? storage.deleteAlarm() : storage.setAlarm(Math.max(next, nowMs));
}

// A failing job counts as the whole step failing.
function sendReadyJobs<R>(
  storage: AccountStorage,
  ports: DueWorkPorts<R>,
  nowMs: number,
): Effect.Effect<boolean> {
  return Effect.suspend(() =>
    Effect.forEach(readyJobIds(storage, SEND_BATCH_SIZE), (jobId) =>
      attempt({ step: "send", jobId }, dispatchJob(storage, jobId, ports, nowMs)),
    ),
  ).pipe(
    Effect.map((failures) => failures.includes(true)),
    Effect.catchCause((cause) => logFailure({ step: "send" }, cause)),
  );
}

// Runs one piece of due work and reports whether it failed; the failure is logged, never raised.
function attempt<E, R>(
  annotations: Record<string, string>,
  work: Effect.Effect<unknown, E, R>,
): Effect.Effect<boolean, never, R> {
  return work.pipe(
    Effect.as(false),
    Effect.catchCause((cause) => logFailure(annotations, cause)),
  );
}

function logFailure(
  annotations: Record<string, string>,
  cause: Cause.Cause<unknown>,
): Effect.Effect<true> {
  return Effect.logError("Due work failed", cause).pipe(
    Effect.annotateLogs(annotations),
    Effect.as(true as const),
  );
}

const DueTimesRow = Schema.Struct({
  approvals: Schema.NullOr(Schema.String),
  ready: Schema.NullOr(Schema.String),
  claims: Schema.NullOr(Schema.String),
  receipts: Schema.NullOr(Schema.String),
});

// When each kind of work is next due, in epoch milliseconds. A ready job is due at once.
function dueTimes(storage: AccountSqliteStorage): DueWork<number | null> {
  const [row] = Schema.decodeUnknownSync(Schema.Tuple([DueTimesRow]))(
    storage.sql
      .exec(
        `SELECT
           (SELECT MIN(expires_at) FROM approval_requests WHERE state = 'pending') AS approvals,
           (SELECT MIN(created_at) FROM outbound_jobs WHERE state = 'ready') AS ready,
           (SELECT MIN(claim_expires_at) FROM outbound_jobs WHERE state = 'in_flight') AS claims,
           (SELECT MIN(retry_after) FROM inbound_receipts WHERE work_state = 'ready') AS receipts`,
      )
      .toArray(),
  );
  const at = (iso: string | null) => (iso === null ? null : Date.parse(iso));
  return {
    approvals: at(row.approvals),
    ready: at(row.ready),
    claims: at(row.claims),
    receipts: at(row.receipts),
  };
}
