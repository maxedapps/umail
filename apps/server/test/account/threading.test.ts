import { describe, expect, it } from "vitest";

import {
  THREADING_REFERENCE_LIMIT,
  normalizeThreadingHeaders,
} from "../../src/account/threading.ts";

describe("threading header normalization", () => {
  it("drops malformed RFC tokens while preserving case-sensitive ids", () => {
    const headers = normalizeThreadingHeaders(
      "<Own@example.com>",
      "not-an-id",
      "<First@example.com> <first@example.com> <<<broken@example.com>",
    );
    expect(headers.rfcMessageId).toBe("<Own@example.com>");
    expect(headers.inReplyTo).toBeNull();
    expect(headers.references).toEqual(["<First@example.com>", "<first@example.com>"]);
  });

  it("keeps the newest 128 References, oldest first", () => {
    const ids = Array.from({ length: 130 }, (_, index) => `<ref-${String(index)}@example.com>`);
    const headers = normalizeThreadingHeaders(null, null, ids.join(" "));
    expect(THREADING_REFERENCE_LIMIT).toBe(128);
    expect(headers.references).toHaveLength(128);
    expect(headers.references[0]).toBe("<ref-2@example.com>");
    expect(headers.references[127]).toBe("<ref-129@example.com>");
  });
});
