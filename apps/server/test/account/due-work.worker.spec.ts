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
import { describe, expect, it } from "@effect/vitest";

import { FakeMailHtmlPolicy } from "../mail/fakes.ts";
import { accountStore, approvalMaterial } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";

// Far enough out that the runtime never fires the alarm on its own during the spec.
const FAR_FUTURE_MS = Date.parse("2100-01-01T00:00:00.000Z");
const REQUEST_ID = Schema.decodeSync(SubmissionRequestId)("11111111-1111-4111-8111-111111111111");

describe("account-store alarm", () => {
  it.effect("runs the due-work pass from the Durable Object alarm and then clears it", () =>
    Effect.gen(function* () {
      const store = accountStore("due-work-alarm");
      const mailbox = yield* Effect.promise(() =>
        store.createAddress("inbox", requireMailDomain(), "Inbox", NOW),
      );
      if (mailbox === null) throw new Error("expected mailbox");
      const sent: Array<string> = [];
      yield* Effect.promise(() =>
        runInDurableObject(store, (host: AccountStoreTestHost, state) => {
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
              key: Effect.succeed(crypto.getRandomValues(new Uint8Array(32))),
              mailDomain: requireMailDomain(),
              approvalAdminEmail: requireExternal("operator@example.net"),
            },
            policyFor: () => Effect.succeed(OPERATOR_POLICY),
            index: { send: () => Effect.void },
          };
          return state.storage.setAlarm(FAR_FUTURE_MS);
        }),
      );
      const submitted = yield* Effect.promise(() =>
        store.submitOutbound({
          requestId: REQUEST_ID,
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
        }),
      );

      expect(yield* Effect.promise(() => runDurableObjectAlarm(store))).toBe(true);
      expect(sent).toEqual(["Hello"]);
      expect(
        yield* Effect.promise(() =>
          store.getOutboundJob(submitted.job.jobId, { kind: "operator" }),
        ),
      ).toMatchObject({ state: "accepted" });
      expect(
        yield* Effect.promise(() =>
          runInDurableObject(store, (_host, state) => state.storage.getAlarm()),
        ),
      ).toBeNull();
    }),
  );
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
