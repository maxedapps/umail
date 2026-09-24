import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vitest";

import { ApprovalToken, ApprovalTokenHash } from "../src/index.ts";

describe("approval capability domains", () => {
  it("accepts only exact lowercase 32-byte hexadecimal tokens and hashes", () => {
    const token = Schema.decodeSync(ApprovalToken)("a".repeat(64));
    const hash = Schema.decodeSync(ApprovalTokenHash)("b".repeat(64));
    expect(token).toHaveLength(64);
    expect(hash).toHaveLength(64);
    for (const schema of [ApprovalToken, ApprovalTokenHash]) {
      expect(() => Schema.decodeSync(schema)("a".repeat(63))).toThrow();
      expect(() => Schema.decodeSync(schema)("A".repeat(64))).toThrow();
      expect(() => Schema.decodeSync(schema)(`${"a".repeat(63)}g`)).toThrow();
    }
  });

  it("keeps plaintext capabilities and persisted hashes noninterchangeable", () => {
    expectTypeOf<ApprovalToken>().not.toEqualTypeOf<ApprovalTokenHash>();
  });
});
