import { applyAccountSchema } from "../../src/account/commands.ts";
import {
  type AccountSqlRow,
  type AccountSqlValue,
  type AccountSqliteStorage,
} from "../../src/account/sqlite.ts";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import { makeAccountStoreRpc, type AccountStoreRpc } from "../../src/account/worker.ts";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

export class MemoryAccountSqliteStorage implements AccountSqliteStorage {
  readonly #sqlite = new DatabaseSync(":memory:");
  writeCount = 0;
  #closed = false;

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#sqlite.close();
  }

  readonly sql = {
    exec: (query: string, ...bindings: ReadonlyArray<AccountSqlValue>) => {
      const params = bindings.map(toSqlValue);
      const read = isRead(query);
      if (!read) {
        this.writeCount += 1;
      }
      if (read || /\bRETURNING\b/i.test(query)) {
        const rows = this.#sqlite
          .prepare(query)
          .all(...params)
          .map(toAccountRow);
        return {
          toArray: () => rows,
        };
      }
      if (params.length === 0) {
        this.#sqlite.exec(query);
      } else {
        this.#sqlite.prepare(query).run(...params);
      }
      return {
        toArray: () => [],
      };
    },
  };

  transactionSync<T>(closure: () => T): T {
    this.#sqlite.exec("BEGIN");
    try {
      const result = closure();
      this.#sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export type MemoryAccount = {
  readonly storage: MemoryAccountSqliteStorage;
  readonly account: AccountStoreRpc;
};

export function createMemoryAccount(): MemoryAccount {
  const storage = new MemoryAccountSqliteStorage();
  applyAccountSchema(storage, TEST_NOW);
  return {
    storage,
    account: makeAccountStoreRpc(storage),
  };
}

function isRead(query: string): boolean {
  const trimmed = query.trimStart().toUpperCase();
  return trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
}

function toSqlValue(value: AccountSqlValue): SQLInputValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

function toAccountRow(row: { readonly [column: string]: SQLOutputValue }): AccountSqlRow {
  const mapped: { [column: string]: AccountSqlValue } = {};
  for (const [column, value] of Object.entries(row)) {
    mapped[column] = toAccountValue(value);
  }
  return mapped;
}

function toAccountValue(value: SQLOutputValue): AccountSqlValue {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return value.buffer;
  }
  return value;
}
