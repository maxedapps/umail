import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { make } from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { setTimeout as wait } from "node:timers/promises";
import { expect } from "vitest";

import { Api } from "../apps/server/src/api/worker.ts";
import IndexConsumerLive, { IndexConsumer } from "../apps/server/src/mail/indexing.ts";
import {
  MAIL_CAPACITY_LARGE_SEQUENCE_FIXTURES,
  MAIL_CAPACITY_REJECTED_FIXTURES,
  MAIL_CAPACITY_SUPPORTED_FIXTURES,
  MAIL_CAPACITY_INBOUND_REJECTED_FIXTURES,
  recoveryProbeFixture,
  retryProbeFixture,
  type MailCapacityFixture,
  type MailCapacityInboundRejectedFixture,
  type MailCapacityIndexedExpectation,
} from "../apps/server/test/mail/mail-capacity-fixtures.ts";
import { MailArchive } from "../apps/server/src/mail/archive.ts";
import { MailIndex, MailIndexDlq } from "../apps/server/src/mail/indexing.ts";
import { ProvisionedOperator } from "../apps/server/src/auth/auth-control.ts";
import { mailCapacityEnvironment } from "../vitest.mail-capacity.config.ts";
import {
  createCloudflareCapacityClient,
  type QueueMetrics,
  type WorkerInvocation,
} from "./mail-capacity-cloudflare.ts";
import CapacityApiLive, {
  CapacityEmptyResponse,
  CapacityErrorResponse,
  CapacitySeedResponse,
  CapacityStatusResponse,
} from "./mail-capacity-host.ts";

const CAPACITY_STAGE = `mail-capacity-${mailCapacityEnvironment.runId}`;
const CAPACITY_OPERATOR_ID = `capacity-${mailCapacityEnvironment.runId}`;
const LIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const RECEIPT_TIMEOUT_MS = 12 * 60 * 1_000;
const TELEMETRY_TIMEOUT_MS = 10 * 60 * 1_000;
const DRAIN_TIMEOUT_MS = 5 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;

const MailCapacityStack = Alchemy.Stack(
  "uMailMailCapacity",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const archive = yield* MailArchive;
    const indexQueue = yield* MailIndex;
    const indexDlq = yield* MailIndexDlq;
    return yield* Effect.gen(function* () {
      const host = yield* Api;
      const indexWorker = yield* IndexConsumer;
      return {
        archive,
        host,
        indexQueue,
        indexDlq,
        indexWorker,
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(CapacityApiLive, IndexConsumerLive).pipe(
          Layer.provide(
            Layer.succeed(ProvisionedOperator, {
              operatorId: CAPACITY_OPERATOR_ID,
              generation: 1,
              schemaRevision: "mail-capacity-v1",
            }),
          ),
        ),
      ),
    );
  }),
);

const cloudflare = createCloudflareCapacityClient({
  accountId: mailCapacityEnvironment.accountId,
  apiToken: mailCapacityEnvironment.apiToken,
});

const { test, beforeAll, deploy, destroy } = make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: CAPACITY_STAGE,
  dev: false,
});

const deployed = beforeAll(deploy(MailCapacityStack), { timeout: LIVE_TIMEOUT_MS });

test(
  mailCapacityEnvironment.cleanupOnly
    ? "reconciles and removes the named preserved capacity stack"
    : "indexes the bounded corpus through the real queue Worker and reaches a clean drain",
  Effect.gen(function* () {
    const output = yield* deployed;
    const hostUrl = requireCapacityHostUrl(output.host.url);
    if (!mailCapacityEnvironment.cleanupOnly) {
      yield* Effect.promise(() => runLiveCapacityCorpus(hostUrl, output));
    }
    yield* cleanupCapacityStack(hostUrl, output);
  }),
  { timeout: LIVE_TIMEOUT_MS },
);

