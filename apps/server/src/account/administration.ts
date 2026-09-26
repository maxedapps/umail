import { constructMailboxAddress, type MailDomain } from "@umail/api-contract";
import * as Schema from "effect/Schema";

import {
  AddressRow,
  type AccountAddress,
  type AccountSendingIdentity,
  type MailboxScope,
  type PatchAddressInput,
} from "./domain.ts";
import { AccountConflictError } from "./errors.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";

export function listAddresses(storage: AccountSqliteStorage): ReadonlyArray<AccountAddress> {
  const rows = storage.sql
    .exec(
      `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at
       FROM addresses
       ORDER BY address`,
    )
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(AddressRow))(rows).map(toAddress);
}

export function getAddress(storage: AccountSqliteStorage, id: string): AccountAddress | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(AddressRow),
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at
         FROM addresses
         WHERE id = ?`,
        id,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toAddress(row);
}

export function getAddressByMailbox(
  storage: AccountSqliteStorage,
  address: string,
): AccountAddress | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(AddressRow),
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at
         FROM addresses
         WHERE address = ?`,
        address,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toAddress(row);
}

export function createAddress(
  storage: AccountSqliteStorage,
  id: string,
  localPart: string,
  mailDomain: MailDomain,
  displayName: string | undefined,
  nowIso: string,
): AccountAddress | null {
  const normalized = constructMailboxAddress(localPart, mailDomain);
  if (normalized.kind !== "ok") {
    return null;
  }
  const name = displayName === undefined ? null : displayName;
  return storage.transactionSync(() => {
    const inserted = storage.sql
      .exec(
        `INSERT INTO addresses (
           id, local_part, address, display_name, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        id,
        normalized.localPart,
        normalized.address,
        name,
        1,
        nowIso,
        nowIso,
      )
      .toArray();
    if (inserted.length === 0) {
      throw new AccountConflictError({ address: normalized.address });
    }
    return requireAddress(storage, id);
  });
}

export function patchAddress(
  storage: AccountSqliteStorage,
  id: string,
  patch: PatchAddressInput,
  nowIso: string,
): AccountAddress | null {
  return storage.transactionSync(() => {
    const current = getAddress(storage, id);
    if (current === null) {
      return null;
    }
    const assignments: Array<string> = [];
    const binds: Array<string | number | null> = [];
    if (patch.displayName !== undefined) {
      assignments.push("display_name = ?");
      binds.push(patch.displayName);
    }
    if (patch.active !== undefined) {
      assignments.push("active = ?");
      binds.push(patch.active ? 1 : 0);
    }
    if (assignments.length === 0) {
      return current;
    }
    assignments.push("updated_at = ?");
    binds.push(nowIso);
    binds.push(id);
    storage.sql.exec(`UPDATE addresses SET ${assignments.join(", ")} WHERE id = ?`, ...binds);
    return requireAddress(storage, id);
  });
}

export function listSendingIdentities(
  storage: AccountSqliteStorage,
  mailboxScope: MailboxScope,
): ReadonlyArray<AccountSendingIdentity> {
  if (mailboxScope !== "all" && mailboxScope.length === 0) {
    return [];
  }
  const clauses: Array<string> = ["active = 1"];
  const binds: Array<string> = [];
  if (mailboxScope !== "all") {
    clauses.push("id IN (SELECT value FROM json_each(?))");
    binds.push(bindJsonStringArray(mailboxScope));
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(AddressRow))(
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at
         FROM addresses
         WHERE ${clauses.join(" AND ")}
         ORDER BY address`,
        ...binds,
      )
      .toArray(),
  );
  return rows.map(toSendingIdentity);
}

export function resolveSendingIdentity(
  storage: AccountSqliteStorage,
  id: string,
): AccountSendingIdentity | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(AddressRow),
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at
         FROM addresses
         WHERE id = ? AND active = 1`,
        id,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toSendingIdentity(row);
}

// Cloudflare decides whether the destination is verified; the store only keeps where to forward.
export function setAddressForwarding(
  storage: AccountSqliteStorage,
  addressId: string,
  forwardTo: string | null,
  nowIso: string,
): AccountAddress | null {
  return storage.transactionSync(() => {
    if (getAddress(storage, addressId) === null) {
      return null;
    }
    storage.sql.exec(
      "UPDATE addresses SET forward_to = ?, updated_at = ? WHERE id = ?",
      forwardTo,
      nowIso,
      addressId,
    );
    return requireAddress(storage, addressId);
  });
}

function requireAddress(storage: AccountSqliteStorage, id: string): AccountAddress {
  const address = getAddress(storage, id);
  if (address === null) {
    throw new Error(`Missing address ${id}`);
  }
  return address;
}

function toAddress(row: AddressRow): AccountAddress {
  return {
    id: row.id,
    localPart: row.local_part,
    address: row.address,
    displayName: row.display_name,
    active: row.active === 1,
    forwardTo: row.forward_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSendingIdentity(row: AddressRow): AccountSendingIdentity {
  return { id: row.id, address: row.address, displayName: row.display_name };
}
