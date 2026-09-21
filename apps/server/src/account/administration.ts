import {
  constructMailboxAddress,
  parseMailboxAddress,
  requireApprovalSendMode,
  type ExternalMailAddress,
  type MailDomain,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  AccountAddress,
  AccountDestination,
  AccountSendingIdentity,
  AddressRow,
  DestinationRow,
  EnsureMcpOAuthPolicyInput,
  McpOAuthPolicy,
  McpOAuthPolicyRow,
  PatchAddressInput,
  SetMcpOAuthPolicyStateInput,
  StoredMailboxIds,
  StoredPreapprovedRecipients,
  StoredRecipientAllowlist,
  UpdateMcpOAuthPolicyInput,
  type MailboxScope,
} from "./domain.ts";
import { AccountConflictError, AccountStoreUnexpectedError } from "./errors.ts";
import { bindJsonStringArray, firstDecoded, type AccountSqliteStorage } from "./sqlite.ts";

const SqliteErrorMessage = Schema.Struct({
  message: Schema.String,
});

const defaultMcpPolicy = {
  mailboxIds: "all",
  canRead: true,
  canDelete: false,
  sendMode: requireApprovalSendMode(),
  recipientAllowlist: "any",
  canAdmin: false,
} as const satisfies PrincipalPolicy;

export function listAddresses(storage: AccountSqliteStorage): ReadonlyArray<AccountAddress> {
  const rows = storage.sql
    .exec(
      `SELECT id, local_part, address, display_name, active, forwarding_destination_id, created_at, updated_at
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
        `SELECT id, local_part, address, display_name, active, forwarding_destination_id, created_at, updated_at
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
        `SELECT id, local_part, address, display_name, active, forwarding_destination_id, created_at, updated_at
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
  localPart: string,
  mailDomain: MailDomain,
  displayName: string | undefined,
  nowIso: string,
): AccountAddress | null {
  const normalized = constructMailboxAddress(localPart, mailDomain);
  if (normalized.kind !== "ok") {
    return null;
  }
  const id = crypto.randomUUID();
  const name = displayName === undefined ? null : displayName;
  return storage.transactionSync(() => {
    try {
      storage.sql.exec(
        `INSERT INTO addresses (
           id, local_part, address, display_name, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        normalized.localPart,
        normalized.address,
        name,
        1,
        nowIso,
        nowIso,
      );
    } catch (cause) {
      throw conflictOrRethrow(cause, "address", id);
    }
    return requireAddress(storage, id);
  });
}

export function patchAddress(
  storage: AccountSqliteStorage,
  id: string,
  payload: PatchAddressInput,
  nowIso: string,
): AccountAddress | null {
  const parsed = Schema.decodeSync(PatchAddressInput)(payload);
  return storage.transactionSync(() => {
    const current = getAddress(storage, id);
    if (current === null) {
      return null;
    }
    const assignments: Array<string> = [];
    const binds: Array<string | number | null> = [];
    if (parsed.displayName !== undefined) {
      assignments.push("display_name = ?");
      binds.push(parsed.displayName);
    }
    if (parsed.active !== undefined) {
      assignments.push("active = ?");
      binds.push(parsed.active ? 1 : 0);
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
  mailDomain: MailDomain,
  mailboxScope: MailboxScope = "all",
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
        `SELECT id, local_part, address, display_name, active, forwarding_destination_id, created_at, updated_at
         FROM addresses
         WHERE ${clauses.join(" AND ")}
         ORDER BY address`,
        ...binds,
      )
      .toArray(),
  );
  const identities: Array<AccountSendingIdentity> = [];
  for (const row of rows) {
    const identity = toSendingIdentity(row, mailDomain);
    if (identity !== null) {
      identities.push(identity);
    }
  }
  return identities;
}

export function resolveSendingIdentity(
  storage: AccountSqliteStorage,
  id: string,
  mailDomain: MailDomain,
): AccountSendingIdentity | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(AddressRow),
    storage.sql
      .exec(
        `SELECT id, local_part, address, display_name, active, forwarding_destination_id, created_at, updated_at
         FROM addresses
         WHERE id = ? AND active = 1`,
        id,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toSendingIdentity(row, mailDomain);
}

export function listDestinations(storage: AccountSqliteStorage): ReadonlyArray<AccountDestination> {
  const rows = storage.sql
    .exec(
      `SELECT id, cloudflare_id, email, verification_status, verified_at, created_at, updated_at
       FROM forwarding_destinations
       ORDER BY email`,
    )
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(DestinationRow))(rows).map(toDestination);
}