function cleanupCapacityStack(hostUrl: string, output: MailCapacityStackOutput) {
  return Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await waitForQueueDrain(output.indexQueue.queueId, output.indexDlq.queueId);
      const emptied = await postCapacityControl(hostUrl, "/empty", CapacityEmptyResponse);
      expect(emptied.remaining).toBe(0);
      const remainingMetrics = await Promise.all([
        cloudflare.getQueueMetrics(output.indexQueue.queueId),
        cloudflare.getQueueMetrics(output.indexDlq.queueId),
      ]);
      expect(remainingMetrics.every(queueIsEmpty)).toBe(true);
    });
    yield* destroy(MailCapacityStack);
    yield* Effect.promise(async () => {
      await cloudflare.deleteRetainedBucket(output.archive.bucketName, output.archive.jurisdiction);
      const [archiveExists, indexExists, dlqExists, hostExists, workerExists] = await Promise.all([
        cloudflare.bucketExists(output.archive.bucketName, output.archive.jurisdiction),
        cloudflare.queueExists(output.indexQueue.queueId),
        cloudflare.queueExists(output.indexDlq.queueId),
        cloudflare.workerExists(output.host.workerName),
        cloudflare.workerExists(output.indexWorker.workerName),
      ]);
      expect({ archiveExists, indexExists, dlqExists, hostExists, workerExists }).toEqual({
        archiveExists: false,
        indexExists: false,
        dlqExists: false,
        hostExists: false,
        workerExists: false,
      });
    });
  });
}

type MailCapacityStackOutput = Effect.Success<typeof deployed>;

type SubmittedFixture = {
  readonly fixtureId: string;
  readonly receiptId: string;
  readonly expected: MailCapacityFixture["expected"];
};

