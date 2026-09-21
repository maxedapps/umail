import * as Schema from "effect/Schema";

export type AccountSqlValue = ArrayBuffer | string | number | null;

export type AccountSqlRow = {
  readonly [column: string]: AccountSqlValue;
};

export interface AccountSqlCursor {
  toArray(): ReadonlyArray<AccountSqlRow>;
}

export interface AccountSql {
  exec(query: string, ...bindings: ReadonlyArray<AccountSqlValue>): AccountSqlCursor;
}

export interface AccountSqliteStorage {
  transactionSync<T>(closure: () => T): T;
  readonly sql: AccountSql;
}

const JsonStringArray = Schema.Array(Schema.String);

export function firstDecoded<A>(
  decode: (row: unknown) => A,
  rows: ReadonlyArray<AccountSqlRow>,
): A | undefined {
  const row = rows[0];
  if (row === undefined) return undefined;
  return decode(row);
}

export function bindJsonStringArray(values: ReadonlyArray<string>): string {
  return JSON.stringify(Schema.decodeSync(JsonStringArray)(values));
}