export function getDestination(
  storage: AccountSqliteStorage,
  id: string,
): AccountDestination | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(DestinationRow),
    storage.sql
      .exec(
        `SELECT id, cloudflare_id, email, verification_status, verified_at, created_at, updated_at
         FROM forwarding_destinations
         WHERE id = ?`,
        id,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return toDestination(row);
}

export function insertDestination(
  storage: AccountSqliteStorage,
  cloudflareId: string,
  email: string,
  verifiedAt: string | null,
  nowIso: string,
): AccountDestination {
  const id = crypto.randomUUID();
  const status = verifiedAt === null ? "pending" : "verified";
  return storage.transactionSync(() => {
    try {
      storage.sql.exec(
        `INSERT INTO forwarding_destinations (
           id, cloudflare_id, email, verification_status, verified_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        cloudflareId,
        email,
        status,
        verifiedAt,
        nowIso,
        nowIso,
      );
    } catch (cause) {
      throw conflictOrRethrow(cause, "destination", id);
    }
    return requireDestination(storage, id);
  });
}

export function setAddressForwarding(
  storage: AccountSqliteStorage,
  addressId: string,
  destinationId: string | null,
  nowIso: string,
): AccountAddress | null {
  return storage.transactionSync(() => {
    const current = getAddress(storage, addressId);
    if (current === null) {
      return null;
    }
    if (destinationId !== null) {
      const destination = getDestination(storage, destinationId);
      if (destination === null || destination.verificationStatus !== "verified") {
        return null;
      }
    }
    storage.sql.exec(
      `UPDATE addresses
       SET forwarding_destination_id = ?, updated_at = ?
       WHERE id = ?`,
      destinationId,
      nowIso,
      addressId,
    );
    return requireAddress(storage, addressId);
  });
}

export function updateDestinationStatus(
  storage: AccountSqliteStorage,
  id: string,
  verifiedAt: string | null,
  nowIso: string,
): AccountDestination | null {
  return storage.transactionSync(() => {
    const current = getDestination(storage, id);
    if (current === null) {
      return null;
    }
    const status = verifiedAt === null ? "pending" : "verified";
    storage.sql.exec(
      `UPDATE forwarding_destinations
       SET verification_status = ?, verified_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      verifiedAt,
      nowIso,
      id,
    );
    return requireDestination(storage, id);
  });
}

export function deleteDestination(storage: AccountSqliteStorage, id: string, nowIso: string): void {
  storage.transactionSync(() => {
    const existing = getDestination(storage, id);
    if (existing === null) {
      return;
    }
    storage.sql.exec(
      `UPDATE addresses
       SET forwarding_destination_id = ?, updated_at = ?
       WHERE forwarding_destination_id = ?`,
      null,
      nowIso,
      id,
    );
    storage.sql.exec("DELETE FROM forwarding_destinations WHERE id = ?", id);
  });
}

export function getMcpOAuthPolicy(
  storage: AccountSqliteStorage,
  clientId: string,
): McpOAuthPolicy | null {
  const row = firstDecoded(
    Schema.decodeUnknownSync(McpOAuthPolicyRow),
    storage.sql
      .exec(
        `SELECT client_id, label, state, mailbox_ids_json, can_read, can_delete,
                send_mode, recipient_allowlist_json, preapproved_recipients_json,
                can_admin, created_at, updated_at
         FROM mcp_oauth_policies
         WHERE client_id = ?`,
        clientId,
      )
      .toArray(),
  );
  if (row === undefined) {
    return null;
  }
  return policyFromRow(row);
}

export function listMcpOAuthPolicies(storage: AccountSqliteStorage): ReadonlyArray<McpOAuthPolicy> {
  const rows = Schema.decodeUnknownSync(Schema.Array(McpOAuthPolicyRow))(
    storage.sql
      .exec(
        `SELECT client_id, label, state, mailbox_ids_json, can_read, can_delete,
                send_mode, recipient_allowlist_json, preapproved_recipients_json,
                can_admin, created_at, updated_at
         FROM mcp_oauth_policies
         ORDER BY label, client_id`,
      )
      .toArray(),
  );
  return rows.map(policyFromRow);
}

export function ensureMcpOAuthPolicy(
  storage: AccountSqliteStorage,
  input: EnsureMcpOAuthPolicyInput,
): McpOAuthPolicy {
  const parsed = Schema.decodeSync(EnsureMcpOAuthPolicyInput)(input);
  const encoded = encodePolicy(defaultMcpPolicy);
  return storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO mcp_oauth_policies (
         client_id, label, state, mailbox_ids_json, can_read, can_delete,
         send_mode, recipient_allowlist_json, preapproved_recipients_json,
         can_admin, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO NOTHING`,
      parsed.clientId,
      parsed.label,
      "active",
      encoded.mailboxIds,
      encoded.canRead,
      encoded.canDelete,
      encoded.sendMode,
      encoded.recipientAllowlist,
      encoded.preapprovedRecipients,
      encoded.canAdmin,
      parsed.createdAt,
      parsed.createdAt,
    );
    return requireMcpOAuthPolicy(storage, parsed.clientId);
  });
}

export function updateMcpOAuthPolicy(
  storage: AccountSqliteStorage,
  input: UpdateMcpOAuthPolicyInput,
): McpOAuthPolicy | null {
  const parsed = Schema.decodeSync(UpdateMcpOAuthPolicyInput)(input);
  const encoded = encodePolicy(parsed.policy);
  return storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE mcp_oauth_policies
       SET label = ?,
           mailbox_ids_json = ?,
           can_read = ?,
           can_delete = ?,
           send_mode = ?,
           recipient_allowlist_json = ?,
           preapproved_recipients_json = ?,
           can_admin = ?,
           updated_at = ?
       WHERE client_id = ? AND state <> 'revoked'`,
      parsed.label,
      encoded.mailboxIds,
      encoded.canRead,
      encoded.canDelete,
      encoded.sendMode,
      encoded.recipientAllowlist,
      encoded.preapprovedRecipients,
      encoded.canAdmin,
      parsed.updatedAt,
      parsed.clientId,
    );
    return getMcpOAuthPolicy(storage, parsed.clientId);
  });
}

