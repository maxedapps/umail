import { MAIL_HTML_PARSE_LIMITS } from "../../../../packages/mail-content/src/mail-html-parser.ts";
import {
  DEFAULT_MAX_RAW_BYTES,
  INBOUND_MIME_LIMITS,
  MAX_ATTACHMENTS,
  MAX_PERSISTED_MESSAGE_BYTES,
} from "../../src/mail/policy.ts";

// Keep the address length stable: maximum-size fixtures pin attachment sizes and digests.
export const MAIL_CAPACITY_INBOX = "inbox@mailbox.example.com";
export const MAIL_CAPACITY_SENDER = "sender@example.com";

export type MailCapacityAttachmentExpectation = {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type MailCapacityIndexedExpectation = {
  readonly kind: "indexed";
  readonly subject: string;
  readonly textIncludes: string | null;
  readonly htmlIncludes: string | null;
  readonly hasRemoteImages: boolean;
  readonly attachments: ReadonlyArray<MailCapacityAttachmentExpectation>;
};

export type MailCapacityPolicyFailureReason =
  | "attachment_cap"
  | "message_budget"
  | "mime_budget"
  | "parse_failed"
  | "rfc822_depth"
  | "sanitize_failed";

export type MailCapacityPolicyFailureExpectation = {
  readonly kind: "policy_failed";
  readonly reason: MailCapacityPolicyFailureReason;
};

export type MailCapacityInboundRejectionExpectation = {
  readonly kind: "inbound_rejected";
  readonly reason: "message too large";
};

export type MailCapacityFixture = {
  readonly id: string;
  readonly raw: Uint8Array;
  readonly expected: MailCapacityIndexedExpectation | MailCapacityPolicyFailureExpectation;
};

export type MailCapacityInboundRejectedFixture = {
  readonly id: string;
  readonly raw: Uint8Array;
  readonly expected: MailCapacityInboundRejectionExpectation;
};

export type MailCapacityFixtureFactory = {
  readonly id: string;
  readonly make: () => MailCapacityFixture;
};

export type MailCapacityInboundRejectedFixtureFactory = {
  readonly id: string;
  readonly make: () => MailCapacityInboundRejectedFixture;
};

type MailCapacityTransferEncoding = "base64" | "quoted-printable";

const MAX_RAW_ATTACHMENT_BYTES = 20_702_264;
const MAX_RAW_ATTACHMENT_SHA256 =
  "a4cdd3ce20feaf36f58d53f5a176432327f7b3ab438ae08424e05368a4dccf8d";
const PADDED_LINES_UNIT_COUNT = INBOUND_MIME_LIMITS.maxLineCount - 16;
const FOLDED_BASE64_TRIPLETS = 256 * 1024;
const COMBINED_BASE64_TRIPLETS = 128 * 1024;
const QUOTED_PRINTABLE_UNITS = 20_000;
const MAXIMUM_ENCODED_LINE_COUNT = 268_800;
const MAXIMUM_FOLDED_BASE64_DECODED_BYTES = 15_321_600;
const MAXIMUM_FOLDED_BASE64_SHA256 =
  "d1964e5296b363fe2b8440d16e6ccb52bd20c748ede1931e279b8815e663cf16";
const MAXIMUM_QUOTED_PRINTABLE_DECODED_BYTES = 17_472_000;
const MAXIMUM_QUOTED_PRINTABLE_SHA256 =
  "cb720af38a4e7aec8ea2be8820dfe145a19fdd6bf1c509ca3e63dc14862d5cc1";

export function maximumRawAttachmentFixture(): MailCapacityFixture {
  return {
    id: "maximum-raw-attachment",
    raw: sizedAttachmentEml(DEFAULT_MAX_RAW_BYTES),
    expected: {
      kind: "indexed",
      subject: "Maximum raw attachment",
      textIncludes: "maximum raw marker",
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "maximum.bin",
          mimeType: "application/octet-stream",
          byteLength: MAX_RAW_ATTACHMENT_BYTES,
          sha256: MAX_RAW_ATTACHMENT_SHA256,
        },
      ],
    },
  };
}

