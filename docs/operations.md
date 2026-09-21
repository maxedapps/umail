# Operations

## Updates and credentials

Keep the same Cloudflare account, profile, stage, and private configuration when following the README's update commands. Inspect unexpected replacements. Use `--force` only after diagnosing a reconciliation failure.

Changing `UMAIL_OPERATOR_PASSWORD` and redeploying invalidates sessions and OAuth grants; unchanged credentials preserve them. Keep `UMAIL_NOTIFICATION_KEY` stable: the deployment accepts one key, and replacing it can strand pending encrypted approval notifications. Replace Cloudflare tokens through their issuing account, update private configuration, redeploy, and verify the affected operation.

## Troubleshooting

A deployment is ready only after login, an indexed inbound message, and an actual send have been verified.

| Symptom                             | Check                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Recipient rejected                  | Active mailbox, domain/DNS readiness, and explicit Email Routing rules that override the catch-all.                |
| Archived mail missing from listings | IndexConsumer failures and the stage's MailIndex / MailIndexDlq queues.                                            |
| Send waiting                        | Recovery scheduled invocations, SendConsumer failures, MailSend / MailSendDlq queues, and Email Sending readiness. |
| Approval email missing              | Operator inbox, notification key, and the send pipeline above.                                                     |
| Forwarding unavailable              | Destination must be verified. Cloudflare can temporarily refuse deletion of newly created destinations.            |

Find exact stage Worker names through Alchemy outputs/state. In Cloudflare, open **Workers & Pages → Worker → Observability** for Api, Inbound, IndexConsumer, SendConsumer, and Recovery. If logs are absent, check that [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) is enabled. Inspect queue backlog and errors before replaying or purging work; [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) have finite retention.

Recovery runs every minute; new [cron triggers can take up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Check `pnpm umail jobs get --id <job-id>`: `accepted` means provider acceptance; `unknown` means acceptance could not be established. Inspect provider activity and recipient evidence before creating another send. Retry the same submission with its original request ID and identical payload.

## Backup and recovery limits

**There is no complete AgentMail export/restore command or tested full-restore runbook.** Preserve all of these components; retaining raw mail alone is insufficient.

| Component                                         | What to preserve                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccountStore, SQLite Durable Object hosted by Api | Mailboxes, policies, indexed messages, read state, jobs, and approvals. Cloudflare provides [30-day point-in-time recovery through its storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), but AgentMail exposes no recovery endpoint. Recovery requires a separate, verified integration.                          |
| AuthDb, D1                                        | Operator identity, sessions, OAuth grants, and provisioning state. Use [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for recent recovery and protected [SQL exports](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) for independent copies. Treat exports as credentials. |
| MailArchive, R2                                   | Copy the entire bucket, including raw mail, receipt manifests, and attachments, to protected independent storage with an [R2-compatible tool](https://developers.cloudflare.com/r2/examples/rclone/). Verify counts and sampled contents.                                                                                                            |
| Alchemy state and configuration                   | Preserve access to the shared state store, resource/stage identities, private configuration, and generated signing secret. Deployment state is not a database backup.                                                                                                                                                                                |

Before recovery, inventory exact resource identities, record the deployed revision and recovery timestamp, and plan how to stop concurrent writes and sends. Restore related components consistently: rewinding job state after an external delivery can cause duplicate sends; restoring old auth state can restore revoked grants.

Recovery's receipt-manifest scan can rediscover inbound work. It cannot reconstruct all policies, outbound jobs, read state, or authentication records. Rehearse recovery in isolation before relying on this deployment for important mail.

## Stages and removal

- `prod` uses `UMAIL_DOMAIN`. `dev` uses `dev.<domain>` for HTTP and `dev-mail.<domain>` for mail, with seeded `inbox` and `probe` addresses. Dev persists, sends real mail, and incurs charges. Other preview stages do not provision sending.
- Preview names are lowercase DNS labels, at most 58 characters, without leading/trailing hyphens. Renaming a stage does not migrate data.
- Deleting a conversation hides it; archived objects remain. Destroying a stage can delete AccountStore data; AuthDb and MailArchive are retained, zone routing remains enabled, and retained resources can incur charges.
- For an intentional full reset: inventory/protect data, review and destroy the exact stage, then empty/delete its retained archive and database and inspect leftover DNS/forwarding destinations. Never delete retained resources while old stage state still references them. Preserve shared zone routing, the Alchemy state store, and other stages. Verify removal before redeploying.