export function setMcpOAuthPolicyState(
  storage: AccountSqliteStorage,
  input: SetMcpOAuthPolicyStateInput,
): McpOAuthPolicy | null {
  const parsed = Schema.decodeSync(SetMcpOAuthPolicyStateInput)(input);
  return storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE mcp_oauth_policies
       SET state = ?, updated_at = ?
       WHERE client_id = ? AND state <> 'revoked'`,
      parsed.state,
      parsed.updatedAt,
      parsed.clientId,
    );
    return getMcpOAuthPolicy(storage, parsed.clientId);
  });
}

export function revokeMcpOAuthPolicy(
  storage: AccountSqliteStorage,
  clientId: string,
  updatedAt: string,
): McpOAuthPolicy | null {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE mcp_oauth_policies
       SET state = ?, updated_at = ?
       WHERE client_id = ? AND state <> 'revoked'`,
      "revoked",
      updatedAt,
      clientId,
    );
    return getMcpOAuthPolicy(storage, clientId);
  });
}

function requireAddress(storage: AccountSqliteStorage, id: string): AccountAddress {
  const address = getAddress(storage, id);
  if (address === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing address ${id}`,
    });
  }
  return address;
}

function requireDestination(storage: AccountSqliteStorage, id: string): AccountDestination {
  const destination = getDestination(storage, id);
  if (destination === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing destination ${id}`,
    });
  }
  return destination;
}

