import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import {
  LocalTargetFlowObservation,
  LocalTargetRegressionObservation,
} from "./redesign-e2e-model.ts";

describe("local fake-provider target", () => {
  it("logs in, sets policy, indexes inbound mail, replies, approves, and sends once", async () => {
    const flow = await observeFlow();

    expect(flow.loginFinalPath).toBe("/clients");
    expect(flow.policyLabel).toBe("Local E2E agent");
    expect(flow.policySendMode).toBe("requireApproval");
    expect(flow.inboundMessageId.length).toBeGreaterThan(0);
    expect(flow.inboundAttachmentId.length).toBeGreaterThan(0);
    expect(flow.inboundAttachmentContentType).toBe("image/png");
    expect(flow.inboundAttachmentByteLength).toBeGreaterThan(0);
    expect(flow.replyStateAfterSubmit).toBe("waiting_approval");
    expect(flow.approvalAfterDecision).toContain("submission outcome is not confirmed");
    expect(flow.approvalAfterDecision).not.toContain("Approve & send");
    expect(flow.providerCalls).toBe(2);
    expect(flow.jobState).toBe("accepted");
    expect(flow.jobProviderMessageId).toBe("prov-local-e2e");
    expect(flow.approvalAfterSend).toContain("accepted by Cloudflare for delivery");
    expect(flow.attachmentContentType).toBe("image/png");
    expect(flow.attachmentMatchesPng).toBe(true);
  });

  it("rejects signup, hostile policy mutation, duplicate index, and approval replay sends", async () => {
    const probe = await observeRegressions();

    expect(probe.signupStatus).toBe(404);
    expect(probe.wrongPasswordStatus).toBe(
      "Could not sign in. Check the operator email and secret.",
    );
    expect(probe.hostilePolicyStatus).toBe(403);
    expect(probe.policyLabelAfterHostilePost).not.toBe("Hacked");
    expect(probe.inboundMessageCountAfterDuplicateIndex).toBe(1);
    expect(probe.providerCallsAfterApprovalReplay).toBe(2);
  });
});

async function observeFlow() {
  const decoded = Schema.decodeResult(LocalTargetFlowObservation)(
    await commands.runLocalTargetFlow(),
  );
  if (Result.isFailure(decoded)) {
    throw new Error(`Invalid local target flow observation: ${decoded.failure.message}`);
  }
  return decoded.success;
}

async function observeRegressions() {
  const decoded = Schema.decodeResult(LocalTargetRegressionObservation)(
    await commands.probeLocalTargetRegressions(),
  );
  if (Result.isFailure(decoded)) {
    throw new Error(`Invalid local target regression observation: ${decoded.failure.message}`);
  }
  return decoded.success;
}
