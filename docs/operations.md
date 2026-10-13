# Operations

## Updates and credentials

Keep the same stack, Cloudflare account, profile, stage, and private configuration when following the README's update commands. Inspect unexpected replacements. Use `--force` only after diagnosing a reconciliation failure.

## Named installations

`UMAIL_STACK` selects Alchemy's stack namespace before resource evaluation. The exact existing identity is `uMail`; an absent variable defaults to that name so existing env files keep working. Set `UMAIL_STACK=uMail` explicitly in the existing install's private `.env`. Names preserve case and accept 1–32 ASCII letters/digits/internal hyphens, starting with a letter. Blank or invalid values fail with a one-line configuration error. Changing a name is a new installation, not a rename or data migration; a valid typo also creates a new namespace. The checkout folder does not identify an installation.

Keep one private file per installation, e.g. `.env` for the existing `uMail` and `.env.academind` with `UMAIL_STACK=uMail-academind`, `UMAIL_DOMAIN=mail.academind.ai` and its operator/forwarding credentials. Never overwrite the existing file with a new domain. Use `prod` for each installation's permanent environment; stack identity separates their resources. Each has its own console origin, data, operator sessions and MCP consent. Set `UMAIL_URL` to the selected origin for CLI login, with a separate `XDG_STATE_HOME` if keeping both CLI logins.

Pass `--env-file <file>` to every Alchemy command for that installation (`deploy:stage`, `alchemy plan`, `destroy`, `logs`, profile commands). It replaces the default `.env` and takes precedence over the shell; without it, the shell takes precedence over the optional `.env`. Shell values fill variables absent from an explicit file, so keep the file complete and check shell overrides. Always dry-run with the same file, profile and stage before deploying or destroying. The plan's stack name must match the intended installation; unexpected creates for an existing installation indicate the wrong identity/account/stage.

For an independent installation with its receiving children and shared foundation ready:

```sh
pnpm deploy:stage --env-file .env.second --stage prod --profile mschwarzmueller --dry-run --no-input
pnpm deploy:stage --env-file .env.second --stage prod --profile mschwarzmueller --no-input --yes
```

`UMAIL_MAIL_DOMAINS` is required JSON: each normalized, unique `{ name, receive, send }` entry must have a capability, and at least one must receive. `UMAIL_DOMAIN` is the console hostname. Existing installations explicitly retain their original mail domain and `send: true`. Academind starts with `[{"name":"mail.academind.ai","receive":true,"send":false}]`; receive-only mailboxes cannot send, including jobs revalidated when claimed.

Alchemy adopts ready receiving registrations or onboards only a named child. Cloudflare's child API implicitly enables the zone and adds shared DKIM if absent, so the provider requires those shared settings to exist before writing. A foreign-MX apex reporting `misconfigured` is expected; it is never repaired. For a fresh zone, arrange the shared foundation separately with the zone owner's go. No deployment creates an apex MX or modifies zone-wide routing/catch-all options. See [ADR 0011 and the isolated SMTP proof](../adrs/0011-recipient-routing.md).

**Academind deployment still needs Max's go.** Its zone is in company@academind.com's account, not the personal deployment account. Prepare the complete private file/profile, scoped tokens and child DNS plan; preserve Purelymail's apex MX, SPF and DMARC. Review the dry-run for this exact stack/account/stage before deployment. If OAuth cannot renew, skip the rehearsal and run it after login, before any deploy.

`UMAIL_OPERATOR_EMAIL` must be outside every receiving domain and its children, since a client that reads that inbox could approve its own sends. Changing `UMAIL_OPERATOR_PASSWORD` and redeploying invalidates sessions and OAuth grants; unchanged credentials preserve them. Approval links use Alchemy's retained `NotificationKey`; replacing it breaks pending unsent notifications. Replace Cloudflare tokens through their issuing account, update private configuration, redeploy, and explicitly retry failed routing after its cause is fixed.