async function runLiveCapacityCorpus(
  hostUrl: string,
  output: MailCapacityStackOutput,
): Promise<void> {
  expect(output.archive.accountId).toBe(mailCapacityEnvironment.accountId);
  expect(output.indexQueue.accountId).toBe(mailCapacityEnvironment.accountId);

  const consumers = await cloudflare.listQueueConsumers(output.indexQueue.queueId);
  expect(consumers).toHaveLength(1);
  expect(consumers[0]).toMatchObject({
    type: "worker",
    scriptName: output.indexWorker.workerName,
    deadLetterQueue: output.indexDlq.queueName,
    settings: {
      batchSize: 1,
      maxConcurrency: 1,
      maxRetries: 4,
    },
  });
  await expect(cloudflare.listQueueConsumers(output.indexDlq.queueId)).resolves.toEqual([]);

  const telemetryFrom = Date.now();
  let queuedMessageCount = 0;
  const retryFixture = retryProbeFixture();
  const retrySeed = await seedCapacityFixture(hostUrl, retryFixture, "?retry=1");
  queuedMessageCount += 1;
  const retryInvocations = await pollFor(
    "retry queue invocations",
    TELEMETRY_TIMEOUT_MS,
    async () => {
      const invocations = await queryIndexInvocations(output, telemetryFrom);
      return invocations.length >= 2 ? invocations : null;
    },
  );
  expect(retryInvocations).toHaveLength(2);
  await assertFixtureTerminal(hostUrl, {
    fixtureId: retryFixture.id,
    receiptId: retrySeed.receiptId,
    expected: retryFixture.expected,
  });

  const recoveryFixture = recoveryProbeFixture();
  const recoverySeed = await seedCapacityFixture(hostUrl, recoveryFixture, "?publish=0");
  const initialRecoveryStatus = await getCapacityStatus(hostUrl, recoverySeed.receiptId);
  expect(initialRecoveryStatus.receipt?.workState).toBe("ready");
  await postCapacityControl(hostUrl, "/recover", CapacityRecoveryResponse);
  queuedMessageCount += 1;

  const largeSequence: SubmittedFixture[] = [];
  for (const descriptor of MAIL_CAPACITY_LARGE_SEQUENCE_FIXTURES) {
    const fixture = descriptor.make();
    expect(fixture.raw.byteLength).toBe(20 * 1024 * 1024);
    const seed = await seedCapacityFixture(hostUrl, fixture);
    queuedMessageCount += 1;
    largeSequence.push({
      fixtureId: fixture.id,
      receiptId: seed.receiptId,
      expected: fixture.expected,
    });
  }
  await assertFixtureTerminal(hostUrl, {
    fixtureId: recoveryFixture.id,
    receiptId: recoverySeed.receiptId,
    expected: recoveryFixture.expected,
  });
  const recoveredStatus = await getCapacityStatus(hostUrl, recoverySeed.receiptId);
  expect(recoveredStatus.receipt?.attemptCount).toBe(1);
  for (const submitted of largeSequence) {
    await assertFixtureTerminal(hostUrl, submitted);
  }

  for (const descriptor of MAIL_CAPACITY_SUPPORTED_FIXTURES) {
    const fixture = descriptor.make();
    const seed = await seedCapacityFixture(hostUrl, fixture);
    queuedMessageCount += 1;
    await assertFixtureTerminal(hostUrl, {
      fixtureId: fixture.id,
      receiptId: seed.receiptId,
      expected: fixture.expected,
    });
  }

  for (const descriptor of MAIL_CAPACITY_REJECTED_FIXTURES) {
    const fixture = descriptor.make();
    const seed = await seedCapacityFixture(hostUrl, fixture);
    queuedMessageCount += 1;
    await assertFixtureTerminal(hostUrl, {
      fixtureId: fixture.id,
      receiptId: seed.receiptId,
      expected: fixture.expected,
    });
  }
  for (const descriptor of MAIL_CAPACITY_INBOUND_REJECTED_FIXTURES) {
    await assertCapacityInboundRejection(hostUrl, descriptor.make());
  }

  const drainStartedAt = Date.now();
  const drained = await waitForQueueDrain(output.indexQueue.queueId, output.indexDlq.queueId);
  const drainDurationMs = Date.now() - drainStartedAt;
  const expectedQueueInvocations = queuedMessageCount + 1;
  const invocations = await pollFor("complete index telemetry", TELEMETRY_TIMEOUT_MS, async () => {
    const observed = await queryIndexInvocations(output, telemetryFrom);
    return observed.length >= expectedQueueInvocations ? observed : null;
  });
  expect(invocations).toHaveLength(expectedQueueInvocations);
  expect(invocations.every((invocation) => invocation.outcome === "ok")).toBe(true);
  expect(invocations.some((invocation) => invocation.outcome === "exceededMemory")).toBe(false);

  const [hostDeployments, indexDeployments] = await Promise.all([
    cloudflare.listWorkerDeployments(output.host.workerName),
    cloudflare.listWorkerDeployments(output.indexWorker.workerName),
  ]);
  expect(hostDeployments.length).toBeGreaterThan(0);
  expect(indexDeployments.length).toBeGreaterThan(0);
  expect(hostDeployments[0]?.versions.length).toBeGreaterThan(0);
  expect(indexDeployments[0]?.versions.length).toBeGreaterThan(0);

  process.stdout.write(
    `${JSON.stringify({
      suite: "mail-capacity",
      stage: CAPACITY_STAGE,
      resources: {
        archive: output.archive.bucketName,
        hostWorker: output.host.workerName,
        indexWorker: output.indexWorker.workerName,
        indexQueue: output.indexQueue.queueName,
        indexDlq: output.indexDlq.queueName,
      },
      deployments: {
        host: hostDeployments[0],
        index: indexDeployments[0],
      },
      queue: {
        expectedInvocations: expectedQueueInvocations,
        observedInvocations: invocations.length,
        maximumCpuTimeMs: maximumInvocationCpu(invocations),
        drainDurationMs,
        index: drained.index,
        dlq: drained.dlq,
      },
    })}\n`,
  );
}

