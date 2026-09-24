# 0001: Consistent mail and access flows

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Supersedes:** the "DO alarms" and "producer bindings on Api" rejections in `adrs/work/codebase-cleanup.md` and `adrs/work/codebase-cleanup-decomplex.md`. Neither gave a reason, and today's 40-minute cron outage is new evidence against both.

## Context

The flow audits found several places where a secondary mechanism quietly carries a primary path, or where state is only correct after a side effect:

- **Recovery is the only send producer.** It is a per-minute cron, but it is the only thing that puts outbound mail on the send queue. A cron outage blocks all sending; after the 2026-09-24 redeploy that lasted ~40 minutes.
- **Recovery runs all-or-nothing.** An inbound failure stops outbound publishing.
- **Approval expiry has three writers.**
- **Failure classes are misleading.** The approval page says "outcome unconfirmed" for jobs that are merely queued.
- **MCP client policies are created lazily.** They are created on first use in the mail store, while grants live in D1. Revoke is permanent and incomplete, and a client can't be listed or narrowed before it has already read everything.
- **REST grants are invisible, and `umail logout` can drop its token before revoking it.**
- **`canAdmin`/`canDelete` control nothing.**
- **The deployment gate's `ready` flag is dead, and OAuth resources have two writers.**
- **Forwarding destinations are a stale per-stage copy of an account-wide Cloudflare resource.** Only a GET refreshes it, and that GET writes.
- **The mail store is hosted by the Worker named "Api".** The four other Workers bind to it across scripts, and each one ships the whole app.

The goal is the fewest concepts, using Alchemy and Effect features rather than hand-rolled machinery.

## Decision

1. **One Worker.** The single Worker hosts HTTP, the email handler, the MailIndex queue consumer and the AccountStore Durable Object.
2. **The store runs its own due work, on its Durable Object alarm.** Each state-changing call arms the alarm at the next due time. A pass then:
   - expires due approvals (the only writer of expiry);
   - sends ready jobs in small batches, re-arming at `now` while work remains;
   - settles abandoned claims as `unknown`;
   - redrives stuck inbound receipts.

   Steps are independent, and a failed pass re-arms after 60 s.

   At-most-once sending is unchanged: the atomic claim of a `ready` job, plus an expired claim becoming `unknown`, which is never resent.

   Recovery, SendConsumer, the MailSend queue and the cron are deleted.
3. **Access lives in D1, next to the grants.**
   - The consent screen asks which mailboxes and which send mode to grant. An `after` hook on better-auth's consent endpoint writes the policy for the new consent. It runs on every consent path, so no consent can bypass it.
   - Consent without a policy means no access (fail closed).
   - Revoking deletes the consent and refresh tokens, and the policy goes with them. Reconnecting shows the consent screen again.
   - One `/clients` list covers every grant, including the CLI.
   - The CLI is one static client, and it is the only way to get operator (REST) access. `umail logout` revokes on the server before deleting local credentials.
   - Deleted: the deployment gate and its control table, `canAdmin`/`canDelete`, and the REST/CLI client-policy commands.
   - Provisioning writes the OAuth resources and static clients. The only other writer is `mcp()`'s insert-only seed of its own resource. Cursor support, including the patch, stays.
4. **Forwarding treats Cloudflare as the only source of truth.**
   - An address stores `forward_to`.
   - Setting it adopts the account's Cloudflare destination address, or creates it, and reports live whether it is verified.
   - Inbound mail always tries to forward and records any failure.
   - The destinations table and routes are deleted.
5. **Where Alchemy or Effect already provides something, use it.**
   - The routing provider is rebuilt on the Cloudflare API client that Alchemy ships.
   - The store reads its site config through `Config`.
   - The CLI reads `UMAIL_URL` through `Config`.

## Alternatives

| Area | Option | Why it wasn't chosen |
|---|---|---|
| Send path | **Simplest: the API enqueues sends directly** (~+40 lines, keeps Recovery as a safety net) | Fixes latency, but keeps the cron, a reconciler and several expiry writers. It removes no concept. |
| Send path | Cloudflare Workflows per job | Still needs the DO claim for at-most-once and a reconciler for workflow creation. It adds a second source of truth. |
| Send path | The alarm publishes to MailSend, and SendConsumer stays | The DO can't see delivery, so it goes back to polling. |
| Access | Keep the policy in the DO and create it at consent | Revoke and listing still span two stores. |
| Access | Rotate the operator's id on every password change | Closes a sub-second race with a lot of machinery. The existing password-change deletes plus the 300 s JWT TTL are enough. |
| Access | Read-all default at consent, narrowed later (the owner chose consent-screen scoping instead) | A client's first call could read everything. |
| Topology | Five Workers plus a separate Store Worker, or Api plus Mail | More Workers and bindings. The only thing they isolate against is config errors, which already break every Worker. |
| Forwarding | A cache table refreshed on read | Strictly more than option A. |
| Forwarding | Always forward to the operator inbox | The owner kept arbitrary per-address targets. |

## Consequences

**Gains:**
- Sends start within seconds.
- No cron can block mail.
- Every time-based decision has one writer.
- "Who has access" is one D1 query, revocation is complete and reversible, and nothing gets broad access before the operator chooses.
- Forwarding survives resets and other stages.
- About −3,000 lines overall.

**Costs we accept:**
- **No least-privilege split.** The public Worker holds `send_email` and the Cloudflare routing token.
- **Shared isolate memory.** Inbound parsing shares it with API reads: ~90 MiB worst case of 128. Index handling stays pure, so it can be split out if this ever bites.
- **Sequential sends from one Durable Object**, in small batches.
- **A 300 s window** before access tokens die after a password change.
- **Another full reset.** New Worker ids, a changed store schema, a new D1 table. Every client re-authorizes and the addresses are recreated.
