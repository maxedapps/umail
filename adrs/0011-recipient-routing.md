# ADR 0011: Mail domains and automatic recipient routing

Status: Accepted (independent plan review, 2026-10-13)

## Context

ADR 0010 isolates an installation's Alchemy state, but its receiving setup still enables a zone and assigns its catch-all to the App Worker. Runtime mailbox creation relies on that catch-all. Max chose automatic literal rules so a second installation can receive at `mail.academind.ai` while Purelymail retains the apex.

The prerequisite was proved on the approved, unused `vps-course.com` zone in Academind's account on 2026-10-13. A named child registration received a real SMTP message through a literal rule while the external apex MX, SPF, DMARC and catch-all remained unchanged. All temporary DNS, routing, Worker and storage changes were removed; the zone is again empty with routing off. [Evidence](https://agents.academind.ai/artifacts/umail-931-vps-course-proof/).

The API has shared effects: creating a child also enables the zone flag and adds `cf2024-1._domainkey.<zone>` if missing. It reports the foreign-MX apex as misconfigured although the child receives correctly. Named DNS DELETE removes the child registration and its records without disabling the zone. The current `cf` CLI schema and live proof expose that DELETE body; the pinned SDK and rendered DELETE documentation do not.

## Decision

- Require a validated `UMAIL_MAIL_DOMAINS` JSON manifest of `{ name, receive, send }` entries, separate from the web hostname `UMAIL_DOMAIN`. A mailbox selects a receiving domain. Keep the existing resource identities and stage policies; derive fresh child domains for previews so their runtime controller cannot route production addresses. The existing installation's manifest explicitly names `mail.schwarzmueller.sh` with its current sending capability; Academind initially receives only.
- Alchemy resolves zones and onboards the declared receiving children. It never calls zone/apex routing enable, changes the zone's routing options, or declares mailbox rules. Before a named create, require routing already enabled and the shared Cloudflare DKIM foundation already present without a conflict. Otherwise fail before writing and explain the separate zone setup needed. A foreign apex MX is expected, never repaired. An already registered domain is adopted without re-onboarding. Production receiving domains are retained on destroy; a disposable stage removes only its named children.
- Use the existing AccountStore Durable Object and SQLite database for mailbox route intent and observation. Creating a mailbox commits `pending` and arms its alarm. The alarm creates one enabled literal rule, records its ID, and exposes `ready`; failures expose `error` with a retry time. Retry transient failures through the same alarm, independently of outbound and receipt work. A user can retry after correcting a permanent failure.
- Give every rule a stable ownership name derived from installation, stage and mailbox ID. Exhaustively inspect rules before creation. Recover an uncertain creation by its ownership name and exact address/Worker target. Refuse another owner's literal rule for the address; never adopt it merely because its target looks convenient. Read and verify ownership before updates/deletes. Persist a returned rule ID even if the mailbox was retired while the request was in flight, then reconcile deletion.
- Pause preserves the enabled Cloudflare rule; the existing inbound policy rejects the paused mailbox. Retire marks the mailbox retired, schedules deletion of its owned rule and retains its archive. Routing state and lifecycle are separate: retirement can still have a pending/error deletion. Retired mailboxes cannot send or be resumed as ordinary paused mailboxes.
- Bind `CF_EMAIL_ROUTING_RULES_TOKEN` as a redacted Worker secret in both Worker/DO construction, with only **Email Routing Rules: Write** on this installation's zones. Keep the existing account-wide forwarding-destination credential separate. The rules client uses the pinned distilled SDK, Effect HTTP client and no hidden request retries; the Durable Object owns durable retry timing. Honor the SDK's transient classification before terminal tags, including temporary authentication faults; only permanent credential failures request operator correction. It has no DNS, zone settings or catch-all operation.

Alchemy beta.81 has an `AccountApiToken` resource that persists its redacted value and injects it as a Worker secret. Automatic token ownership would be preferable with a provisioning credential. The authenticated `mschwarzmueller` and `academind` profiles and company `cf` OAuth login were checked on 2026-10-13: account reads succeed, but account-token GET and POST return 403/9109 Unauthorized, and their scopes omit the API's required `Account API Tokens Write`. The POST authorization probe used an empty body, which cannot create a token. Therefore each installation supplies its narrowly scoped rules token in its private env file; do not add a nonfunctional token resource or grant the runtime token provisioning rights. Dashboard creation is documented in operations.

- Filter sending identities and enforce sending permission by manifest capability, including API/MCP submissions. Keep the existing installation's sender and approval-notification behavior. Receive-only installations cannot submit outbound mail; adding sender domains and sender/reply mappings is later work. Approval mail must remain outside every hosted receiving domain.

### Existing installation cutover

This is a migration with two live steps, both requiring Max's later go. It cannot be completed by an offline Alchemy dry-run: the app owns the literal rules and must run before they exist.

1. Deploy the controller while preserving the existing catch-all. An explicit `UMAIL_LEGACY_CATCH_ALL=true` is only for the existing stack/stage with stored `MailCatchAll` ownership. Its transitional provider preserves the observed route, refuses creation/takeover and retains it on removal; it never rewrites another catch-all. Retain the former `MailRouting` resource's zone foundation. Seed route intent for every existing mailbox, including paused ones, and let the alarm backfill. Handle the old Alchemy-owned preview seed rules through explicit ownership transfer, not opportunistic adoption.
2. A separate migration command first prints a dry-run inventory of mailbox/rule readiness and the exact owned catch-all change. It refuses execution until every non-retired mailbox is covered by its verified literal rule. With explicit execution, it disables only the catch-all currently pointing to this installation, confirms completion, after which the operator clears the transitional env flags and the next deploy relinquishes retained Alchemy state. Subsequent installations and deploys never manage a catch-all. A missing/foreign route or unavailable readiness check leaves the catch-all in place.

The first production dry-run must preserve receiving and list the Worker/configuration updates and any retained routing state. A later cutover dry-run lists the backfilled rules and catch-all disable operation. No production or Academind changes are authorized in this task; both plans and the required live steps are reported before Max gives his go.

## Alternatives

- Keep the current catch-all: simplest code, but it cannot meet independent recipient ownership and zone safety.
- Declare every mailbox/rule in Alchemy: simpler reconciliation, but each new mailbox would require a deployment. Max chose runtime creation.
- Enable a zone implicitly on each child create: the platform allows it, but it can reactivate unrelated routing. Require the shared foundation instead.
- Remove the catch-all with the first controller deploy: risks dropping existing mail before asynchronous backfill. Preserve it until independently verified coverage exists.

## Consequences

Mailbox creation is visibly asynchronous. SQLite route intent survives eviction, API outages and uncertain writes. A zone-scoped token still authorizes more rules than this app owns; ownership checks bound the application's behavior. Cloudflare domain/rule quotas remain deployment constraints. A new zone needs explicit shared foundation setup before an install can onboard its own children. The existing live service stays unchanged until the reviewed migration is explicitly approved and deployed.

Sources: [subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/), [DNS create](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/), [rules create](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/), [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/); installed Alchemy `2.0.0-beta.81`, distilled Cloudflare `1.0.0-rc.13`, Effect `4.0.2`, and `cf 1.0.0-beta.5` schema/live API journal.