const CapacityRecoveryResponse = Schema.Struct({ recovered: Schema.Literal(true) });

async function seedCapacityFixture(hostUrl: string, fixture: MailCapacityFixture, query = "") {
  const response = await fetch(`${hostUrl}/seed${query}`, {
    method: "POST",
    headers: capacityHeaders({
      contentLength: String(fixture.raw.byteLength),
      contentType: "message/rfc822",
    }),
    body: fixture.raw,
  });
  return decodeCapacityResponse(response, 202, CapacitySeedResponse);
}

async function assertCapacityInboundRejection(
  hostUrl: string,
  fixture: MailCapacityInboundRejectedFixture,
): Promise<void> {
  const response = await fetch(`${hostUrl}/seed`, {
    method: "POST",
    headers: capacityHeaders({
      contentLength: String(fixture.raw.byteLength),
      contentType: "message/rfc822",
    }),
    body: fixture.raw,
  });
  const failure = await decodeCapacityResponse(response, 413, CapacityErrorResponse);
  expect(failure.error).toBe("body_too_large");
}

async function getCapacityStatus(hostUrl: string, receiptId: string) {
  const response = await fetch(`${hostUrl}/status/${encodeURIComponent(receiptId)}`, {
    headers: capacityHeaders(),
  });
  return decodeCapacityResponse(response, 200, CapacityStatusResponse);
}

async function postCapacityControl<S extends Schema.Decoder<unknown>>(
  hostUrl: string,
  path: string,
  schema: S,
): Promise<S["Type"]> {
  const response = await fetch(`${hostUrl}${path}`, {
    method: "POST",
    headers: capacityHeaders(),
  });
  return decodeCapacityResponse(response, path === "/empty" ? 200 : 202, schema);
}

async function decodeCapacityResponse<S extends Schema.Decoder<unknown>>(
  response: Response,
  expectedStatus: number,
  schema: S,
): Promise<S["Type"]> {
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(
      `Capacity host returned ${String(response.status)}; expected ${String(expectedStatus)}.`,
    );
  }
  return Schema.decodeUnknownPromise(schema)(await response.json());
}

function capacityHeaders(additional?: CapacityBodyHeaders): Headers {
  const headers = new Headers();
  if (additional !== undefined) {
    headers.set("content-length", additional.contentLength);
    headers.set("content-type", additional.contentType);
  }
  headers.set("authorization", `Bearer ${mailCapacityEnvironment.controlToken}`);
  return headers;
}

type CapacityBodyHeaders = {
  readonly contentLength: string;
  readonly contentType: string;
};

async function assertFixtureTerminal(hostUrl: string, submitted: SubmittedFixture): Promise<void> {
  const status = await pollFor(
    `terminal receipt ${submitted.fixtureId}`,
    RECEIPT_TIMEOUT_MS,
    async () => {
      const observed = await getCapacityStatus(hostUrl, submitted.receiptId);
      const state = observed.receipt?.workState;
      return state === "indexed" || state === "policy_failed" || state === "terminal"
        ? observed
        : null;
    },
  );
  const receipt = status.receipt;
  const manifest = status.manifest;
  if (receipt === null || manifest === null) {
    throw new Error(`Capacity fixture ${submitted.fixtureId} lost receipt persistence.`);
  }
  expect(receipt.receiptId).toBe(submitted.receiptId);
  expect(receipt.claimedUntil).toBeNull();
  expect(manifest.receiptId).toBe(submitted.receiptId);

  if (submitted.expected.kind === "policy_failed") {
    expect(receipt.workState).toBe("policy_failed");
    expect(receipt.policyError).toBe(submitted.expected.reason);
    expect(receipt.lastError).toBe(submitted.expected.reason);
    expect(manifest.policyFailure).toBe(submitted.expected.reason);
    expect(status.summary).toBeNull();
    expect(status.body).toBeNull();
    expect(status.attachments).toEqual([]);
    expect(status.derivedObjects).toEqual([]);
    return;
  }
  expect(receipt.workState).toBe("indexed");
  expect(receipt.policyError).toBeNull();
  expect(receipt.lastError).toBeNull();
  expect(manifest.policyFailure).toBeUndefined();
  assertIndexedFixture(status, submitted.expected, submitted.fixtureId);
}

