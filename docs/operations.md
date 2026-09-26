# Operations

## Updates and credentials

Keep the same Cloudflare account, profile, stage, and private configuration when following the README's update commands. Inspect unexpected replacements. Use `--force` only after diagnosing a reconciliation failure.

`UMAIL_OPERATOR_EMAIL` receives send approvals, so it must be an inbox outside `UMAIL_DOMAIN`: deployment fails for an address on that domain or any subdomain, since a client that can read the inbox could approve its own sends. Changing `UMAIL_OPERATOR_PASSWORD` and redeploying invalidates sessions and OAuth grants; unchanged credentials preserve them. Approval links are derived from the `NotificationKey` secret Alchemy mints once and keeps in its encrypted state; replacing that resource breaks approval notifications that have not been sent yet. Replace Cloudflare tokens through their issuing account, update private configuration, redeploy, and verify the affected operation.

Upgrading an existing deployment across [ADR 0001](../adrs/0001-consistent-mail-and-access-flows.md) needs a full reset (see [Stages and removal](#stages-and-removal)): the Worker, the store's schema, and the auth database changed. Afterwards every client authorizes again, and mailboxes and forwarding are recreated.

## Sending and due work

One Worker, `App`, serves HTTP and MCP, receives mail, consumes the MailIndex queue, and hosts the AccountStore Durable Object. The store does its own due work on its Durable Object alarm. Each change that creates work (a submit, an approval, a new inbound receipt) sets the alarm for the earliest due work, and so does the store starting up. A pass then:

- expires due approvals and rejects their unsent jobs (the only place approvals expire);
- sends up to 10 ready jobs, and runs again at once while more are waiting;
- settles a claim abandoned mid-send as `unknown` once its 15-minute claim expires, never sending it again;
- redrives inbound mail still unindexed 5 minutes after it arrived, then every 1–30 minutes depending on its age.

A failed step is logged as "Due work failed" (with the step, and the job for a send) and retried after a minute; the other steps still run.

## Client access

Access lives in the auth database, next to the OAuth grants.

- **MCP clients** get access through the consent screen, which records the mailboxes they may use and their send mode as the consent's policy. A consent without a policy grants nothing. `/clients` shows every client with access and edits a client's mailboxes, reading, recipients, and send mode.
- **The CLI** is the static `umail-cli` client and the only way to operator (REST) access; dynamic registration only admits MCP clients. It appears on `/clients` while it holds a refresh token.
- **The web console** is the second operator surface (ADR 0003). The operator's signed-in browser session reads and sends mail and manages mailboxes and clients in its pages, acting as client `umail-web` ("AgentMail web"); REST stays bearer-only. Every console POST must come from the site's own origin. Signing out (the console's Sign out button, `POST /logout`) ends the session.
- **Revoking** a client on `/clients` deletes its consent, policy, and tokens. MCP access ends with the next request; a CLI access token lasts at most its remaining 5 minutes. The client's registration stays, so it can ask again, and you see the consent screen again.

## Troubleshooting

A deployment is ready only after login, an indexed inbound message, and an actual send have been verified.

| Symptom                             | Check                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recipient rejected                  | Active mailbox, domain/DNS readiness, and explicit Email Routing rules that override the catch-all.                                                                                                                      |
| Archived mail missing from listings | App Worker logs and the stage's MailIndex queue. The store's alarm redrives unindexed mail until it is indexed; only content-policy failures are final.                                                                  |
| Send waiting                        | App Worker logs for "Due work failed" (a failed send step retries after a minute), and Email Sending readiness. A submit or approval normally sends within seconds.                                                      |
| Approval email missing              | Operator inbox and the send path above. A rejected approval email ends the job as `rejected` with `notification_failed`; an `unknown` one keeps the approval waiting until it expires after 24 hours.                    |
| Forwarded mail missing              | `pnpm umail forwarding set` reports `verified`. Cloudflare forwards only to a verified destination; until then each forward is recorded as `failure`, and the mail is still delivered to the mailbox.                    |
| MCP client gets 401 or 403          | 401 with `invalid_token`: its grant was revoked or its token is invalid, and it should re-authorize. 403: it is connected but has no access policy yet. A tool error names the policy that refused it. Check `/clients`. |

Find the stage's Worker name through Alchemy outputs/state. In Cloudflare, open **Workers & Pages → Worker → Observability** for the App Worker. If logs are absent, check that [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) is enabled. Both the App Worker and the AccountStore log structured JSON, one object per line, with the log's annotations as fields, so Workers Logs can filter on them. The store logs failed due work as "Due work failed", a failed provider attempt as "Send attempt failed" (fields `jobId`, `outcome`, `detail`), and other unexpected failures as "AccountStore call failed"; MCP tool defects appear as "MCP tool failed" (fields `tool`, `clientId`), and console page defects as "Console page failed". There are no dead-letter queues: failed index messages are logged and retried, and the store's alarm redrives unindexed mail.

Check `pnpm umail jobs get --id <job-id>`: `accepted` means provider acceptance; `rejected` means the provider refused or failed the message (or it was never dispatched), and `failureClass`/`failureDetail` say why, such as the provider's `E_RATE_LIMIT_EXCEEDED: …` or `notification_failed`; `unknown` means acceptance could not be established and the message may have been delivered, in full or to some recipients. `failureDetail` then keeps what the provider said, if anything. `E_DELIVERY_FAILED` (a recipient server's rejection) is `unknown` for that reason. AgentMail never retries an `unknown` job, and the console shows it as "Outcome unknown", not "Not sent". Inspect provider activity and recipient evidence before sending an `unknown` message again. Reuse a request ID with an identical payload only to retry a submit whose response was lost; that returns the existing job and cannot send twice. To send again after `rejected` or an investigated `unknown`, use a new request ID.

## Backup and recovery limits

**There is no complete AgentMail export/restore command or tested full-restore runbook.** Preserve all of these components; retaining raw mail alone is insufficient.

| Component                                         | What to preserve                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccountStore, SQLite Durable Object hosted by App | Mailboxes and their forwarding targets, indexed messages, read state, jobs, and approvals; it is the only index of archived mail. Cloudflare provides [30-day point-in-time recovery through its storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), but AgentMail exposes no recovery endpoint. Recovery requires a separate, verified integration. |
| AuthDb, D1                                        | Operator identity, sessions, OAuth grants and their client policies, and the provisioned clients. Use [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for recent recovery and protected [SQL exports](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) for independent copies. Treat exports as credentials.       |
| MailArchive, R2                                   | Copy the entire bucket, including raw mail and attachments, to protected independent storage with an [R2-compatible tool](https://developers.cloudflare.com/r2/examples/rclone/). Verify counts and sampled contents.                                                                                                                                                                     |
| Alchemy state and configuration                   | Preserve access to the shared state store, resource/stage identities, private configuration, and generated signing secret. Deployment state is not a database backup.                                                                                                                                                                                                                     |

Before recovery, inventory exact resource identities, record the deployed revision and recovery timestamp, and plan how to stop concurrent writes and sends. Restore related components consistently: rewinding job state after an external delivery can cause duplicate sends; restoring old auth state can restore revoked grants.

Nothing re-imports raw mail from R2 into a lost or rewound AccountStore, and outbound jobs, read state, client policies, and authentication records cannot be reconstructed. Rehearse recovery in isolation before relying on this deployment for important mail.

## Stages and removal

- `prod` uses `UMAIL_DOMAIN`. Other stages use `<stage>.<domain>` for HTTP and `<stage>-mail.<domain>` for mail, with seeded `inbox` and `probe` addresses. Of these, only `dev` provisions sending: it persists, sends real mail, and incurs charges. Each stage keeps its mail data in one AccountStore Durable Object, addressed by the fixed name `operator`.
- Preview names are lowercase DNS labels, at most 58 characters, without leading/trailing hyphens. Renaming a stage does not migrate data.
- Every stage enables Email Routing for its mail domain's whole zone and registers its mail domain as an Email Routing domain. `prod` replaces the zone's catch-all; other stages add literal rules for `inbox` and `probe`.
- Deleting a conversation hides it; archived objects remain. Destroying a stage can delete AccountStore data.
- Destroying `prod` or `dev` retains its AuthDb, MailArchive, and Email Routing domain; retained resources can incur charges. Destroying a preview deletes its AuthDb and MailArchive (objects included) and its mail domain's routing DNS records: it unlocks that subdomain's records by name and deletes them. Zone routing stays enabled for every stage.
- Cloudflare has no subdomain-scoped API to drop a registration, so a destroyed preview's mail domain stays listed as `unconfigured` in the zone's Email Routing settings. Remove it there by hand when convenient; registrations count toward the zone's limit of 30 Email Routing domains. Don't use the API's `email/routing/disable` or `DELETE email/routing/dns` endpoints: both are zone-wide. Never disable the zone apex, which every stage's routing depends on, or the `UMAIL_DOMAIN` and `dev-mail.<domain>` registrations; confirm they are still enabled afterwards.
- For an intentional full reset of `prod` or `dev`: inventory/protect data, review and destroy the exact stage, then empty/delete its retained archive and database, remove its Email Routing domain registration, and inspect leftover DNS. Forwarding destinations are account-wide Cloudflare resources that survive a reset; `forwarding set` adopts an existing one. Never delete retained resources while old stage state still references them. Preserve shared zone routing, the Alchemy state store, and other stages. Verify removal before redeploying.

## Dependency patches

`pnpm-workspace.yaml` applies these patches from `patches/`.

| Patch                               | What it does                                                                                                                                                                                            | Test that covers it                                                                                                                                                                                                                                                                                                             | Upstream issue |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `alchemy@2.0.0-beta.77`             | An unchanged resource signals ready-stable only after its output is stored, so an Action waiting on an unchanged AuthDb does not read an empty database ID. Remove when upstream ships the equivalent.  | `tests/stack.test.ts`: "applies a new action after an unchanged database's asynchronous dependency metadata update"                                                                                                                                                                                                             | TODO           |
| `@better-auth/oauth-provider@1.7.2` | Accepts Cursor's MCP dynamic client registration, a public client with `cursor://anysphere.cursor-mcp/oauth/callback`, as a native client. Remove when upstream ships the equivalent.                   | `apps/server/test/api/oauth.test.ts`: "registers Cursor's MCP profile and honors its private-use callback", "rejects Cursor's private-use callback outside its registration profile"; `apps/server/test/api/auth-boundaries.test.ts`: "registers an explicit native Cursor profile and rejects native registrations outside it" | TODO           |
| `postal-mime@3.0.0`                 | Adds MIME parse budgets checked before allocation, and block accumulators instead of Blob buffering. The limits are set in `apps/server/src/mail/policy.ts`. Remove when upstream ships the equivalent. | `apps/server/test/mail/mime-budgets.worker.spec.ts`, `apps/server/test/mail/mime-decoder.test.ts`                                                                                                                                                                                                                               | TODO           |
