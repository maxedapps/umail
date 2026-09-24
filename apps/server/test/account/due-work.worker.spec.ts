/// <reference types="@cloudflare/vitest-plugin/types" />

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  OPERATOR_POLICY,
  SubmissionRequestId,
  parseExternalMailAddress,
  parseMailDomain,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { FakeMailHtmlPolicy } from "../mail/fakes.ts";
import { accountStore, approvalMaterial } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("account-store alarm", () => {
  it("runs the due-work pass from the Durable Object alarm and then clears it", async () => {
    const store = accountStore("due-work-alarm");
    const mailbox = await store.createAddress("inbox", requireMailDomain(), "Inbox", NOW);
    if (mailbox === null) throw new Error("expected mailbox");
    const sent: Array<string> = [];
    await runInDurableObject(store, (host: AccountStoreTestHost, state) => {
      host.dueWorkPorts = {
        sender: {
          send: (mail) =>
            Effect.sync(() => {
              sent.push(mail.subject);
              return { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: null };
            }),
        },
        htmlPolicy: new FakeMailHtmlPolicy(),
        applicationUrl: new URL("https://umail.example.com"),
        notification: {
          key: crypto.getRandomValues(new Uint8Array(32)),
          mailDomain: requireMailDomain(),
          approvalAdminEmail: requireExternal("operator@example.net"),
        },
        policyFor: () => Effect.succeed(OPERATOR_POLICY),
        index: { send: () => Effect.void },
      };
      // Far enough out that the runtime never fires it on its own during the spec.
      return state.storage.setAlarm(Date.now() + 60 * 60_000);
    });
    const submitted = await store.submitOutbound({
      requestId: Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID()),
      requester: { kind: "operator", clientId: "cli", label: "AgentMail CLI" },
      policy: OPERATOR_POLICY,
      mailboxId: mailbox.id,
      subject: "Hello",
      textBody: "body",
      htmlBody: null,
      hasRemoteImages: false,
      to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
      cc: [],
      inReplyToHeader: null,
      referencesHeader: null,
      nowIso: NOW,
      approval: approvalMaterial("2026-01-02T00:00:00.000Z"),
    });

    expect(await runDurableObjectAlarm(store)).toBe(true);
    expect(sent).toEqual(["Hello"]);
    expect(await store.getOutboundJob(submitted.job.jobId, { kind: "operator" })).toMatchObject({
      state: "accepted",
    });
    expect(await runInDurableObject(store, (_host, state) => state.storage.getAlarm())).toBeNull();
  });
});

function requireMailDomain() {
  const parsed = parseMailDomain("umail.example.com");
  if (parsed.kind !== "ok") throw new Error("expected mail domain");
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") throw new Error("expected email");
  return parsed.address;
}
