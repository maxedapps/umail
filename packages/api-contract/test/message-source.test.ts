import { describe, expect, it } from "vitest";

import { headerBlock, MAX_HEADER_BLOCK_BYTES } from "../src/message-source.ts";

const BODY_SENTINEL = "BODY-SENTINEL";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("headerBlock boundary", () => {
  it("splits at a CRLF empty line", () => {
    const result = headerBlock(bytes(`From: a@example.com\r\nSubject: hi\r\n\r\n${BODY_SENTINEL}`));

    expect(result).toEqual({
      headers: "From: a@example.com\r\nSubject: hi\r\n",
      truncated: false,
    });
    expect(result.headers).not.toContain(BODY_SENTINEL);
  });

  it("splits at a bare LF empty line", () => {
    const result = headerBlock(bytes(`From: a@example.com\nSubject: hi\n\n${BODY_SENTINEL}`));

    expect(result.headers).toBe("From: a@example.com\nSubject: hi\n");
    expect(result.headers).not.toContain(BODY_SENTINEL);
  });

  it("splits at an LF followed by a CRLF empty line", () => {
    const result = headerBlock(bytes(`From: a@example.com\n\r\n${BODY_SENTINEL}`));

    expect(result.headers).toBe("From: a@example.com\n");
    expect(result.headers).not.toContain(BODY_SENTINEL);
  });

  it.each(["\n", "\r\n"])(
    "yields an empty header block for a source opening with %j",
    (opening) => {
      const result = headerBlock(bytes(`${opening}From: a@example.com\r\n\r\n${BODY_SENTINEL}`));

      expect(result).toEqual({ headers: "", truncated: false });
      expect(result.headers).not.toContain(BODY_SENTINEL);
    },
  );

  it("treats a line of only carriage returns as the empty line", () => {
    const result = headerBlock(bytes(`From: a@example.com\r\n\r\r\n${BODY_SENTINEL}`));

    expect(result.headers).toBe("From: a@example.com\r\n");
  });

  it("does not split on an LF pair inside a CRLF body", () => {
    const result = headerBlock(
      bytes(`From: a@example.com\r\n\r\nfirst\n\nsecond\r\n\r\n${BODY_SENTINEL}`),
    );

    expect(result.headers).toBe("From: a@example.com\r\n");
  });

  it("returns the whole input as headers when there is no empty line", () => {
    const source = "From: a@example.com\r\nSubject: hi\r\n";

    expect(headerBlock(bytes(source))).toEqual({ headers: source, truncated: false });
  });

  it("returns an empty block for empty input", () => {
    expect(headerBlock(new Uint8Array())).toEqual({ headers: "", truncated: false });
  });

  it("keeps a leading byte order mark in the decoded headers", () => {
    const result = headerBlock(
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(`From: a@example.com\r\n\r\n${BODY_SENTINEL}`)]),
    );

    expect(result.headers).toBe("\uFEFFFrom: a@example.com\r\n");
  });
});

describe("headerBlock byte budget", () => {
  const probe = "é";
  const probeBytes = bytes(probe).length;
  const prefix = "X-Pad: ";

  it("returns a block of exactly the budget untruncated", () => {
    const fill = "a".repeat(MAX_HEADER_BLOCK_BYTES - prefix.length - probeBytes);
    const headers = `${prefix}${fill}${probe}`;
    expect(bytes(headers).length).toBe(MAX_HEADER_BLOCK_BYTES);

    expect(headerBlock(bytes(headers))).toEqual({ headers, truncated: false });
  });

  it("measures the located block, not the whole source", () => {
    const fill = "a".repeat(MAX_HEADER_BLOCK_BYTES - prefix.length - "\r\n".length);
    const headers = `${prefix}${fill}\r\n`;
    const source = `${headers}\r\n${"b".repeat(MAX_HEADER_BLOCK_BYTES)}`;

    expect(headerBlock(bytes(source))).toEqual({ headers, truncated: false });
  });

  it("truncates one byte over the budget by bytes, splitting the multibyte probe", () => {
    const fill = "a".repeat(MAX_HEADER_BLOCK_BYTES - prefix.length - probeBytes + 1);
    const result = headerBlock(bytes(`${prefix}${fill}${probe}`));

    expect(result.truncated).toBe(true);
    expect(result.headers).toBe(`${prefix}${fill}\uFFFD`);
  });
});