Upgrading an existing deployment across [ADR 0001](../adrs/0001-consistent-mail-and-access-flows.md) needs a full reset (see [Stages and removal](#stages-and-removal)): the Worker, the store's schema, and the auth database changed. Afterwards every client authorizes again, and mailboxes and forwarding are recreated.

## Routing credentials

Create a separate rules token for each installation: Cloudflare account → **Manage account → Account API tokens → Create Token → Custom token**; choose only **Zone → Email Routing Rules → Edit**, with **Include → Specific zone** for its receiving zone(s), then **Continue to summary → Create Token**. Save it as `CF_EMAIL_ROUTING_RULES_TOKEN` in that installation's private env file; never paste it into a message. It is a Worker secret, separate from the account-wide forwarding token `CF_EMAIL_ROUTING_TOKEN`; it needs no DNS, settings or token-provisioning permission.

Alchemy beta.81 provides a stack-owned `AccountApiToken` resource, but creating one requires `Account API Tokens Write`. Task 931 checked the refreshed personal/Academind profiles and company `cf` OAuth: account reads succeeded while the account-token endpoint refused them with 403/9109, and their scopes lack that permission. These credentials cannot own automatic token creation/deletion. A temporary test token must be revoked in the issuing dashboard after its stage is removed.

## Existing installation cutover

Keep the existing `UMAIL_STACK=uMail`, domain, profile, resource IDs and stage. Migration 0011 appends route intent without replacing old mailbox IDs, active flags or archives. Both live steps below require Max's explicit go; landing code deploys nothing.

1. Add the required original-domain manifest and rules token to the existing private env file. Keep `UMAIL_LEGACY_CATCH_ALL=true` for prod. For an existing dev/preview's first rollout, use `UMAIL_LEGACY_SEED_RULES=true`: only its stored Alchemy rule IDs can transfer to the controller. Dry-run the controller deploy. The old zone foundation is relinquished with retention; the catch-all stays unchanged. The transitional providers never create, re-enable, retarget or delete a live route.
2. After deployment, the alarm backfills literal rules for every existing mailbox, including paused mailboxes. Check readiness in the console/CLI. With `UMAIL_URL` pointing at this install and the operator CLI already authorized, run the observation-only command:

   ```sh
   pnpm umail addresses cutover --zone <original-zone-id> --env-file .env
   ```

   It lists all non-retired mailbox/rule IDs, verifies enabled literal rules with the exact installation owner/address/Worker across every receiving zone, and prints the owned catch-all's proposed disable/drop change. Missing, pending, conflicting or foreign coverage makes it unready. Only after reviewing this plan and Max's go, run again with `--execute`. That operation disables only the verified owned catch-all; it changes no mailbox rules, DNS or zone settings. After confirmed success, set `UMAIL_LEGACY_CATCH_ALL=false` in the private file and dry-run the next deploy to relinquish retained state. Once seed-rule transfer is verified, clear `UMAIL_LEGACY_SEED_RULES` the same way.

The production Alchemy dry-run and cutover inventory are separate proofs. Runtime-created mailbox rules cannot appear as Alchemy resources: they exist only after the controller rollout. A deploy dry-run alone cannot demonstrate successful backfill. Never remove the existing catch-all with the first rollout.

## Sending and due work

One Worker, `App`, serves HTTP and MCP, receives mail, consumes the MailIndex queue, and hosts the AccountStore Durable Object. The store does its own due work on its Durable Object alarm. Each change that creates work (a submit, an approval, a new inbound receipt) sets the alarm for the earliest due work, and so does the store starting up. A pass then:

- expires due approvals and rejects their unsent jobs (the only place approvals expire);
- sends up to 10 ready jobs, and runs again at once while more are waiting;
- settles a claim abandoned mid-send as `unknown` once its 15-minute claim expires, never sending it again;
- redrives inbound mail still unindexed 5 minutes after it arrived, then every 1–30 minutes depending on its age;
- reconciles up to 10 due mailbox routes, with persisted retries for temporary failures and explicit retry after permission/ownership errors.

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

- Within each `UMAIL_STACK`, `prod` uses `UMAIL_DOMAIN`. Other stages use `<stage>.<domain>` for HTTP and `<stage>-mail.<domain>` for mail, with seeded `inbox` and `probe` addresses. Of these, only `dev` provisions sending: it persists, sends real mail, and incurs charges. Each stage keeps its mail data in one AccountStore Durable Object, addressed by the fixed name `operator`.
- Preview names are lowercase DNS labels, at most 58 characters, without leading/trailing hyphens. Renaming a stage does not migrate data.
- Every stage registers only its declared receiving domains. Preview domains derive from each manifest entry (`<stage>-mail.<domain>`), and runtime seed mailboxes receive literal rules through the controller. New stages never manage a catch-all or enable a zone; the shared foundation must already exist.
- Deleting a conversation hides it; archived objects remain. Destroying a stage can delete AccountStore data.
- Before removing a preview, retire all its mailboxes and verify their owned rules are removed; Alchemy does not own or delete those runtime rules. Destroying `prod` or `dev` retains AuthDb, MailArchive and receiving registrations; retained resources can incur charges. A preview removes its data and uses the proved named DNS DELETE to remove only its receiving child registration/records. Shared routing/DKIM stay as they were.
- Never call zone-wide routing disable or an unnamed DNS DELETE on a shared zone. Apex registration removal is refused. Inspect DNS, registrations, rules and shared settings after cleanup; report leftovers and preserve every other installation. The temporary unused-zone proof alone restored routing off and removed its task-owned shared foundation, because its starting zone was empty and Max explicitly authorized that isolated test.
- For an intentional full reset of `prod` or `dev`: inventory/protect data, review and destroy the exact stage, then empty/delete its retained archive and database, remove its Email Routing domain registration, and inspect leftover DNS. Forwarding destinations are account-wide Cloudflare resources that survive a reset; `forwarding set` adopts an existing one. Never delete retained resources while old stage state still references them. Preserve shared zone routing, the Alchemy state store, and other stages. Verify removal before redeploying.

## Dependency patches

`pnpm-workspace.yaml` applies these patches from `patches/`.

To change a patch, run `pnpm patch <pkg>@<version> --ignore-existing --edit-dir <dir>`, edit the files there, then `pnpm patch-commit <dir>`. Never hand-edit a `.patch` file: `node_modules` keeps the package under its patch hash, so the old patched code stays installed and tests pass whatever the patch says. Afterwards check that the lockfile's patch hash changed and grep the installed file under `node_modules/.pnpm/<pkg>@<version>_patch_hash=…`.

| Patch                               | What it does                                                                                                                                                                                                                                                                                                                                    | Test that covers it                                                                                                                                                                                                                                                                                                             | Upstream issue                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `alchemy@2.0.0-beta.81`             | Alchemy PR #1923: a silent OAuth refresh reloads the profile inside the credentials lock, so concurrent deploys and `alchemy profile show` on one profile spend Cloudflare's single-use refresh token once instead of revoking the grant. Remove when upstream ships the PR.                                                                    | `tests/alchemy-refresh-lock.test.ts`                                                                                                                                                                                                                                                                                            | [#1923](https://github.com/alchemy-run/alchemy/pull/1923) |
| `@better-auth/oauth-provider@1.7.7` | Lets `cursor://anysphere.cursor-mcp/oauth/callback` pass the native private-use redirect check. `auth/options.ts` admits that URI only in Cursor's registration profile, which it registers as a native client. Remove when upstream ships the equivalent.                                                                                      | `apps/server/test/api/oauth.test.ts`: "registers Cursor's MCP profile and honors its private-use callback", "rejects Cursor's private-use callback outside its registration profile"; `apps/server/test/api/auth-boundaries.test.ts`: "registers an explicit native Cursor profile and rejects native registrations outside it" | TODO                                                      |
| `postal-mime@4.0.5`                 | Adds MIME parse budgets checked before allocation, makes `maxPartCount` count the parts of nested messages too, decodes base64 into blocks rather than a buffer per padded unit, and joins decoded chunks into one buffer instead of a Blob. The limits are set in `apps/server/src/mail/policy.ts`. Remove when upstream ships the equivalent. | `apps/server/test/mail/mime-budgets.worker.spec.ts`, `apps/server/test/mail/mime-decoder.test.ts`                                                                                                                                                                                                                               | TODO                                                      |
