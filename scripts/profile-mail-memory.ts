import {
  MailHtmlPolicyError,
  createMailHtmlPolicy,
  type MailHtmlSanitization,
} from "../packages/mail-content/src/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { processInbound } from "../apps/server/src/mail/inbound.ts";
import { FakeEmail } from "../apps/server/test/mail/fakes.ts";
import {
  combinedAttachmentHtmlFixture,
  foldedBase64Fixture,
  malformedHtmlFixture,
  maximumRawAttachmentFixture,
  overHtmlAttributesFixture,
  overTextExpansionFixture,
  paddedBase64LinesFixture,
  quotedPrintableFixture,
  sanitizerOutputExpansionFixture,
  type MailCapacityFixture,
  type MailCapacityFixtureFactory,
} from "../apps/server/test/mail/mail-capacity-fixtures.ts";
import {
  consumeNextMailCapacityWork,
  createMailCapacityWorld,
  parseMailCapacityMime,
  seedMailCapacityInbox,
} from "../apps/server/test/mail/mail-capacity-support.ts";

if (globalThis.gc === undefined) {
  throw new Error("mail memory profiling requires Node --expose-gc");
}

const collectGarbage = globalThis.gc;

type MemoryPoint = {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
};

type MemoryDelta = MemoryPoint;

type PhaseOutcome = {
  readonly kind: "success" | "failure";
  readonly detail: string;
};

type PhaseExecution = {
  readonly outcome: PhaseOutcome;
  readonly after: MemoryPoint;
};

type PhaseDiagnostic = {
  readonly phase: "parse" | "sanitize" | "index_and_write";
  readonly fixtureId: string;
  readonly rawBytes: number;
  readonly sampleKind: "point_in_time";
  readonly durationMs: number;
  readonly outcome: PhaseOutcome;
  readonly before: MemoryPoint;
  readonly after: MemoryPoint;
  readonly delta: MemoryDelta;
};

type SanitizationInput = {
  readonly html: string;
  readonly sanitization: MailHtmlSanitization;
};

type ParsedMail = Awaited<ReturnType<typeof parseMailCapacityMime>>;