export function maximumRawSequenceFixture(variant: "01" | "02" | "03"): MailCapacityFixture {
  const marker = `maximum raw mark${variant}`;
  const subject = `Maximum raw variant ${variant}`;
  return {
    id: `maximum-raw-sequence-${variant}`,
    raw: sizedAttachmentEml(DEFAULT_MAX_RAW_BYTES, marker, subject),
    expected: {
      kind: "indexed",
      subject,
      textIncludes: marker,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "maximum.bin",
          mimeType: "application/octet-stream",
          byteLength: MAX_RAW_ATTACHMENT_BYTES,
          sha256: MAX_RAW_ATTACHMENT_SHA256,
        },
      ],
    },
  };
}

export function maximumRawFoldedBase64Fixture(): MailCapacityFixture {
  return {
    id: "maximum-raw-folded-base64",
    raw: sizedTransferEncodedAttachmentEml(
      DEFAULT_MAX_RAW_BYTES,
      "Maximum raw folded base64",
      "base64",
      "maximum-folded.bin",
      "AAEC".repeat(19),
      MAXIMUM_ENCODED_LINE_COUNT,
    ),
    expected: {
      kind: "indexed",
      subject: "Maximum raw folded base64",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "maximum-folded.bin",
          mimeType: "application/octet-stream",
          byteLength: MAXIMUM_FOLDED_BASE64_DECODED_BYTES,
          sha256: MAXIMUM_FOLDED_BASE64_SHA256,
        },
      ],
    },
  };
}

export function maximumRawQuotedPrintableFixture(): MailCapacityFixture {
  return {
    id: "maximum-raw-quoted-printable",
    raw: sizedTransferEncodedAttachmentEml(
      DEFAULT_MAX_RAW_BYTES,
      "Maximum raw quoted printable",
      "quoted-printable",
      "maximum-quoted-printable.bin",
      `${"capacity=3Dunit".repeat(5)}=`,
      MAXIMUM_ENCODED_LINE_COUNT,
    ),
    expected: {
      kind: "indexed",
      subject: "Maximum raw quoted printable",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "maximum-quoted-printable.bin",
          mimeType: "application/octet-stream",
          byteLength: MAXIMUM_QUOTED_PRINTABLE_DECODED_BYTES,
          sha256: MAXIMUM_QUOTED_PRINTABLE_SHA256,
        },
      ],
    },
  };
}

export function manyShortLinesFixture(): MailCapacityFixture {
  return {
    id: "many-short-lines",
    raw: manyShortLinesEml(100_000),
    expected: {
      kind: "indexed",
      subject: "Many short lines",
      textIncludes: "short-line-marker",
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [],
    },
  };
}

export function foldedBase64Fixture(): MailCapacityFixture {
  return {
    id: "folded-base64",
    raw: foldedBase64AttachmentEml(FOLDED_BASE64_TRIPLETS),
    expected: {
      kind: "indexed",
      subject: "Folded base64",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "folded.bin",
          mimeType: "application/octet-stream",
          byteLength: FOLDED_BASE64_TRIPLETS * 3,
          sha256: "27d4c3b40092b94042061ccb93940fe4a2a471c6ca3eec5cb2c98525b820f634",
        },
      ],
    },
  };
}

export function paddedBase64LinesFixture(): MailCapacityFixture {
  return {
    id: "padded-base64-lines",
    raw: paddedBase64LinesEml(PADDED_LINES_UNIT_COUNT),
    expected: {
      kind: "indexed",
      subject: "Padded base64 lines",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "padded-lines.bin",
          mimeType: "application/octet-stream",
          byteLength: PADDED_LINES_UNIT_COUNT,
          sha256: "41880b96016051edd89acaef34c749c108db6d22537ccf92b29a184a23dc1b8c",
        },
      ],
    },
  };
}

export function paddedBase64UnitsFixture(): MailCapacityFixture {
  const unitCount = INBOUND_MIME_LIMITS.maxLineLength / 4;
  return {
    id: "padded-base64-units",
    raw: paddedBase64UnitsEml(unitCount),
    expected: {
      kind: "indexed",
      subject: "Padded base64 units",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "padded-units.bin",
          mimeType: "application/octet-stream",
          byteLength: unitCount,
          sha256: "c93eee2d0db02f10acc7460d9576e122dcf8cd53c4bf8dfcae1b3e74ebcfff5a",
        },
      ],
    },
  };
}

