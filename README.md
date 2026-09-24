# AgentMail

Self-hosted email for one operator on Cloudflare. Receive, archive, forward, and send mail through a CLI or an AI assistant connected over remote MCP.

There is no IMAP/SMTP server or browser mailbox. The browser handles login, client permissions, and send approvals. Inbound attachments can be downloaded; outbound messages support text/HTML bodies without attachments.

Limits include 20 MiB raw inbound mail, 50 inbound attachments, and 50 recipients per outgoing message.

> **Every stage enables Cloudflare Email Routing for its mail domain's entire zone, and it stays enabled after the stage is destroyed. Production also replaces the zone's email catch-all**, even when using a subdomain. Explicit routing rules take precedence; AgentMail rejects recipients without an active mailbox. Deploy only where you intend to control the zone's email routing.

## Prerequisites

- A Cloudflare **Workers Paid** account with [Email Sending](https://developers.cloudflare.com/email-service/) available. Cloud usage charges apply.
- A domain with an active Cloudflare DNS zone in that account.
- An existing inbox for operator notifications and approval requests.
- Git, **Node.js 22.18+**, **pnpm 11.13.1**, and Linux/macOS for CLI credential storage.
- A [Cloudflare user API token](https://dash.cloudflare.com/profile/api-tokens) with **Account → Email Routing Addresses → Edit**, scoped to your account, for forwarding management.

## Install and configure

```sh
git clone https://github.com/maxedapps/umail.git
cd umail
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env`. Replace example domains with your own; keep credentials private.

| Variable                  | Required for          | Value                                                                                      |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `UMAIL_DOMAIN`            | Deployment            | Hostname and mailbox domain, e.g. `mail.example.com`; no scheme/path.                      |
| `UMAIL_OPERATOR_EMAIL`    | Deployment            | Existing inbox; the only operator allowed to sign in.                                      |
| `UMAIL_OPERATOR_PASSWORD` | Deployment            | Unique password of at least 12 characters.                                                 |
| `UMAIL_NOTIFICATION_KEY`  | Deployment            | 32 random bytes encoded as base64url; keep stable across deployments.                      |
| `CF_EMAIL_ROUTING_TOKEN`  | Deployment            | Forwarding-management token described above.                                               |
| `UMAIL_URL`               | CLI                   | HTTPS origin, e.g. `https://mail.example.com`; export in your shell; not read from `.env`. |
| `CLOUDFLARE_ACCOUNT_ID`   | Token deployment only | Target account ID; omit when using an OAuth profile.                                       |
| `CLOUDFLARE_API_TOKEN`    | Token deployment only | Deployment token; leave unset when using an OAuth profile.                                 |

Generate the notification key and copy the output into `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set up deployment authentication:

```sh
pnpm exec alchemy profile edit
```

Configure the `default` profile, select your account, and choose **OAuth → All Scopes**. Leave `CLOUDFLARE_API_TOKEN` commented out in `.env` and run `unset CLOUDFLARE_API_TOKEN` to remove any shell override. Alchemy generates the application signing secret.

For automated/token deployment, set both Cloudflare variables instead. The deployment token needs Workers, D1, R2, Queues, Secrets Store, DNS/custom domains, zone Email Routing settings/rules, and Email Sending access. It is separate from `CF_EMAIL_ROUTING_TOKEN`. With `CI=true`, Alchemy uses token authentication and ignores profiles.

## Deploy

```sh
pnpm exec alchemy plan --stage prod --profile default
pnpm exec alchemy deploy --stage prod --profile default
```

Review the plan before confirming. The first deployment may also prompt to create Alchemy's shared state store. For a named profile, replace `default` consistently.

Open `https://mail.example.com/login` and sign in. Check Cloudflare's domain/DNS readiness if the hostname is unavailable. **Create a mailbox next:** production deployment alone creates no inbox.

## First mailbox

```sh
export UMAIL_URL=https://mail.example.com
pnpm umail login
pnpm umail addresses create --local-part inbox --display-name "Inbox"
```

Open the verification URL printed by `login` and approve the CLI. Send a test email to `inbox@mail.example.com`, then read it:

```sh
pnpm umail messages list --direction inbound --limit 10
pnpm umail messages get --id <message-id>
```

Replace IDs with values returned by the preceding commands. To send, replace the recipient with an address you control:

```sh
pnpm umail messages compose \
  --from inbox@mail.example.com --to recipient@example.net \
  --subject "Hello" --text "Sent with AgentMail"
pnpm umail jobs get --id <job-id>
```

The operator CLI sends without approval. Sending is asynchronous and can take about a minute. `accepted` means provider acceptance, not recipient delivery; `rejected` means the provider refused or failed the message; investigate `unknown` before resending. To retry a submit whose response was lost, pass your own `--request-id <uuid>` and reuse it with the identical payload; this cannot send twice. Any new send, including one after `rejected` or an investigated `unknown`, needs a new ID; omit the flag to generate one.

For forwarding, run `pnpm umail destinations create --email <destination>`, follow the verification email, refresh with `destinations get --id <destination-id>`, then run `forwarding associate --address-id <mailbox-id> --destination-id <destination-id>`.

Run `pnpm umail --help` or `pnpm umail <command> --help` for more commands. Credentials live in `$XDG_STATE_HOME/umail/oauth.json` (default `~/.local/state/umail/oauth.json`); keep that file private and use `pnpm umail logout` to revoke the CLI grant.

For another machine, run `pnpm build:clients`, copy `dist/clients/umail.mjs`, and use `node umail.mjs login` with Node.js 22.18+ and `UMAIL_URL` exported.

## Connect an AI assistant

Add `https://mail.example.com/mcp` as a remote HTTP MCP server in a client supporting OAuth discovery and dynamic registration. The server advertises itself as **AgentMail** with an icon at `https://mail.example.com/icon.png`. Sign in as the operator and approve access; no API key is needed.

Tools: `umail_list_sending_identities`, `umail_list_threads`, `umail_list_messages`, `umail_get_thread`, `umail_get_message`, `umail_get_message_headers`, `umail_set_thread_read_state`, `umail_send_message`, `umail_reply_to_message`, `umail_get_job`.

**New clients can initially read all mailboxes.** Sending requires approval at the operator inbox; deletion and administration are disabled. Connect only trusted clients. After the first authenticated request, use `https://mail.example.com/clients` to narrow mailbox/recipient permissions, change sending policy, disable, or revoke access.

## Update

Keep the same account, profile, stage, and private configuration:

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm exec alchemy plan --stage prod --profile default
pnpm exec alchemy deploy --stage prod --profile default
```

Password changes require redeployment and invalidate existing sessions/grants. New Recovery cron triggers can take up to 15 minutes to start; verify a mail round trip after deployment. **Deleting a conversation hides it but does not erase its archived raw objects.**

This project uses prerelease Alchemy/Effect dependencies and [maintained patches](docs/operations.md#dependency-patches). There are no stable release or support guarantees yet. See [operations and recovery limits](docs/operations.md).

Licensed under [MIT](LICENSE.md). The Oxlint plugin in `tools/oxlint/anti-slop` is vendored from [anti-slop](https://github.com/dmmulroy/anti-slop) by Dillon Mulroy (MIT).
