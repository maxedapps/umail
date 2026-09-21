import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { OutboundJobStatus, SubmitMessagePayload, UmailApi } from "../src/api-spec.ts";
import { OutboundJobState, SubmissionRequestId } from "../src/submission-domain.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const contact = { address: "user@example.com", displayName: null };

describe("submission and job contracts", () => {
  it("requires a principal-scoped request id on REST and MCP submit payloads", () => {
    const decoded = Schema.decodeResult(SubmitMessagePayload)({
      intent: "compose",
      requestId: REQUEST_ID,
      fromAddressId: "addr-1",
      to: [contact],
      subject: "Hello",
      text: "body",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SubmitMessagePayload)({
          intent: "compose",
          fromAddressId: "addr-1",
          to: [contact],
          subject: "Hello",
          text: "body",
        }),
      ),
    ).toBe(true);
    expect(() => Schema.decodeSync(SubmissionRequestId)("not-a-uuid")).toThrow();
  });

  it("exposes job status without notification ciphertext fields", () => {
    const status = Schema.decodeSync(OutboundJobStatus)({
      jobId: "job-1",
      requestId: REQUEST_ID,
      messageId: "message-1",
      threadHandle: "node:550e8400-e29b-41d4-a716-446655440000",
      state: "ready",
      purpose: "message",
      attemptId: null,
      providerMessageId: null,
      rfcMessageId: null,
      failureClass: null,
      failureDetail: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(status.state).toBe("ready");
    expect(status).not.toHaveProperty("ciphertext");
    expect(status).not.toHaveProperty("nonce");
    expect(status).not.toHaveProperty("token");
    expect(status).not.toHaveProperty("tokenHash");
    expect(
      (["waiting_approval", "ready", "in_flight", "accepted", "rejected", "unknown"] as const).map(
        (state) => Schema.decodeSync(OutboundJobState)(state),
      ),
    ).toEqual(["waiting_approval", "ready", "in_flight", "accepted", "rejected", "unknown"]);
  });

  it("adds submission and job routes beside the existing send endpoint", () => {
    expect(
      Object.values(UmailApi.groups.Submissions.endpoints).map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
      })),
    ).toEqual([{ method: "POST", path: "/submissions" }]);
    expect(
      Object.values(UmailApi.groups.Jobs.endpoints).map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
      })),
    ).toEqual([
      { method: "GET", path: "/jobs" },
      { method: "GET", path: "/jobs/:id" },
    ]);
    expect(UmailApi.groups.Messages.endpoints.sendMessage.path).toBe("/messages");
    expect(UmailApi.groups.Messages.endpoints.sendMessage.method).toBe("POST");
    expect(UmailApi.groups.Submissions.endpoints.submitMessage.method).toBe("POST");
    expect(UmailApi.groups.Threads.endpoints.listThreadMessages.path).toBe("/threads/:id/messages");
  });
});