function assertIndexedFixture(
  status: CapacityStatusResponse,
  expected: MailCapacityIndexedExpectation,
  fixtureId: string,
): void {
  const summary = status.summary;
  const body = status.body;
  if (summary === null || body === null) {
    throw new Error(`Capacity fixture ${fixtureId} did not persist message content.`);
  }
  expect(summary.direction).toBe("inbound");
  expect(summary.subject).toBe(expected.subject);
  expect(summary.hasRemoteImages).toBe(expected.hasRemoteImages);
  expect(body.hasRemoteImages).toBe(expected.hasRemoteImages);
  assertNullableContent(body.textBody, expected.textIncludes);
  assertNullableContent(body.htmlBody, expected.htmlIncludes);
  expect(status.attachments).toHaveLength(expected.attachments.length);
  expect(status.derivedObjects).toHaveLength(expected.attachments.length);
  for (const attachment of expected.attachments) {
    const stored = status.attachments.find(
      (candidate) => candidate.stored.meta.filename === attachment.filename,
    );
    if (stored === undefined) {
      throw new Error(`Capacity fixture ${fixtureId} lost ${attachment.filename}.`);
    }
    expect(stored.stored.meta.mimeType).toBe(attachment.mimeType);
    expect(stored.stored.meta.size).toBe(attachment.byteLength);
    expect(stored.object.size).toBe(attachment.byteLength);
    expect(stored.object.sha256).toBe(attachment.sha256);
  }
}

function assertNullableContent(actual: string | null, included: string | null): void {
  if (included === null) {
    expect(actual).toBeNull();
  } else {
    expect(actual).toContain(included);
  }
}

async function queryIndexInvocations(
  output: MailCapacityStackOutput,
  fromEpochMs: number,
): Promise<ReadonlyArray<WorkerInvocation>> {
  return cloudflare.queryWorkerInvocations({
    scriptName: output.indexWorker.workerName,
    fromEpochMs,
    toEpochMs: Date.now(),
  });
}

type DrainedQueues = {
  readonly index: QueueMetrics;
  readonly dlq: QueueMetrics;
};

async function waitForQueueDrain(indexQueueId: string, dlqQueueId: string): Promise<DrainedQueues> {
  let consecutiveEmptyObservations = 0;
  return pollFor("two consecutive empty queue observations", DRAIN_TIMEOUT_MS, async () => {
    const [index, dlq] = await Promise.all([
      cloudflare.getQueueMetrics(indexQueueId),
      cloudflare.getQueueMetrics(dlqQueueId),
    ]);
    consecutiveEmptyObservations =
      queueIsEmpty(index) && queueIsEmpty(dlq) ? consecutiveEmptyObservations + 1 : 0;
    return consecutiveEmptyObservations >= 2 ? { index, dlq } : null;
  });
}

function queueIsEmpty(metrics: QueueMetrics): boolean {
  return metrics.backlog_count === 0 && metrics.backlog_bytes === 0;
}

async function pollFor<A>(
  description: string,
  timeoutMs: number,
  observe: () => Promise<A | null>,
): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== null) return observed;
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function requireCapacityHostUrl(url: string | undefined): string {
  if (url === undefined) {
    throw new Error("Capacity host did not receive a workers.dev URL.");
  }
  return url.replace(/\/$/, "");
}

function maximumInvocationCpu(invocations: ReadonlyArray<WorkerInvocation>): number {
  return invocations.reduce((maximum, invocation) => Math.max(maximum, invocation.cpuTimeMs), 0);
}
