import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

import { INBOUND_MIME_LIMITS } from "../../src/mail/policy.ts";

const require = createRequire(import.meta.url);
const PostalMimeCommonJs = require("postal-mime") as typeof PostalMime;

const PARSERS = [
  { label: "ESM", parser: PostalMime },
  { label: "CommonJS", parser: PostalMimeCommonJs },
] as const;

describe.each(PARSERS)("PostalMime $label decoded-byte accumulation", ({ parser }) => {
  it.each(["\n", "\r\n"] as const)(
    "normalizes %j pass-through input while preserving empty and final lines",
    async (lineEnding) => {
      const decoded = await parseAttachment(
        parser,
        attachmentEml("8bit", ["alpha", "", "omega"], lineEnding, false),
      );

      expect(decoded).toEqual(new TextEncoder().encode("alpha\n\nomega\n"));
      expect(sha256Hex(decoded)).toBe(
        "ab8d35cf232afde3151ce6ce55e0661be0e7961c8652a75eb540ddc53d7f56d2",
      );
    },
  );

  it("decodes 76-character folded base64 across remainder and accumulator blocks", async () => {
    const expected = deterministicBytes(2 * 64 * 1024 + 257);
    const base64 = Buffer.from(expected).toString("base64");
    const decoded = await parseAttachment(parser, attachmentEml("base64", fold(base64, 76)));

    expect(decoded.byteLength).toBe(expected.byteLength);
    expect(sha256Hex(decoded)).toBe(
      "03b719ae76592395a0d7e3f844587179007e6e2b2e4dd5f9e5fc52dcc3d800df",
    );
    expect(decoded).toEqual(expected);
  });

  it("preserves separately padded base64 units on each line", async () => {
    const lines = Array.from({ length: 20_000 }, () => "YWJjZA==");
    const decoded = await parseAttachment(parser, attachmentEml("base64", lines));

    expect(decoded.byteLength).toBe(80_000);
    expect(sha256Hex(decoded)).toBe(
      "f5a13eed1b76e1a62df7edc7ddc175664b781544020a59d42d8c7786b84fd38f",
    );
  });

  it("preserves many padded base64 units within one permitted line", async () => {
    const decoded = await parseAttachment(
      parser,
      attachmentEml("base64", ["YQ==".repeat(INBOUND_MIME_LIMITS.maxLineLength / 4)]),
    );

    expect(decoded.byteLength).toBe(4_096);
    expect(sha256Hex(decoded)).toBe(
      "c93eee2d0db02f10acc7460d9576e122dcf8cd53c4bf8dfcae1b3e74ebcfff5a",
    );
    expect(decoded).toEqual(new Uint8Array(4_096).fill(0x61));
  });

  it("preserves quoted-printable escapes, invalid escapes, and soft breaks at a block boundary", async () => {
    const lines = [...softWrapped("a".repeat(65_534), 75), "aa=42=G1=", "tail"];
    const decoded = await parseAttachment(parser, attachmentEml("quoted-printable", lines));
    const expected = new TextEncoder().encode(`${"a".repeat(65_536)}B=G1tail\n`);

    expect(decoded.byteLength).toBe(65_545);
    expect(sha256Hex(decoded)).toBe(
      "555dfdae0f13ac8d4e4a662b92581e7da27da09b7f9863410a266f50eb981434",
    );
    expect(decoded).toEqual(expected);
  });

  it("retains attachment bytes while decoding nested message/rfc822 content", async () => {
    const nested = attachmentEml("base64", ["AAECf4D+/w=="]);
    const outer = messageBytes(
      [
        "From: outer@example.com",
        "To: inbox@example.com",
        "Subject: Outer",
        "MIME-Version: 1.0",
        "Content-Type: message/rfc822",
        "Content-Disposition: inline",
        "",
        new TextDecoder().decode(nested),
      ].join("\r\n"),
    );
    const decoded = await parseAttachment(parser, outer);

    expect(decoded).toEqual(Uint8Array.of(0, 1, 2, 127, 128, 254, 255));
    expect(sha256Hex(decoded)).toBe(
      "7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d",
    );
  });
});

async function parseAttachment(parser: typeof PostalMime, raw: Uint8Array): Promise<Uint8Array> {
  return parseFirstAttachment(parser, raw.slice().buffer);
}

async function parseFirstAttachment(
  parser: typeof PostalMime,
  raw: ArrayBuffer,
): Promise<Uint8Array> {
  const parsed = await parser.parse(raw, {
    attachmentEncoding: "arraybuffer",
    ...INBOUND_MIME_LIMITS,
  });
  const attachment = parsed.attachments[0];
  if (attachment === undefined) {
    throw new Error("expected decoded attachment");
  }
  if (!(attachment.content instanceof ArrayBuffer)) {
    throw new Error("expected ArrayBuffer attachment content");
  }
  return new Uint8Array(attachment.content);
}

function attachmentEml(
  transferEncoding: "8bit" | "base64" | "quoted-printable",
  bodyLines: ReadonlyArray<string>,
  lineEnding = "\r\n",
  finalLineEnding = true,
): Uint8Array {
  const message = [
    "From: sender@example.com",
    "To: inbox@example.com",
    "Subject: Decoder fixture",
    "MIME-Version: 1.0",
    "Content-Type: application/octet-stream",
    `Content-Transfer-Encoding: ${transferEncoding}`,
    'Content-Disposition: attachment; filename="fixture.bin"',
    "",
    ...bodyLines,
  ].join(lineEnding);
  return messageBytes(finalLineEnding ? `${message}${lineEnding}` : message);
}

function messageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}

function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  return bytes;
}

function fold(value: string, width: number): ReadonlyArray<string> {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width));
  }
  return lines;
}

function softWrapped(value: string, width: number): ReadonlyArray<string> {
  return fold(value, width).map((line) => `${line}=`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