export function quotedPrintableFixture(): MailCapacityFixture {
  return {
    id: "quoted-printable",
    raw: quotedPrintableAttachmentEml(QUOTED_PRINTABLE_UNITS),
    expected: {
      kind: "indexed",
      subject: "Quoted printable",
      textIncludes: null,
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [
        {
          filename: "quoted-printable.bin",
          mimeType: "application/octet-stream",
          byteLength: QUOTED_PRINTABLE_UNITS * 13 + 5,
          sha256: "873d49780a2fcb751d922ebea7e15f48ea3d3837b504b0d82b90878e7b028fc3",
        },
      ],
    },
  };
}

export function combinedAttachmentHtmlFixture(): MailCapacityFixture {
  return {
    id: "combined-attachment-html",
    raw: combinedAttachmentHtmlEml(COMBINED_BASE64_TRIPLETS),
    expected: {
      kind: "indexed",
      subject: "Combined attachment and HTML",
      textIncludes: null,
      htmlIncludes: "combined-capacity-marker",
      hasRemoteImages: true,
      attachments: [
        {
          filename: "combined.bin",
          mimeType: "application/octet-stream",
          byteLength: COMBINED_BASE64_TRIPLETS * 3,
          sha256: "b63751fc78b163aed91742001b1b9bbb2272f90a0390a91d906cf471a63209d6",
        },
      ],
    },
  };
}

export function nestedMessageFixture(): MailCapacityFixture {
  return {
    id: "nested-message",
    raw: nestedRfc822Eml(INBOUND_MIME_LIMITS.maxRfc822NestingDepth),
    expected: {
      kind: "indexed",
      subject: `RFC822 level ${String(INBOUND_MIME_LIMITS.maxRfc822NestingDepth - 1)}`,
      textIncludes: "nested-capacity-marker",
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [],
    },
  };
}

export function malformedHtmlFixture(): MailCapacityFixture {
  return {
    id: "malformed-html",
    raw: htmlEml(
      "Malformed HTML",
      '<p title="kept"><b>malformed-capacity-marker<img src="javascript:alert(1)"><script>removed',
    ),
    expected: {
      kind: "indexed",
      subject: "Malformed HTML",
      textIncludes: null,
      htmlIncludes: "malformed-capacity-marker",
      hasRemoteImages: false,
      attachments: [],
    },
  };
}

export function retryProbeFixture(): MailCapacityFixture {
  return {
    id: "retry-probe",
    raw: plainTextMessageEml("Retry probe", "retry-probe-marker"),
    expected: {
      kind: "indexed",
      subject: "Retry probe",
      textIncludes: "retry-probe-marker",
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [],
    },
  };
}

export function recoveryProbeFixture(): MailCapacityFixture {
  return {
    id: "recovery-probe",
    raw: plainTextMessageEml("Recovery probe", "recovery-probe-marker"),
    expected: {
      kind: "indexed",
      subject: "Recovery probe",
      textIncludes: "recovery-probe-marker",
      htmlIncludes: null,
      hasRemoteImages: false,
      attachments: [],
    },
  };
}

export function overLineCountFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-line-count",
    newlineHeavyEml(INBOUND_MIME_LIMITS.maxLineCount + 1),
    "mime_budget",
  );
}

export function overRawSizeFixture(): MailCapacityInboundRejectedFixture {
  return {
    id: "over-raw-size",
    raw: sizedAttachmentEml(DEFAULT_MAX_RAW_BYTES + 1),
    expected: { kind: "inbound_rejected", reason: "message too large" },
  };
}

export function overLineLengthFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-line-length",
    plainTextMessageEml("Line length budget", "x".repeat(INBOUND_MIME_LIMITS.maxLineLength + 1)),
    "mime_budget",
  );
}

export function overHeadersFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-headers",
    headerSizedEml(INBOUND_MIME_LIMITS.maxHeadersSize + 1),
    "parse_failed",
  );
}

export function overPartCountFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-part-count",
    partCountEml(INBOUND_MIME_LIMITS.maxParts + 1),
    "mime_budget",
  );
}

export function overReferencesFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-references",
    referencesEml(INBOUND_MIME_LIMITS.maxReferencesBytes + 1),
    "mime_budget",
  );
}