function requireMcpOAuthPolicy(storage: AccountSqliteStorage, clientId: string): McpOAuthPolicy {
  const policy = getMcpOAuthPolicy(storage, clientId);
  if (policy === null) {
    throw new AccountStoreUnexpectedError({
      cause: `Missing MCP OAuth policy ${clientId}`,
    });
  }
  return policy;
}

function toAddress(row: AddressRow): AccountAddress {
  return Schema.decodeSync(AccountAddress)({
    id: row.id,
    localPart: row.local_part,
    address: row.address,
    displayName: row.display_name,
    active: row.active === 1,
    forwardingDestinationId: row.forwarding_destination_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toSendingIdentity(row: AddressRow, mailDomain: MailDomain): AccountSendingIdentity | null {
  const parsed = parseMailboxAddress(row.address);
  if (
    parsed.kind === "invalid" ||
    parsed.domain !== mailDomain ||
    parsed.localPart !== row.local_part ||
    parsed.address !== row.address
  ) {
    return null;
  }
  return Schema.decodeSync(AccountSendingIdentity)({
    id: row.id,
    address: parsed.address,
    displayName: row.display_name,
  });
}

function toDestination(row: DestinationRow): AccountDestination {
  return Schema.decodeSync(AccountDestination)({
    id: row.id,
    cloudflareId: row.cloudflare_id,
    email: row.email,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function policyFromRow(row: McpOAuthPolicyRow): McpOAuthPolicy {
  const mailboxIds = Schema.decodeSync(StoredMailboxIds)(row.mailbox_ids_json);
  const recipientAllowlist = Schema.decodeSync(StoredRecipientAllowlist)(
    row.recipient_allowlist_json,
  );
  const preapprovedRecipients = Schema.decodeSync(StoredPreapprovedRecipients)(
    row.preapproved_recipients_json,
  );
  return Schema.decodeSync(McpOAuthPolicy)({
    clientId: row.client_id,
    label: row.label,
    state: row.state,
    policy: {
      mailboxIds,
      canRead: row.can_read === 1,
      canDelete: row.can_delete === 1,
      sendMode: sendModeFromRow(row.send_mode, preapprovedRecipients),
      recipientAllowlist,
      canAdmin: row.can_admin === 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

type EncodedMcpOAuthPolicy = {
  readonly mailboxIds: string;
  readonly canRead: 0 | 1;
  readonly canDelete: 0 | 1;
  readonly sendMode: PrincipalPolicy["sendMode"]["kind"];
  readonly recipientAllowlist: string;
  readonly preapprovedRecipients: string;
  readonly canAdmin: 0 | 1;
};

function sendModeFromRow(
  kind: EncodedMcpOAuthPolicy["sendMode"],
  preapprovedRecipients: ReadonlyArray<ExternalMailAddress>,
): PrincipalPolicy["sendMode"] {
  return kind === "requireApproval" ? requireApprovalSendMode(preapprovedRecipients) : { kind };
}

function encodePolicy(policy: PrincipalPolicy): EncodedMcpOAuthPolicy {
  const preapproved =
    policy.sendMode.kind === "requireApproval" ? policy.sendMode.preapprovedRecipients : [];
  return {
    mailboxIds: Schema.encodeSync(StoredMailboxIds)(policy.mailboxIds),
    canRead: policy.canRead ? 1 : 0,
    canDelete: policy.canDelete ? 1 : 0,
    sendMode: policy.sendMode.kind,
    recipientAllowlist: Schema.encodeSync(StoredRecipientAllowlist)(policy.recipientAllowlist),
    preapprovedRecipients: Schema.encodeSync(StoredPreapprovedRecipients)(preapproved),
    canAdmin: policy.canAdmin ? 1 : 0,
  };
}

function conflictOrRethrow(
  cause: unknown,
  resource: "address" | "destination",
  id: string,
): AccountConflictError {
  if (cause instanceof AccountConflictError) return cause;
  const decoded = Schema.decodeUnknownResult(SqliteErrorMessage)(cause);
  if (Result.isSuccess(decoded) && decoded.success.message.includes("UNIQUE")) {
    return new AccountConflictError({ resource, id });
  }
  if (cause instanceof Error) {
    throw cause;
  }
  throw new AccountStoreUnexpectedError({ cause });
}
