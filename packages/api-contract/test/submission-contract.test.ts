import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { OutboundJobStatus, SubmitMessagePayload, UmailApi } from "../src/api-spec.ts";
import { OutboundJobState, SubmissionRequestId } from "../src/submission-domain.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const contact = { address: "user@example.com", displayName: null };

describe("submission and job contracts", () => {
  it("accepts a submission with or without a request id and rejects a malformed one", () => {
    const payload = {
      intent: "compose",
      fromAddressId: "addr-1",
      to: [contact],
      subject: "Hello",
      text: "body",
    } as const;
    expect(
      Result.isSuccess(
        Schema.decodeResult(SubmitMessagePayload)({ ...payload, requestId: REQUEST_ID }),
      ),
    ).toBe(true);
    expect(Result.isSuccess(Schema.decodeResult(SubmitMessagePayload)(payload))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeResult(SubmitMessagePayload)({ ...payload, requestId: "not-a-uuid" }),
      ),
    ).toBe(true);
    expect(() => Schema.decodeSync(SubmissionRequestId)("not-a-uuid")).toThrow();
  });

  it("exposes job status without approval token fields", () => {
    const status = Schema.decodeSync(OutboundJobStatus)({
      jobId: "job-1",
      requestId: REQUEST_ID,
      messageId: "message-1",
      threadId: "message-1",
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

  it("sends only through /submissions and exposes job routes", () => {
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
    expect("sendMessage" in UmailApi.groups.Messages.endpoints).toBe(false);
    expect(
      Object.values(UmailApi.groups.Messages.endpoints).map(
        (endpoint) => `${endpoint.method} ${endpoint.path}`,
      ),
    ).not.toContain("POST /messages");
    expect(UmailApi.groups.Submissions.endpoints.submitMessage.method).toBe("POST");
  });

  it("serves a thread and its message pages from one route", () => {
    expect(
      Object.values(UmailApi.groups.Threads.endpoints).map(
        (endpoint) => `${endpoint.method} ${endpoint.path}`,
      ),
    ).toEqual([
      "GET /threads",
      "GET /threads/:id",
      "PATCH /threads/:id/read",
      "PATCH /threads/:id/unread",
      "DELETE /threads/:id",
    ]);
  });
});
