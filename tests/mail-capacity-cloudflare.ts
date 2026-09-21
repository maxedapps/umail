import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

const CloudflareSuccess = Schema.Struct({
  success: Schema.Literal(true),
});

const QueueConsumerFields = {
  consumer_id: Schema.String,
  type: Schema.Literal("worker"),
  dead_letter_queue: Schema.String,
  settings: Schema.Struct({
    batch_size: Schema.Finite,
    max_concurrency: Schema.Finite,
    max_retries: Schema.Finite,
  }),
} as const;

const QueueConsumerScriptWire = Schema.Struct({
  ...QueueConsumerFields,
  script: Schema.String,
});

const QueueConsumerScriptNameWire = Schema.Struct({
  ...QueueConsumerFields,
  script_name: Schema.String,
});

const QueueConsumerWire = Schema.Union([QueueConsumerScriptWire, QueueConsumerScriptNameWire]);
type QueueConsumerWire = typeof QueueConsumerWire.Type;

export type QueueConsumer = {
  readonly consumerId: string;
  readonly type: "worker";
  readonly scriptName: string;
  readonly deadLetterQueue: string;
  readonly settings: {
    readonly batchSize: number;
    readonly maxConcurrency: number;
    readonly maxRetries: number;
  };
};

const QueueConsumersResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: Schema.Array(QueueConsumerWire),
});

export const QueueMetrics = Schema.Struct({
  backlog_bytes: Schema.Finite,
  backlog_count: Schema.Finite,
  oldest_message_timestamp_ms: Schema.Finite,
});
export type QueueMetrics = typeof QueueMetrics.Type;

const QueueMetricsResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: QueueMetrics,
});

const WorkerDeployment = Schema.Struct({
  id: Schema.String,
  created_on: Schema.String,
  versions: Schema.Array(
    Schema.Struct({
      version_id: Schema.String,
      percentage: Schema.Finite,
    }),
  ),
});
export type WorkerDeployment = typeof WorkerDeployment.Type;

const WorkerDeploymentsResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: Schema.Struct({
    deployments: Schema.Array(WorkerDeployment),
  }),
});

export const WorkerInvocation = Schema.Struct({
  cpuTimeMs: Schema.Finite,
  eventType: Schema.String,
  outcome: Schema.String,
  requestId: Schema.String,
  scriptName: Schema.String,
  wallTimeMs: Schema.Finite,
  scriptVersion: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
      }),
    ),
  ),
});
export type WorkerInvocation = typeof WorkerInvocation.Type;

const WorkerInvocationReference = Schema.Struct({
  eventType: Schema.String,
  requestId: Schema.String,
  scriptName: Schema.String,
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const WorkerTelemetryEvent = Schema.Struct({
  timestamp: Schema.Finite,
  $workers: Schema.optionalKey(
    Schema.NullOr(Schema.Union([WorkerInvocation, WorkerInvocationReference])),
  ),
});

const WorkerInvocationsResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: Schema.Struct({
    events: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          events: Schema.optionalKey(Schema.NullOr(Schema.Array(WorkerTelemetryEvent))),
        }),
      ),
    ),
  }),
});

const QueueResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: Schema.Struct({
    queue_id: Schema.String,
    queue_name: Schema.String,
  }),
});

const BucketResponse = Schema.Struct({
  ...CloudflareSuccess.fields,
  result: Schema.Struct({
    name: Schema.String,
  }),
});

export const CloudflareCapacityCredentials = Schema.Struct({
  accountId: Schema.String.check(Schema.isMinLength(1)),
  apiToken: Schema.String.check(Schema.isMinLength(1)),
});
export type CloudflareCapacityCredentials = typeof CloudflareCapacityCredentials.Type;

export type WorkerTelemetryWindow = {
  readonly scriptName: string;
  readonly fromEpochMs: number;
  readonly toEpochMs: number;
};

export class CloudflareCapacityApiError extends Data.TaggedError("CloudflareCapacityApiError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
}> {}

export interface CloudflareCapacityTransport {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const cloudflareCapacityTransport = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
} satisfies CloudflareCapacityTransport;