const PARSE_FIXTURES = [
  { id: "maximum-raw-attachment", make: maximumRawAttachmentFixture },
  { id: "folded-base64", make: foldedBase64Fixture },
  { id: "padded-base64-lines", make: paddedBase64LinesFixture },
  { id: "quoted-printable", make: quotedPrintableFixture },
  { id: "over-text-expansion", make: overTextExpansionFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

const SANITIZE_FIXTURES = [
  { id: "combined-attachment-html", make: combinedAttachmentHtmlFixture },
  { id: "malformed-html", make: malformedHtmlFixture },
  { id: "over-html-attributes", make: overHtmlAttributesFixture },
  { id: "sanitizer-output-expansion", make: sanitizerOutputExpansionFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

const INDEX_FIXTURES = [
  { id: "maximum-raw-attachment", make: maximumRawAttachmentFixture },
  { id: "combined-attachment-html", make: combinedAttachmentHtmlFixture },
  { id: "malformed-html", make: malformedHtmlFixture },
  { id: "over-text-expansion", make: overTextExpansionFixture },
  { id: "over-html-attributes", make: overHtmlAttributesFixture },
  { id: "sanitizer-output-expansion", make: sanitizerOutputExpansionFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

const diagnostics = await Effect.runPromise(
  Effect.gen(function* () {
    const measurements: PhaseDiagnostic[] = [];
    for (const descriptor of PARSE_FIXTURES) {
      const fixture = descriptor.make();
      measurements.push(yield* observeParse(fixture));
    }
    for (const descriptor of SANITIZE_FIXTURES) {
      const fixture = descriptor.make();
      const input = yield* sanitizationInput(fixture);
      measurements.push(yield* observeSanitize(fixture, input));
    }
    for (const descriptor of INDEX_FIXTURES) {
      const fixture = descriptor.make();
      measurements.push(yield* observeIndexAndWrites(fixture));
    }
    return measurements;
  }),
);

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      samples: "Point-in-time process.memoryUsage() observations; they are not allocation peaks.",
      garbageCollection:
        "A forced collection runs immediately before each phase sample, after that fixture is constructed.",
      baselines:
        "Parse and index baselines include the raw fixture; sanitize baselines include both the raw fixture and its parsed HTML input.",
      overlap:
        "arrayBuffers is included in external memory and is reported separately; the fields are not summed.",
      backingStorage:
        "The index phase retains faithful in-memory archive objects only for its after sample; that models backing-storage copies, not R2 isolate accounting.",
      productionClaim:
        "This bounded Node diagnostic does not establish the Cloudflare Workers memory ceiling.",
      diagnostics,
    },
    null,
    2,
  )}\n`,
);

function observeParse(fixture: MailCapacityFixture): Effect.Effect<PhaseDiagnostic> {
  const execute = Effect.gen(function* () {
    const outcome = yield* Effect.tryPromise({
      try: () => parseMailCapacityMime(fixture.raw),
      catch: failureOutcome,
    }).pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: successfulParseOutcome,
      }),
    );
    return { outcome, after: memoryPoint() } satisfies PhaseExecution;
  });
  return observePhase("parse", fixture, execute);
}

function observeSanitize(
  fixture: MailCapacityFixture,
  input: SanitizationInput,
): Effect.Effect<PhaseDiagnostic> {
  const execute = Effect.gen(function* () {
    const outcome = yield* createMailHtmlPolicy()
      .sanitizeForStorage(input.html, input.sanitization)
      .pipe(
        Effect.match({
          onFailure: failureOutcome,
          onSuccess: (stored): PhaseOutcome => ({
            kind: "success",
            detail: `storedBytes=${String(new TextEncoder().encode(stored.body).byteLength)} remoteImages=${String(stored.hasRemoteImages)}`,
          }),
        }),
      );
    return { outcome, after: memoryPoint() } satisfies PhaseExecution;
  });
  return observePhase("sanitize", fixture, execute);
}

function observeIndexAndWrites(fixture: MailCapacityFixture): Effect.Effect<PhaseDiagnostic> {
  const execute = Effect.gen(function* () {
    const world = createMailCapacityWorld(createMailHtmlPolicy());
    seedMailCapacityInbox(world.account);
    const outcome = yield* Effect.gen(function* () {
      const disposition = yield* Effect.tryPromise({
        try: () =>
          processInbound(
            new FakeEmail({
              to: "inbox@umail.example.com",
              from: "sender@example.com",
              raw: fixture.raw,
            }),
            world.ports,
          ),
        catch: failureOutcome,
      });
      if (disposition.kind !== "accepted") {
        return { kind: "failure", detail: `inbound=${disposition.reason}` } satisfies PhaseOutcome;
      }
      const work = yield* Effect.tryPromise({
        try: () => consumeNextMailCapacityWork(world),
        catch: failureOutcome,
      });
      const receipt = world.account.receipts.get(work.receiptId);
      const storedBytes = archiveStoredBytes(world.archive.objects);
      return {
        kind: "success",
        detail: `receipt=${receipt?.workState ?? "missing"} accepted=${String(world.account.accepted.length)} policyFailures=${String(world.account.policyFailures.length)} archiveObjects=${String(world.archive.objects.size)} archiveBytes=${String(storedBytes)} derivedWrites=${String(world.archive.observedStorePutKeys.filter((key) => key.startsWith("attachments/")).length)}`,
      } satisfies PhaseOutcome;
    }).pipe(Effect.catch((failure) => Effect.succeed(failure)));
    return { outcome, after: memoryPoint() } satisfies PhaseExecution;
  });
  return observePhase("index_and_write", fixture, execute);
}

function observePhase(
  phase: PhaseDiagnostic["phase"],
  fixture: MailCapacityFixture,
  execute: Effect.Effect<PhaseExecution>,
): Effect.Effect<PhaseDiagnostic> {
  return Effect.gen(function* () {
    collectGarbage();
    const before = memoryPoint();
    const startedAt = performance.now();
    const execution = yield* execute;
    const durationMs = performance.now() - startedAt;
    return {
      phase,
      fixtureId: fixture.id,
      rawBytes: fixture.raw.byteLength,
      sampleKind: "point_in_time",
      durationMs,
      outcome: execution.outcome,
      before,
      after: execution.after,
      delta: memoryDelta(execution.after, before),
    };
  });
}

function sanitizationInput(fixture: MailCapacityFixture): Effect.Effect<SanitizationInput> {
  return Effect.promise(() => parseMailCapacityMime(fixture.raw)).pipe(
    Effect.map((parsed) => {
      const html = parsed.html;
      if (html === undefined) {
        throw new Error(`fixture ${fixture.id} did not contain HTML`);
      }
      return {
        html,
        sanitization: {
          messageId: `in_profile_${fixture.id.replaceAll("-", "_")}`,
          attachments: parsed.attachments.map((attachment, position) => ({
            id: `att_profile_${String(position)}`,
            contentId: attachment.contentId ?? null,
            mimeType: attachment.mimeType,
          })),
        },
      } satisfies SanitizationInput;
    }),
  );
}

function successfulParseOutcome(parsed: ParsedMail): PhaseOutcome {
  const attachmentBytes = parsed.attachments.reduce((total, attachment) => {
    const content = attachment.content;
    return total + (content instanceof ArrayBuffer ? content.byteLength : content.length);
  }, 0);
  return {
    kind: "success",
    detail: `attachments=${String(parsed.attachments.length)} attachmentBytes=${String(attachmentBytes)} textCodeUnits=${String(parsed.text?.length ?? 0)} htmlCodeUnits=${String(parsed.html?.length ?? 0)}`,
  };
}

function failureOutcome(cause: unknown): PhaseOutcome {
  if (Schema.is(MailHtmlPolicyError)(cause)) {
    return { kind: "failure", detail: `${cause._tag}:${cause.reason}` };
  }
  if (cause instanceof Error) {
    return {
      kind: "failure",
      detail: cause.message.length === 0 ? cause.name : cause.message,
    };
  }
  return {
    kind: "failure",
    detail: String(cause),
  };
}

function memoryPoint(): MemoryPoint {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function memoryDelta(after: MemoryPoint, before: MemoryPoint): MemoryDelta {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function archiveStoredBytes(objects: ReadonlyMap<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of objects.values()) {
    total += bytes.byteLength;
  }
  return total;
}
