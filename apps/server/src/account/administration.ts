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

const MailboxRow = Schema.Struct({
  ...AddressRow.fields,
  routing_state: Schema.Literals(["pending", "ready", "error"]),
  routing_error: Schema.NullOr(Schema.String),
  rule_id: Schema.NullOr(Schema.String),
  zone_id: Schema.NullOr(Schema.String),
});
const mailboxSelect = `SELECT a.*, r.state AS routing_state, r.error AS routing_error, r.rule_id, r.zone_id
 FROM addresses a JOIN mailbox_routes r ON r.mailbox_id = a.id`;

export function listAddresses(storage: AccountSqliteStorage): ReadonlyArray<AccountAddress> {
  return Schema.decodeUnknownSync(Schema.Array(MailboxRow))(
    storage.sql.exec(`${mailboxSelect} ORDER BY a.address`).toArray(),
  ).map(toAddress);
}
export function getAddress(storage: AccountSqliteStorage, id: string): AccountAddress | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(MailboxRow),
    storage.sql.exec(`${mailboxSelect} WHERE a.id = ?`, id).toArray(),
  );
  return row === undefined ? null : toAddress(row);
}
export function getAddressByMailbox(
  storage: AccountSqliteStorage,
  address: string,
): AccountAddress | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(MailboxRow),
    storage.sql.exec(`${mailboxSelect} WHERE a.address = ?`, address).toArray(),
  );
  return row === undefined ? null : toAddress(row);
}

export function createAddress(
  storage: AccountSqliteStorage,
  id: string,
  localPart: string,
  mailDomain: MailDomain,
  displayName: string | undefined,
  nowIso: string,
  sendingAllowed: boolean,
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
           id, local_part, address, display_name, active, created_at, updated_at, send_enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        id,
        normalized.localPart,
        normalized.address,
        name,
        1,
        nowIso,
        nowIso,
        sendingAllowed ? 1 : 0,
      )
      .toArray();
    if (inserted.length === 0) {
      throw new AccountConflictError({ address: normalized.address });
    }
    storage.sql.exec(
      "INSERT INTO mailbox_routes (mailbox_id, state, retry_after) VALUES (?, 'pending', ?)",
      id,
      nowIso,
    );
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
    if (current === null || current.retiredAt !== null) {
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
  const clauses: Array<string> = ["active = 1", "retired_at IS NULL", "send_enabled = 1"];
  const binds: Array<string> = [];
  if (mailboxScope !== "all") {
    clauses.push("id IN (SELECT value FROM json_each(?))");
    binds.push(bindJsonStringArray(mailboxScope));
  }
  const rows = Schema.decodeUnknownSync(Schema.Array(AddressRow))(
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at, retired_at, send_enabled
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
        `SELECT id, local_part, address, display_name, active, forward_to, created_at, updated_at, retired_at, send_enabled
         FROM addresses
         WHERE id = ? AND active = 1 AND retired_at IS NULL AND send_enabled = 1`,
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

function toAddress(row: typeof MailboxRow.Type): AccountAddress {
  return {
    id: row.id,
    localPart: row.local_part,
    address: row.address,
    displayName: row.display_name,
    active: row.active === 1,
    forwardTo: row.forward_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    domain: row.address.slice(row.address.lastIndexOf("@") + 1),
    canSend: row.send_enabled === 1,
    retiredAt: row.retired_at,
    routing: {
      state: row.routing_state,
      error: row.routing_error,
      ruleId: row.rule_id,
      zoneId: row.zone_id,
    },
  };
}

export function toSendingIdentity(row: AddressRow): AccountSendingIdentity {
  return { id: row.id, address: row.address, displayName: row.display_name };
}

export function retireAddress(
  storage: AccountSqliteStorage,
  id: string,
  nowIso: string,
): AccountAddress | null {
  return storage.transactionSync(() => {
    const current = getAddress(storage, id);
    if (current === null || current.retiredAt !== null) return current;
    storage.sql.exec(
      "UPDATE addresses SET active = 0, retired_at = ?, updated_at = ? WHERE id = ?",
      nowIso,
      nowIso,
      id,
    );
    storage.sql.exec(
      "UPDATE mailbox_routes SET state = 'pending', error = NULL, retry_after = ? WHERE mailbox_id = ?",
      nowIso,
      id,
    );
    return requireAddress(storage, id);
  });
}

export function retryAddressRouting(
  storage: AccountSqliteStorage,
  id: string,
  nowIso: string,
): AccountAddress | null {
  if (getAddress(storage, id) === null) return null;
  storage.sql.exec(
    "UPDATE mailbox_routes SET state = 'pending', error = NULL, attempts = 0, retry_after = ? WHERE mailbox_id = ?",
    nowIso,
    id,
  );
  return requireAddress(storage, id);
}

export function configureSendingDomains(
  storage: AccountSqliteStorage,
  names: ReadonlyArray<string>,
) {
  storage.sql.exec(
    `UPDATE addresses SET send_enabled = CASE WHEN substr(address, instr(address, '@') + 1) IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`,
    JSON.stringify(names),
  );
}
