import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ListMessagesQuery } from "../src/api-spec.ts";
import { parseUtcInstant } from "../src/query-instant.ts";

describe("UTC instant query contract", () => {
  it("normalizes offset timestamps and rejects malformed or overflow dates", () => {
    expect(parseUtcInstant("2026-01-01T01:00:00+02:00")).toBe("2025-12-31T23:00:00.000Z");
    expect(parseUtcInstant("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(parseUtcInstant("not-a-date")).toBeNull();
    expect(parseUtcInstant("+275760-09-13T00:00:00.000Z")).toBeNull();

    const decoded = Schema.decodeUnknownResult(ListMessagesQuery)({
      since: "2026-01-01T02:00:00+01:00",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.since).toBe("2026-01-01T01:00:00.000Z");
    expect(Result.isFailure(Schema.decodeUnknownResult(ListMessagesQuery)({ since: "nope" }))).toBe(
      true,
    );
  });
});
