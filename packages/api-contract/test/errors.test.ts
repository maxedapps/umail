import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ApiError, Conflict, NotFound, NotPermitted } from "../src/errors.ts";

describe("API errors", () => {
  it("round-trip with their code and message, and decode codes the client does not know", () => {
    const error = new NotPermitted({
      code: "recipient_not_allowed",
      message: "Recipients not allowed for this client: a@example.com.",
    });
    const encoded = Schema.encodeSync(ApiError)(error);
    expect(encoded).toEqual({
      _tag: "NotPermitted",
      code: "recipient_not_allowed",
      message: "Recipients not allowed for this client: a@example.com.",
    });
    expect(Schema.decodeSync(ApiError)(encoded)).toEqual(error);

    const newer = Schema.decodeSync(ApiError)({
      _tag: "Conflict",
      code: "a_code_added_later",
      message: "Something newer.",
    });
    expect(newer).toBeInstanceOf(Conflict);
    expect(newer.message).toBe("Something newer.");
  });

  it("are Errors whose message is the sentence a person reads", () => {
    const error = new NotFound({ code: "job_not_found", message: "Job j1 was not found." });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Job j1 was not found.");
  });
});
