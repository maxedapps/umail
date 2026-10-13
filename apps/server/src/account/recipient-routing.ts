import { Effect, Schema } from "effect";
import { getAddress } from "./administration.ts";
import type { AccountSqliteStorage } from "./sqlite.ts";
import type { ResolvedMailDomain } from "../mail/domains.ts";
import {
  RecipientRuleError,
  ruleAddresses,
  ruleMatches,
  type RecipientRule,
  type RecipientRuleClient,
} from "../mail/recipient-rules.ts";

export const LegacySeedRule = Schema.Struct({
  id: Schema.String,
  zoneId: Schema.String,
  address: Schema.String,
});
export type LegacySeedRule = typeof LegacySeedRule.Type;

export type RecipientRoutingPorts = {
  readonly client: RecipientRuleClient;
  readonly domains: ReadonlyArray<ResolvedMailDomain>;
  readonly workerName: string;
  readonly ownerPrefix: string;
  readonly legacySeeds: ReadonlyArray<LegacySeedRule>;
};

const DueRoute = Schema.Struct({ mailbox_id: Schema.String, attempts: Schema.Finite });

// All writes run through the one account alarm. HTTP commands persist intent and only arm it.
export const reconcileDueRecipientRoutes = Effect.fn("reconcileDueRecipientRoutes")(function* (
  storage: AccountSqliteStorage,
  ports: RecipientRoutingPorts,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DueRoute))(
    storage.sql
      .exec(
        "SELECT mailbox_id, attempts FROM mailbox_routes WHERE retry_after <= ? ORDER BY retry_after, mailbox_id LIMIT 10",
        now,
      )
      .toArray(),
  ).pipe(Effect.orDie);
  for (const row of rows) {
    yield* reconcileRecipientRoute(storage, ports, row.mailbox_id, now).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const attempts = row.attempts + 1;
          const retry = error.retryable
            ? new Date(
                nowMs + Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000),
              ).toISOString()
            : null;
          storage.sql.exec(
            "UPDATE mailbox_routes SET state = 'error', error = ?, attempts = ?, retry_after = ? WHERE mailbox_id = ?",
            error.message,
            attempts,
            retry,
            row.mailbox_id,
          );
        }),
      ),
    );
  }
});

const ownershipFailure = (message: string) => new RecipientRuleError({ message, retryable: false });

const reconcileRecipientRoute = Effect.fn("reconcileRecipientRoute")(function* (
  storage: AccountSqliteStorage,
  ports: RecipientRoutingPorts,
  id: string,
  now: string,
) {
  const mailbox = getAddress(storage, id);
  if (mailbox === null) return;
  const zoneId =
    mailbox.routing.zoneId ??
    ports.domains.find((domain) => domain.receive && domain.name === mailbox.domain)?.zoneId;
  if (zoneId === undefined)
    return yield* ownershipFailure(
      `Receiving domain ${mailbox.domain} is not configured; no rule was changed.`,
    );
  // Persist the zone before a write can have an uncertain result, including a concurrent retire.
  storage.sql.exec("UPDATE mailbox_routes SET zone_id = ? WHERE mailbox_id = ?", zoneId, id);
  const owner = `${ports.ownerPrefix}${id}`;
  const rules = yield* ports.client.list(zoneId);
  const seed = ports.legacySeeds.find(
    (rule) => rule.zoneId === zoneId && rule.address === mailbox.address,
  );
  const candidates = rules.filter(
    (rule) => rule.id === mailbox.routing.ruleId || rule.name === owner || rule.id === seed?.id,
  );
  if (candidates.length > 1)
    return yield* ownershipFailure(
      `Multiple rules claim ${mailbox.address}; resolve them in Cloudflare before retrying.`,
    );
  let own = candidates[0];
  const permitted = (rule: RecipientRule) =>
    ruleMatches(rule, mailbox.address, ports.workerName) &&
    (rule.name === owner || (rule.id === seed?.id && seed !== undefined));
  if (own && !permitted(own))
    return yield* ownershipFailure(
      `The stored rule for ${mailbox.address} has changed owner or target; no rule was changed.`,
    );
  if (rules.some((rule) => rule.id !== own?.id && ruleAddresses(rule, mailbox.address))) {
    return yield* ownershipFailure(
      `${mailbox.address} already has another routing rule; umail will not take it over.`,
    );
  }
  // Commands can interleave while awaiting Cloudflare. Read the latest retirement intent.
  const current = getAddress(storage, id);
  if (current === null) return;
  if (own) {
    const fresh = yield* ports.client.read(zoneId, own.id);
    if (fresh !== null && !permitted(fresh))
      return yield* ownershipFailure(
        `The rule for ${mailbox.address} changed while reconciling; no rule was changed.`,
      );
    own = fresh ?? undefined;
  }
  if (current.retiredAt !== null) {
    if (own) yield* ports.client.remove(zoneId, own.id);
    storage.sql.exec(
      "UPDATE mailbox_routes SET rule_id = NULL, state = 'ready', error = NULL, attempts = 0, retry_after = NULL WHERE mailbox_id = ?",
      id,
    );
    return;
  }
  const saved =
    own?.enabled && own.name === owner
      ? own
      : yield* ports.client.save(zoneId, mailbox.address, ports.workerName, owner, own?.id ?? null);
  storage.sql.exec("UPDATE mailbox_routes SET rule_id = ? WHERE mailbox_id = ?", saved.id, id);
  if (!permitted(saved) || !saved.enabled || saved.name !== owner)
    return yield* ownershipFailure(
      `Cloudflare did not confirm the owned rule for ${mailbox.address}; inspect it before retrying.`,
    );
  // Always retain the returned ID. A retirement during create must schedule its deletion.
  storage.sql.exec(
    `UPDATE mailbox_routes SET rule_id = ?, error = NULL, attempts = 0,
    state = CASE WHEN (SELECT retired_at FROM addresses WHERE id = ?) IS NULL THEN 'ready' ELSE 'pending' END,
    retry_after = CASE WHEN (SELECT retired_at FROM addresses WHERE id = ?) IS NULL THEN NULL ELSE ? END
    WHERE mailbox_id = ?`,
    saved.id,
    id,
    id,
    now,
    id,
  );
});
