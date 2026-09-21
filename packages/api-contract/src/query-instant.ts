import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseUtcInstant(raw: string): string | null {
  const parsed = DateTime.make(raw);
  if (Option.isNone(parsed)) {
    return null;
  }
  const utc = DateTime.toUtc(parsed.value);
  if (!Number.isFinite(DateTime.toEpochMillis(utc))) {
    return null;
  }
  const year = DateTime.toPartsUtc(utc).year;
  if (year < 1 || year > 9999) {
    return null;
  }
  const iso = DateTime.formatIso(utc);
  if (!CANONICAL_UTC_INSTANT.test(iso)) {
    return null;
  }
  return iso;
}

export const UtcInstant = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transformOrFail((raw: string) => {
      const instant = parseUtcInstant(raw);
      if (instant === null) {
        return Effect.fail(new SchemaIssue.InvalidValue({ message: "Invalid UTC instant" }));
      }
      return Effect.succeed(instant);
    }),
    encode: SchemaGetter.passthrough(),
  }),
);
export type UtcInstant = typeof UtcInstant.Type;
