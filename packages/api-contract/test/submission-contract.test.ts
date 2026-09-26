import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { OutboundJobStatus, SubmitMessagePayload, UmailApi } from "../src/api-spec.ts";
import { OutboundJobState } from "../src/submission-domain.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const contact = { address: "user@example.com", displayName: null };

describe("submission and job contracts", () => {
  const payload = {
    intent: "compose",
    requestId: REQUEST_ID,
    fromAddressId: "addr-1",
    to: [contact],
    subject: "Hello",
    text: "body",
  } as const;

  // What a caller reads in the 400 when the submission does not decode.
  function firstIssue(input: unknown) {
    const result = Schema.toStandardSchemaV1(SubmitMessagePayload)["~standard"].validate(input);
    if (result instanceof Promise || result.issues === undefined) return null;
    const [issue] = result.issues;
    return { path: issue?.path?.map(String).join("."), message: issue?.message };
  }

  it("requires a request id, accepts any case and stores it lower-cased", () => {
    const upper = "AAAAAAAA-1111-4111-8111-11111111111F";
    const decoded = Schema.decodeSync(SubmitMessagePayload)({ ...payload, requestId: upper });
    expect(decoded.requestId).toBe(upper.toLowerCase());
    const { requestId: _, ...withoutId } = payload;
    expect(firstIssue(withoutId)).toEqual({
      path: "requestId",
      message: "Expected a requestId (a UUID you generate)",
    });
    expect(firstIssue({ ...payload, requestId: "not-a-uuid" })?.path).toBe("requestId");
  });

  it("names the offending field in plain words", () => {
    expect(firstIssue({ ...payload, to: [{ address: "Ada <ada@example.com>" }] })).toEqual({
      path: "to.0.address",
      message:
        "Expected a bare address like name@example.com, with a lowercase domain and no display name",
    });
    expect(firstIssue({ ...payload, to: [] })).toEqual({
      path: "to.0",
      message: "Expected at least one recipient",
    });
    expect(firstIssue({ ...payload, intent: "forward" })).toEqual({
      path: "",
      message: 'Expected a compose or reply submission (intent: "compose" | "reply")',
    });
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