export function overTextExpansionFixture(): MailCapacityFixture {
  const bodyBytes = Math.floor(INBOUND_MIME_LIMITS.maxTextExpansionBytes / 2) + 4_096;
  return policyFailureFixture("over-text-expansion", textExpansionEml(bodyBytes), "mime_budget");
}

export function overHtmlAttributesFixture(): MailCapacityFixture {
  const attributes = htmlTokenizerAttributes(270_000, 2_000);
  return policyFailureFixture(
    "over-html-attributes",
    htmlEml("HTML attributes", `<p ${attributes}>attributes</p>`),
    "mime_budget",
  );
}

export function sanitizerOutputExpansionFixture(): MailCapacityFixture {
  const html = Array.from({ length: 9_300 }, resourceExpandingAnchor).join("\n");
  return policyFailureFixture(
    "sanitizer-output-expansion",
    htmlEml("Sanitizer output expansion", html),
    "mime_budget",
  );
}

export function overMessageBudgetFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-message-budget",
    htmlEml("Persisted message expansion", messageBudgetHtml()),
    "message_budget",
  );
}

export function overAttachmentCountFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-attachment-count",
    attachmentCountEml(MAX_ATTACHMENTS + 1),
    "attachment_cap",
  );
}

export function overRfc822DepthFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-rfc822-depth",
    nestedRfc822Eml(INBOUND_MIME_LIMITS.maxRfc822NestingDepth + 1),
    "rfc822_depth",
  );
}

export function overMimeDepthFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-mime-depth",
    nestedMultipartEml(INBOUND_MIME_LIMITS.maxNestingDepth + 1),
    "parse_failed",
  );
}

export function overHtmlInputFixture(): MailCapacityFixture {
  return policyFailureFixture(
    "over-html-input",
    htmlEml("HTML input budget", boundedLineText(MAIL_HTML_PARSE_LIMITS.inputBytes + 1, 16_000)),
    "mime_budget",
  );
}

export function overHtmlNodesFixture(): MailCapacityFixture {
  const groups = Array.from({ length: 20 }, () => "<br>".repeat(1_000));
  return policyFailureFixture(
    "over-html-nodes",
    htmlEml("HTML node budget", groups.join("\n")),
    "mime_budget",
  );
}

export function overHtmlOpenElementsFixture(): MailCapacityFixture {
  const count = MAIL_HTML_PARSE_LIMITS.openElements + 1;
  const html = `${"<div>".repeat(count)}open-elements${"</div>".repeat(count)}`;
  return policyFailureFixture(
    "over-html-open-elements",
    htmlEml("HTML open-element budget", html),
    "mime_budget",
  );
}

export function overHtmlFinalDepthFixture(): MailCapacityFixture {
  const templateCount = MAIL_HTML_PARSE_LIMITS.finalTreeDepth / 2 + 1;
  const html = `${"<template>".repeat(templateCount)}${"</template>".repeat(templateCount)}`;
  return policyFailureFixture(
    "over-html-final-depth",
    htmlEml("HTML final-depth budget", html),
    "mime_budget",
  );
}

export function overHtmlAggregateAttributesFixture(): MailCapacityFixture {
  const attributes = htmlAttributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement);
  const elementCount =
    MAIL_HTML_PARSE_LIMITS.admittedAttributes / MAIL_HTML_PARSE_LIMITS.attributesPerElement + 1;
  const html = Array.from({ length: elementCount }, () => `<p ${attributes}></p>`).join("\n");
  return policyFailureFixture(
    "over-html-aggregate-attributes",
    htmlEml("HTML aggregate-attribute budget", html),
    "mime_budget",
  );
}

