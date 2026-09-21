import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineConfig } from "vitest/config";

const CapacityRunId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{6,30}[a-z0-9])$/),
);

function requiredCapacityEnvironment<S extends Schema.Decoder<unknown>>(
  name: string,
  schema: S,
): S["Type"] {
  const configured = Effect.runSync(Config.option(Config.string(name)));
  if (Option.isNone(configured)) {
    throw new Error(`Live mail capacity requires a valid ${name}.`);
  }
  const decoded = Schema.decodeResult(schema)(configured.value);
  if (Result.isFailure(decoded)) {
    throw new Error(`Live mail capacity requires a valid ${name}.`);
  }
  return decoded.success;
}

function capacityCleanupOnly(): boolean {
  const configured = Effect.runSync(
    Config.option(Config.string("UMAIL_MAIL_CAPACITY_CLEANUP_ONLY")),
  );
  if (Option.isNone(configured)) return false;
  const decoded = Schema.decodeUnknownResult(Schema.Literal("1"))(configured.value);
  if (Result.isFailure(decoded)) {
    throw new Error("UMAIL_MAIL_CAPACITY_CLEANUP_ONLY must be exactly 1 when set.");
  }
  return true;
}

if (Option.isSome(Effect.runSync(Config.option(Config.string("ALCHEMY_TEST_DEV"))))) {
  throw new Error("Live mail capacity rejects ALCHEMY_TEST_DEV; it must use Cloudflare.");
}

requiredCapacityEnvironment("UMAIL_MAIL_CAPACITY_LIVE", Schema.Literal("1"));

export const mailCapacityEnvironment = {
  runId: requiredCapacityEnvironment("UMAIL_MAIL_CAPACITY_RUN_ID", CapacityRunId),
  controlToken: requiredCapacityEnvironment(
    "UMAIL_MAIL_CAPACITY_CONTROL_TOKEN",
    Schema.String.check(Schema.isMinLength(32)),
  ),
  accountId: requiredCapacityEnvironment(
    "CLOUDFLARE_ACCOUNT_ID",
    Schema.String.check(Schema.isMinLength(1)),
  ),
  apiToken: requiredCapacityEnvironment(
    "CLOUDFLARE_API_TOKEN",
    Schema.String.check(Schema.isMinLength(1)),
  ),
  cleanupOnly: capacityCleanupOnly(),
} as const;

export default defineConfig({
  test: {
    include: ["tests/mail-capacity.live.spec.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    hookTimeout: 30 * 60 * 1000,
    testTimeout: 30 * 60 * 1000,
  },
});
