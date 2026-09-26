import { isUserFacing } from "alchemy/UserFacingError";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";

import { evaluateApplication } from "./stack-fixture.ts";

// alchemy runs an Action's init once per process, so the password check is observable only in a
// module that has not evaluated the stack before; hence this file of its own.
describe("deploy configuration errors", () => {
  // alchemy prints a defect marked UserFacingError as the one line "error: <message>".
  const deployError = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(evaluateApplication("prod", env));
      if (Exit.isSuccess(exit)) return yield* Effect.die("Expected the stack evaluation to fail");
      const defect = Cause.squash(exit.cause);
      expect(isUserFacing(defect)).toBe(true);
      return defect instanceof Error ? defect.message : String(defect);
    });

  it.effect("fails at evaluation with one line naming the variable", () =>
    Effect.gen(function* () {
      expect(yield* deployError({ UMAIL_OPERATOR_PASSWORD: "short" })).toBe(
        "UMAIL_OPERATOR_PASSWORD must be at least 12 characters.",
      );
      expect(yield* deployError({ UMAIL_DOMAIN: "https://umail.example.com" })).toBe(
        "UMAIL_DOMAIN must be a hostname like mail.example.com (no scheme, path or port).",
      );
      expect(yield* deployError({ UMAIL_DOMAIN: "" })).toBe(
        "UMAIL_DOMAIN is missing. Set it in .env.",
      );
    }),
  );
});