export const MAIL_CAPACITY_SUPPORTED_FIXTURES = [
  { id: "many-short-lines", make: manyShortLinesFixture },
  { id: "folded-base64", make: foldedBase64Fixture },
  { id: "padded-base64-lines", make: paddedBase64LinesFixture },
  { id: "padded-base64-units", make: paddedBase64UnitsFixture },
  { id: "quoted-printable", make: quotedPrintableFixture },
  { id: "combined-attachment-html", make: combinedAttachmentHtmlFixture },
  { id: "nested-message", make: nestedMessageFixture },
  { id: "malformed-html", make: malformedHtmlFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

export const MAIL_CAPACITY_REJECTED_FIXTURES = [
  { id: "over-line-length", make: overLineLengthFixture },
  { id: "over-line-count", make: overLineCountFixture },
  { id: "over-headers", make: overHeadersFixture },
  { id: "over-part-count", make: overPartCountFixture },
  { id: "over-references", make: overReferencesFixture },
  { id: "over-mime-depth", make: overMimeDepthFixture },
  { id: "over-rfc822-depth", make: overRfc822DepthFixture },
  { id: "over-text-expansion", make: overTextExpansionFixture },
  { id: "over-html-input", make: overHtmlInputFixture },
  { id: "over-html-nodes", make: overHtmlNodesFixture },
  { id: "over-html-open-elements", make: overHtmlOpenElementsFixture },
  { id: "over-html-final-depth", make: overHtmlFinalDepthFixture },
  { id: "over-html-attributes", make: overHtmlAttributesFixture },
  { id: "over-html-aggregate-attributes", make: overHtmlAggregateAttributesFixture },
  { id: "sanitizer-output-expansion", make: sanitizerOutputExpansionFixture },
  { id: "over-message-budget", make: overMessageBudgetFixture },
  { id: "over-attachment-count", make: overAttachmentCountFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

export const MAIL_CAPACITY_INBOUND_REJECTED_FIXTURES = [
  { id: "over-raw-size", make: overRawSizeFixture },
] as const satisfies ReadonlyArray<MailCapacityInboundRejectedFixtureFactory>;

export const MAIL_CAPACITY_ENCODED_MAXIMUM_FIXTURES = [
  { id: "maximum-raw-folded-base64", make: maximumRawFoldedBase64Fixture },
  { id: "maximum-raw-quoted-printable", make: maximumRawQuotedPrintableFixture },
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

export const MAIL_CAPACITY_LARGE_SEQUENCE_FIXTURES = [
  { id: "maximum-raw-sequence-01", make: () => maximumRawSequenceFixture("01") },
  { id: "maximum-raw-sequence-02", make: () => maximumRawSequenceFixture("02") },
  { id: "maximum-raw-sequence-03", make: () => maximumRawSequenceFixture("03") },
  ...MAIL_CAPACITY_ENCODED_MAXIMUM_FIXTURES,
] as const satisfies ReadonlyArray<MailCapacityFixtureFactory>;

export function encodeEml(value: string): Uint8Array {
  return new TextEncoder().encode(value.replaceAll("\n", "\r\n"));
}

export function plainTextEml(body: string): Uint8Array {
  return plainTextMessageEml("Plain text", body);
}

export function newlineHeavyEml(lineCount: number): Uint8Array {
  const header = encodeEml(
    [...baseHeaders("Newline budget"), "Content-Type: text/plain; charset=utf-8", "", ""].join(
      "\n",
    ),
  );
  const raw = new Uint8Array(header.byteLength + lineCount);
  raw.set(header);
  raw.fill(0x0a, header.byteLength);
  return raw;
}

export function manyShortLinesEml(lineCount: number): Uint8Array {
  const marker = encodeEml(
    [
      ...baseHeaders("Many short lines"),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "short-line-marker",
      "",
    ].join("\n"),
  );
  const line = Uint8Array.of(0x78, 0x0d, 0x0a);
  const raw = new Uint8Array(marker.byteLength + line.byteLength * lineCount);
  raw.set(marker);
  let offset = marker.byteLength;
  for (let index = 0; index < lineCount; index++) {
    raw.set(line, offset);
    offset += line.byteLength;
  }
  return raw;
}

export function partCountEml(partCount: number): Uint8Array {
  const childCount = Math.max(0, partCount - 1);
  const lines = [
    ...baseHeaders("Part budget"),
    'Content-Type: multipart/mixed; boundary="part-boundary"',
    "",
  ];
  for (let index = 0; index < childCount; index++) {
    lines.push(
      "--part-boundary",
      "Content-Type: text/plain",
      `Content-Disposition: attachment; filename="part-${String(index)}.txt"`,
      "",
      `part-${String(index)}`,
    );
  }
  lines.push("--part-boundary--", "");
  return encodeEml(lines.join("\n"));
}

export function referencesEml(referenceBytes: number): Uint8Array {
  const token = "<id@example.com> ";
  const count = Math.ceil(referenceBytes / token.length) + 1;
  const folded = Array.from({ length: count }, (_, index) =>
    index === 0 ? `References: ${token}` : ` ${token}`,
  );
  return encodeEml(
    [
      ...baseHeaders("References budget"),
      ...folded,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
      "",
    ].join("\n"),
  );
}

export function paddedBase64LinesEml(unitCount: number): Uint8Array {
  const header = attachmentHeaders("Padded base64 lines", "base64", "padded-lines.bin");
  const unit = new TextEncoder().encode("YQ==\r\n");
  const raw = new Uint8Array(header.byteLength + unit.byteLength * unitCount);
  raw.set(header);
  let offset = header.byteLength;
  for (let index = 0; index < unitCount; index++) {
    raw.set(unit, offset);
    offset += unit.byteLength;
  }
  return raw;
}

export function paddedBase64UnitsEml(unitCount: number): Uint8Array {
  return encodeEml(
    [
      ...baseHeaders("Padded base64 units"),
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="padded-units.bin"',
      "",
      "YQ==".repeat(unitCount),
      "",
    ].join("\n"),
  );
}

export function foldedBase64AttachmentEml(tripletCount: number): Uint8Array {
  const encoded = "AAEC".repeat(tripletCount);
  return encodeEml(
    [
      ...baseHeaders("Folded base64"),
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="folded.bin"',
      "",
      ...fold(encoded, 76),
      "",
    ].join("\n"),
  );
}

export function quotedPrintableAttachmentEml(unitCount: number): Uint8Array {
  const lines = Array.from({ length: unitCount }, () => "capacity=3Dunit=");
  return encodeEml(
    [
      ...baseHeaders("Quoted printable"),
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: quoted-printable",
      'Content-Disposition: attachment; filename="quoted-printable.bin"',
      "",
      ...lines,
      "done",
      "",
    ].join("\n"),
  );
}

export function combinedAttachmentHtmlEml(tripletCount: number): Uint8Array {
  const encoded = "AAEC".repeat(tripletCount);
  const htmlLines = Array.from(
    { length: 5_000 },
    (_, index) => `<p>combined-capacity-marker ${String(index)}</p>`,
  );
  return encodeEml(
    [
      ...baseHeaders("Combined attachment and HTML"),
      'Content-Type: multipart/related; boundary="combined-boundary"',
      "",
      "--combined-boundary",
      "Content-Type: text/html; charset=utf-8",
      "",
      ...htmlLines,
      '<img src="https://tracker.example/pixel"><img src="cid:combined@umail">',
      "--combined-boundary",
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: inline; filename="combined.bin"',
      "Content-ID: <combined@umail>",
      "",
      ...fold(encoded, 76),
      "--combined-boundary--",
      "",
    ].join("\n"),
  );
}

export function nestedRfc822Eml(depth: number): Uint8Array {
  let message = [
    `From: ${MAIL_CAPACITY_SENDER}`,
    `To: ${MAIL_CAPACITY_INBOX}`,
    "Subject: RFC822 leaf",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "nested-capacity-marker",
  ].join("\n");
  for (let level = 0; level < depth; level++) {
    message = [
      `From: ${MAIL_CAPACITY_SENDER}`,
      `To: ${MAIL_CAPACITY_INBOX}`,
      `Subject: RFC822 level ${String(level)}`,
      "MIME-Version: 1.0",
      "Content-Type: message/rfc822",
      "Content-Disposition: inline",
      "",
      message,
    ].join("\n");
  }
  return encodeEml(`${message}\n`);
}

export function sizedAttachmentEml(
  totalBytes: number,
  textMarker = "maximum raw marker",
  subject = "Maximum raw attachment",
): Uint8Array {
  const header = encodeEml(
    [
      ...baseHeaders(subject),
      'Content-Type: multipart/mixed; boundary="maximum-boundary"',
      "",
      "--maximum-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      textMarker,
      "--maximum-boundary",
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="maximum.bin"',
      "",
      "",
    ].join("\n"),
  );
  const footer = encodeEml("--maximum-boundary--\n");
  const raw = new Uint8Array(totalBytes);
  raw.set(header);
  const bodyBytes = totalBytes - header.byteLength - footer.byteLength;
  const lineCount = Math.ceil(bodyBytes / 78);
  let remainingContentBytes = bodyBytes - lineCount * 2;
  let offset = header.byteLength;
  for (let index = 0; index < lineCount; index++) {
    const contentBytes = Math.min(76, remainingContentBytes);
    raw.fill(0x78, offset, offset + contentBytes);
    offset += contentBytes;
    raw[offset] = 0x0d;
    raw[offset + 1] = 0x0a;
    offset += 2;
    remainingContentBytes -= contentBytes;
  }
  raw.set(footer, offset);
  return raw;
}

function sizedTransferEncodedAttachmentEml(
  totalBytes: number,
  subject: string,
  transferEncoding: MailCapacityTransferEncoding,
  filename: string,
  encodedLine: string,
  lineCount: number,
): Uint8Array {
  const emptyPaddingHeader = encodeEml(
    [
      ...baseHeaders(subject),
      "Content-Type: application/octet-stream",
      `Content-Transfer-Encoding: ${transferEncoding}`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "X-Capacity-Pad: ",
      "",
      "",
    ].join("\n"),
  );
  const bodyLine = encodeEml(`${encodedLine}\n`);
  const paddingBytes = totalBytes - emptyPaddingHeader.byteLength - bodyLine.byteLength * lineCount;
  const maximumPaddingBytes = INBOUND_MIME_LIMITS.maxLineLength - "X-Capacity-Pad: ".length;
  if (paddingBytes < 0 || paddingBytes > maximumPaddingBytes) {
    throw new Error("Capacity transfer-encoding padding does not fit one admitted header line.");
  }
  const header = encodeEml(
    [
      ...baseHeaders(subject),
      "Content-Type: application/octet-stream",
      `Content-Transfer-Encoding: ${transferEncoding}`,
      `Content-Disposition: attachment; filename="${filename}"`,
      `X-Capacity-Pad: ${"x".repeat(paddingBytes)}`,
      "",
      "",
    ].join("\n"),
  );
  const raw = new Uint8Array(totalBytes);
  raw.set(header);
  let offset = header.byteLength;
  for (let index = 0; index < lineCount; index += 1) {
    raw.set(bodyLine, offset);
    offset += bodyLine.byteLength;
  }
  if (offset !== totalBytes) {
    throw new Error("Capacity transfer-encoded fixture did not reach its exact raw size.");
  }
  return raw;
}

export function headerSizedEml(headerBytes: number): Uint8Array {
  const fixed = [
    `From: ${MAIL_CAPACITY_SENDER}`,
    `To: ${MAIL_CAPACITY_INBOX}`,
    "Subject: Header boundary",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  const fixedBytes = fixed.reduce((total, line) => total + utf8Bytes(line), 0);
  return encodeEml(
    [...fixed, ...headerPadLines(headerBytes - fixedBytes), "", "body", ""].join("\n"),
  );
}

export function nestedMultipartEml(maximumDepth: number): Uint8Array {
  const lines = [
    `From: ${MAIL_CAPACITY_SENDER}`,
    `To: ${MAIL_CAPACITY_INBOX}`,
    "Subject: MIME depth",
    "MIME-Version: 1.0",
  ];
  appendMimeNode(lines, 0, maximumDepth);
  return encodeEml([...lines, ""].join("\n"));
}

export function attachmentCountEml(count: number): Uint8Array {
  const lines = [
    ...baseHeaders("Attachment count"),
    'Content-Type: multipart/mixed; boundary="attachment-boundary"',
    "",
    "--attachment-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ];
  for (let index = 0; index < count; index++) {
    lines.push(
      "--attachment-boundary",
      "Content-Type: text/plain",
      `Content-Disposition: attachment; filename="part-${String(index)}.txt"`,
      "",
      `part-${String(index)}`,
    );
  }
  lines.push("--attachment-boundary--", "");
  return encodeEml(lines.join("\n"));
}

function htmlEml(subject: string, html: string): Uint8Array {
  return encodeEml(
    [...baseHeaders(subject), "Content-Type: text/html; charset=utf-8", "", html, ""].join("\n"),
  );
}

function plainTextMessageEml(subject: string, body: string): Uint8Array {
  return encodeEml(
    [...baseHeaders(subject), "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\n"),
  );
}

function textExpansionEml(bodyBytes: number): Uint8Array {
  const line = "x".repeat(76);
  const lineCount = Math.floor(bodyBytes / line.length);
  const remainder = bodyBytes - lineCount * line.length;
  return encodeEml(
    [
      ...baseHeaders("Text expansion"),
      'Content-Type: multipart/mixed; boundary="text-expansion-boundary"',
      "",
      "--text-expansion-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      ...Array.from({ length: lineCount }, () => line),
      "x".repeat(remainder),
      "--text-expansion-boundary",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>alternative</p>",
      "--text-expansion-boundary--",
      "",
    ].join("\n"),
  );
}

function policyFailureFixture(
  id: string,
  raw: Uint8Array,
  reason: MailCapacityPolicyFailureReason,
): MailCapacityFixture {
  return { id, raw, expected: { kind: "policy_failed", reason } };
}

function baseHeaders(subject: string): string[] {
  return [
    `From: ${MAIL_CAPACITY_SENDER}`,
    `To: ${MAIL_CAPACITY_INBOX}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];
}

function attachmentHeaders(
  subject: string,
  transferEncoding: string,
  filename: string,
): Uint8Array {
  return encodeEml(
    [
      ...baseHeaders(subject),
      "Content-Type: application/octet-stream",
      `Content-Transfer-Encoding: ${transferEncoding}`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      "",
    ].join("\n"),
  );
}

function fold(value: string, width: number): ReadonlyArray<string> {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width));
  }
  return lines;
}

function headerPadLines(targetBytes: number): string[] {
  const maxPhysical = Math.min(76, INBOUND_MIME_LIMITS.maxLineLength);
  const lines: string[] = [];
  let remaining = targetBytes;
  while (remaining > 0) {
    const prefix = lines.length === 0 ? "X-Pad: " : " ";
    const lineLength = Math.min(maxPhysical, remaining);
    if (lineLength <= prefix.length) {
      const previous = lines.at(-1);
      if (previous === undefined) {
        lines.push("x".repeat(lineLength));
      } else {
        lines[lines.length - 1] = previous + "x".repeat(lineLength);
      }
      break;
    }
    lines.push(`${prefix}${"x".repeat(lineLength - prefix.length)}`);
    remaining -= lineLength;
  }
  return lines;
}

function appendMimeNode(lines: string[], depth: number, maximumDepth: number): void {
  if (depth === maximumDepth) {
    lines.push("Content-Type: text/plain; charset=utf-8", "", "body");
    return;
  }
  const boundary = `depth-${String(depth)}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`);
  appendMimeNode(lines, depth + 1, maximumDepth);
  lines.push(`--${boundary}--`);
}

function htmlAttributes(count: number): string {
  return Array.from({ length: count }, (_, index) => `data-a${String(index)}=x`).join(" ");
}

function htmlTokenizerAttributes(count: number, attributesPerLine: number): string {
  return Array.from({ length: Math.ceil(count / attributesPerLine) }, (_, lineIndex) => {
    const start = lineIndex * attributesPerLine;
    const lineCount = Math.min(attributesPerLine, count - start);
    return Array.from({ length: lineCount }, (_, index) => `a${String(start + index)}`).join(" ");
  }).join("\n");
}

function resourceExpandingAnchor(): string {
  return '<a href="https://example.test/open" title="x" aria-hidden="true" aria-label="x" dir="ltr" lang="en" role="link">open</a>';
}

function boundedLineText(totalBytes: number, lineLength: number): string {
  const fullLines = Math.floor(totalBytes / lineLength);
  const remainder = totalBytes - fullLines * lineLength;
  return [
    ...Array.from({ length: fullLines }, () => "x".repeat(lineLength)),
    "x".repeat(remainder),
  ].join("\n");
}

function messageBudgetHtml(): string {
  const lineLength = 16_000;
  const lineCount = Math.floor(MAX_PERSISTED_MESSAGE_BYTES / lineLength);
  const remainder = MAX_PERSISTED_MESSAGE_BYTES - lineCount * lineLength;
  return [
    "<pre>",
    ...Array.from({ length: lineCount }, () => "x".repeat(lineLength)),
    "x".repeat(remainder),
    "</pre>",
  ].join("\n");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
