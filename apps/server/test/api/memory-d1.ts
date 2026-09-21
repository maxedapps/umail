import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

export type QueryRow = {
  readonly [column: string]: string | number | null;
};

export class MemoryD1 {
  readonly #sqlite = new DatabaseSync(":memory:");
  writeCount = 0;

  applyMigration(sql: string): void {
    this.#sqlite.exec(sql);
  }

  prepare(query: string): MemoryStatement {
    return new MemoryStatement(this.#sqlite, query, [], () => {
      this.writeCount += 1;
    });
  }

  async all(query: string, ...params: ReadonlyArray<string | number | null>): Promise<QueryRow[]> {
    const result = await this.prepare(query)
      .bind(...params)
      .all();
    return result.results;
  }

  run(query: string, ...params: ReadonlyArray<string | number | null>): void {
    this.#sqlite.prepare(query).run(...params.map(toSqlValue));
  }

  async batch(statements: MemoryStatement[]): Promise<MemoryD1Result[]> {
    this.#sqlite.exec("BEGIN");
    try {
      const results: MemoryD1Result[] = [];
      for (const statement of statements) {
        results.push(await statement.all());
      }
      this.#sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.#sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(): MemoryD1 {
    return this;
  }

  getBookmark(): string | null {
    return null;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

export class MemoryStatement {
  readonly sqlite: DatabaseSync;
  readonly query: string;
  readonly params: ReadonlyArray<SQLInputValue>;
  readonly recordWrite: () => void;

  constructor(
    sqlite: DatabaseSync,
    query: string,
    params: ReadonlyArray<SQLInputValue> = [],
    recordWrite: () => void = () => undefined,
  ) {
    this.sqlite = sqlite;
    this.query = query;
    this.params = params;
    this.recordWrite = recordWrite;
  }

  bind(...values: ReadonlyArray<string | number | null | unknown>): MemoryStatement {
    return new MemoryStatement(this.sqlite, this.query, values.map(toSqlValue), this.recordWrite);
  }

  async first(): Promise<QueryRow | null> {
    const row = this.sqlite.prepare(this.query).get(...this.params);
    if (row === undefined) return null;
    return toJsRow(row);
  }

  async all(): Promise<MemoryD1Result> {
    if (isSelect(this.query)) {
      const results = this.sqlite
        .prepare(this.query)
        .all(...this.params)
        .map(toJsRow);
      return { success: true, meta: emptyMeta(), results };
    }
    this.recordWrite();
    if (hasReturning(this.query)) {
      const results = this.sqlite
        .prepare(this.query)
        .all(...this.params)
        .map(toJsRow);
      return { success: true, meta: emptyMeta(), results };
    }
    const info = this.sqlite.prepare(this.query).run(...this.params);
    return { success: true, meta: metaFromRun(info), results: [] };
  }

  async run(): Promise<MemoryD1Result> {
    this.recordWrite();
    const info = this.sqlite.prepare(this.query).run(...this.params);
    return { success: true, meta: metaFromRun(info), results: [] };
  }

  async raw(options: {
    columnNames: true;
  }): Promise<[string[], ...Array<Array<string | number | null>>]>;
  async raw(options?: { columnNames?: false }): Promise<Array<Array<string | number | null>>>;
  async raw(options?: {
    columnNames?: boolean;
  }): Promise<
    [string[], ...Array<Array<string | number | null>>] | Array<Array<string | number | null>>
  > {
    const statement = this.sqlite.prepare(this.query);
    if (!isSelect(this.query)) {
      statement.run(...this.params);
      return [];
    }
    const rows = statement.all(...this.params);
    const names = statement.columns().map((column) => column.name);
    const values = rows.map((row) => names.map((name) => toJsValue(row[name] ?? null)));
    if (options?.columnNames === true) {
      return [names, ...values];
    }
    return values;
  }
}

type MemoryD1Result = {
  readonly success: true;
  readonly meta: {
    readonly duration: number;
    readonly size_after: number;
    readonly rows_read: number;
    readonly rows_written: number;
    readonly last_row_id: number;
    readonly changed_db: boolean;
    readonly changes: number;
  };
  readonly results: QueryRow[];
};

function isSelect(query: string): boolean {
  const trimmed = query.trimStart().toLowerCase();
  return trimmed.startsWith("select") || trimmed.startsWith("with") || trimmed.startsWith("pragma");
}

function hasReturning(query: string): boolean {
  return /\breturning\b/i.test(query);
}

function emptyMeta() {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
}

function metaFromRun(info: { changes: number | bigint; lastInsertRowid: number | bigint }) {
  const changes = Number(info.changes);
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: Number(info.lastInsertRowid),
    changed_db: changes > 0,
    changes,
  };
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (isPlainObject(value)) return JSON.stringify(value);
  throw new Error("unsupported sql bind value");
}

function isPlainObject(value: unknown): boolean {
  return value instanceof Object && value.constructor === Object;
}

function toJsRow(row: Record<string, SQLOutputValue>): QueryRow {
  const entries: Array<readonly [string, string | number | null]> = [];
  for (const [column, value] of Object.entries(row)) {
    entries.push([column, toJsValue(value)]);
  }
  return Object.fromEntries(entries);
}

function toJsValue(value: SQLOutputValue): string | number | null {
  if (value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return value;
}