export function createCloudflareCapacityClient(
  credentials: CloudflareCapacityCredentials,
  transport: CloudflareCapacityTransport = cloudflareCapacityTransport,
) {
  const api = async (method: string, path: string, body?: string) => {
    const headers = new Headers({
      authorization: `Bearer ${credentials.apiToken}`,
    });
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const request: RequestInit = { method, headers };
    if (body !== undefined) {
      request.body = body;
    }
    const response = await transport.fetch(`https://api.cloudflare.com/client/v4${path}`, request);
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudflareCapacityApiError({ method, path, status: response.status });
    }
    return response;
  };

  const accountPath = `/accounts/${encodeURIComponent(credentials.accountId)}`;
  return {
    async listQueueConsumers(queueId: string): Promise<ReadonlyArray<QueueConsumer>> {
      const response = await api(
        "GET",
        `${accountPath}/queues/${encodeURIComponent(queueId)}/consumers`,
      );
      const decoded = await Schema.decodeUnknownPromise(QueueConsumersResponse)(
        await response.json(),
      );
      return decoded.result.map(normalizeQueueConsumer);
    },

    async getQueueMetrics(queueId: string): Promise<QueueMetrics> {
      const response = await api(
        "GET",
        `${accountPath}/queues/${encodeURIComponent(queueId)}/metrics`,
      );
      const decoded = await Schema.decodeUnknownPromise(QueueMetricsResponse)(
        await response.json(),
      );
      return decoded.result;
    },

    async listWorkerDeployments(scriptName: string): Promise<ReadonlyArray<WorkerDeployment>> {
      const response = await api(
        "GET",
        `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
      );
      const decoded = await Schema.decodeUnknownPromise(WorkerDeploymentsResponse)(
        await response.json(),
      );
      return decoded.result.deployments;
    },

    async queryWorkerInvocations(window: WorkerTelemetryWindow) {
      const response = await api(
        "POST",
        `${accountPath}/workers/observability/telemetry/query`,
        JSON.stringify({
          queryId: "umail-mail-capacity",
          view: "events",
          timeframe: {
            from: window.fromEpochMs,
            to: window.toEpochMs,
          },
          limit: 1000,
          parameters: {
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: window.scriptName,
              },
            ],
          },
        }),
      );
      const decoded = await Schema.decodeUnknownPromise(WorkerInvocationsResponse)(
        await response.json(),
      );
      return (decoded.result.events?.events ?? []).flatMap((event) => {
        const invocation = event.$workers;
        return invocation !== null &&
          invocation !== undefined &&
          Schema.is(WorkerInvocation)(invocation) &&
          invocation.eventType === "queue"
          ? [invocation]
          : [];
      });
    },

    async deleteRetainedBucket(bucketName: string, jurisdiction: string): Promise<void> {
      const response = await transport.fetch(
        `https://api.cloudflare.com/client/v4${accountPath}/r2/buckets/${encodeURIComponent(bucketName)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credentials.apiToken}`,
            "cf-r2-jurisdiction": jurisdiction,
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudflareCapacityApiError({
          method: "DELETE",
          path: `${accountPath}/r2/buckets/${bucketName}`,
          status: response.status,
        });
      }
      await response.body?.cancel();
    },

    async queueExists(queueId: string): Promise<boolean> {
      const response = await transport.fetch(
        `https://api.cloudflare.com/client/v4${accountPath}/queues/${encodeURIComponent(queueId)}`,
        { headers: { authorization: `Bearer ${credentials.apiToken}` } },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return false;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudflareCapacityApiError({
          method: "GET",
          path: `${accountPath}/queues/${queueId}`,
          status: response.status,
        });
      }
      await Schema.decodeUnknownPromise(QueueResponse)(await response.json());
      return true;
    },

    async workerExists(scriptName: string): Promise<boolean> {
      const response = await transport.fetch(
        `https://api.cloudflare.com/client/v4${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}`,
        { headers: { authorization: `Bearer ${credentials.apiToken}` } },
      );
      await response.body?.cancel();
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new CloudflareCapacityApiError({
          method: "GET",
          path: `${accountPath}/workers/scripts/${scriptName}`,
          status: response.status,
        });
      }
      return true;
    },

    async bucketExists(bucketName: string, jurisdiction: string): Promise<boolean> {
      const path = `${accountPath}/r2/buckets/${encodeURIComponent(bucketName)}`;
      const response = await transport.fetch(`https://api.cloudflare.com/client/v4${path}`, {
        headers: {
          authorization: `Bearer ${credentials.apiToken}`,
          "cf-r2-jurisdiction": jurisdiction,
        },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return false;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudflareCapacityApiError({ method: "GET", path, status: response.status });
      }
      await Schema.decodeUnknownPromise(BucketResponse)(await response.json());
      return true;
    },
  };
}

function normalizeQueueConsumer(consumer: QueueConsumerWire): QueueConsumer {
  const scriptName = Schema.is(QueueConsumerScriptWire)(consumer)
    ? consumer.script
    : consumer.script_name;
  return {
    consumerId: consumer.consumer_id,
    type: consumer.type,
    scriptName,
    deadLetterQueue: consumer.dead_letter_queue,
    settings: {
      batchSize: consumer.settings.batch_size,
      maxConcurrency: consumer.settings.max_concurrency,
      maxRetries: consumer.settings.max_retries,
    },
  };
}
