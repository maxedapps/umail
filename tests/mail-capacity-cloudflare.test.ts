import { describe, expect, it } from "vitest";

import {
  createCloudflareCapacityClient,
  type CloudflareCapacityTransport,
} from "./mail-capacity-cloudflare.ts";

describe("Cloudflare mail capacity client", () => {
  it("normalizes the queue-consumer response observed from the live endpoint", async () => {
    const requestedUrls: string[] = [];
    const transport = {
      fetch: (url) => {
        requestedUrls.push(url);
        return Promise.resolve(
          Response.json({
            success: true,
            result: [
              {
                consumer_id: "consumer-123",
                type: "worker",
                script: "mail-capacity-index",
                dead_letter_queue: "mail-capacity-dlq",
                settings: {
                  batch_size: 1,
                  max_concurrency: 1,
                  max_retries: 4,
                },
              },
            ],
          }),
        );
      },
    } satisfies CloudflareCapacityTransport;
    const client = createCloudflareCapacityClient(
      { accountId: "account-123", apiToken: "token-123" },
      transport,
    );

    await expect(client.listQueueConsumers("queue-123")).resolves.toEqual([
      {
        consumerId: "consumer-123",
        type: "worker",
        scriptName: "mail-capacity-index",
        deadLetterQueue: "mail-capacity-dlq",
        settings: {
          batchSize: 1,
          maxConcurrency: 1,
          maxRetries: 4,
        },
      },
    ]);
    expect(requestedUrls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account-123/queues/queue-123/consumers",
    ]);
  });
});
