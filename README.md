# AgentMail

Self-hosted email for one operator on Cloudflare. Receive, archive, forward, and send mail through a CLI or an AI assistant connected over remote MCP.

There is no IMAP/SMTP server. The browser handles login, client permissions and send approvals, and a small [web console](#web-console) reads and sends mail. Inbound attachments can be downloaded; outbound messages support text/HTML bodies without attachments.

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

| Variable                  | Required for          | Value                                                                                                 |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `UMAIL_DOMAIN`            | Deployment            | Hostname and mailbox domain, e.g. `mail.example.com`; no scheme/path.                                 |
| `UMAIL_OPERATOR_EMAIL`    | Deployment            | Existing inbox outside `UMAIL_DOMAIN`, since it approves sends; the only operator allowed to sign in. |
| `UMAIL_OPERATOR_PASSWORD` | Deployment            | Unique password of at least 12 characters.                                                            |
| `CF_EMAIL_ROUTING_TOKEN`  | Deployment            | Forwarding-management token described above.                                                          |
| `UMAIL_URL`               | CLI                   | HTTPS origin, e.g. `https://mail.example.com`; export in your shell; not read from `.env`.            |
| `CLOUDFLARE_ACCOUNT_ID`   | Token deployment only | Target account ID; omit when using an OAuth profile.                                                  |
| `CLOUDFLARE_API_TOKEN`    | Token deployment only | Deployment token; leave unset when using an OAuth profile.                                            |

Set up deployment authentication:

```sh
pnpm exec alchemy profile edit
```

Configure the `default` profile, select your account, and choose **OAuth → All Scopes**. Leave `CLOUDFLARE_API_TOKEN` commented out in `.env` and run `unset CLOUDFLARE_API_TOKEN` to remove any shell override. Alchemy generates the application signing secret and the approval-link key.

For automated/token deployment, set both Cloudflare variables instead. The deployment token needs Workers, D1, R2, Queues, Secrets Store, DNS/custom domains, zone Email Routing settings/rules, and Email Sending access. It is separate from `CF_EMAIL_ROUTING_TOKEN`. With `CI=true`, Alchemy uses token authentication and ignores profiles.

## Deploy

```sh
pnpm exec alchemy plan --stage prod --profile default
pnpm exec alchemy deploy --stage prod --profile default
```

Review the plan before confirming. The first deployment may also prompt to create Alchemy's shared state store. For a named profile, replace `default` consistently.

Open `https://mail.example.com/login` and sign in; you land on `/mail`. Check Cloudflare's domain/DNS readiness if the hostname is unavailable. **Create a mailbox next,** on `/mailboxes` or with the CLI below: production deployment alone creates no inbox.

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

The operator CLI sends without approval. Sending is asynchronous and usually starts within seconds. `accepted` means provider acceptance, not recipient delivery; `rejected` means the provider refused or failed the message; investigate `unknown` before resending.

Every submission carries a `requestId` (a UUID, any case). The CLI generates one unless you pass `--request-id <uuid>`; REST and MCP callers must send their own. Resubmitting the same ID with the same content returns the existing job and never sends twice, so it is the safe retry after a lost response. When the CLI cannot tell whether a submission arrived, it prints the ID to retry with. Any new send, including one after `rejected` or an investigated `unknown`, needs a new ID.

Errors say what happened and what to do, on one line prefixed `umail:`: the server's own message for a refused request (for example a recipient the client may not send to, or an id that was not found), or which step failed and why for a connection, sign-in or credential-file problem (for example `Could not reach https://mail.example.com during discovery (ECONNREFUSED)` or `… is open to other users (mode 644). Run: chmod 600 …`). REST errors are JSON `{"_tag", "code", "message"}` with a stable `code`.

To forward a mailbox's inbound mail, run `pnpm umail forwarding set --address-id <mailbox-id> --email <inbox>`. Cloudflare emails that inbox a verification link, and forwards only once it is confirmed; the command reports `verified`, so run it again to check. `pnpm umail forwarding remove --address-id <mailbox-id>` stops forwarding.

Run `pnpm umail --help` or `pnpm umail <command> --help` for more commands. Credentials live in `$XDG_STATE_HOME/umail/oauth.json` (default `~/.local/state/umail/oauth.json`); keep that file private. `pnpm umail logout` revokes the CLI's access on the server first and removes the local credentials only if that worked.

For another machine, run `pnpm build:clients`, copy `dist/clients/umail.mjs`, and use `node umail.mjs login` with Node.js 22.18+ and `UMAIL_URL` exported.

## Web console

After signing in at `/login`, the browser is a second operator surface next to the CLI:

- **Mail** (`/mail`): read conversations across all mailboxes or one, open messages, download attachments, mark conversations read or unread, delete them, and write new messages, replies and reply-alls. Opening a conversation marks it read, and read state is shared, so agents and the CLI that list only unread mail no longer see it. Each send shows its status.
- **Mailboxes** (`/mailboxes`): create mailboxes, rename or pause them, and set or stop forwarding.
- **Clients** (`/clients`): see every client with access, change what it may do, or revoke it.

It is not an everyday mail client: there is no search, no drafts, no attachments or HTML on outgoing mail, and no live updates. HTML bodies render in a sandboxed frame that loads no images, remote or inline; inline images are listed as attachments. Send approvals still happen from the approval email's link.

## Connect an AI assistant

Add `https://mail.example.com/mcp` as a remote HTTP MCP server in a client supporting OAuth discovery and dynamic registration. The server advertises itself as **AgentMail** with an icon at `https://mail.example.com/icon.png`. Sign in as the operator and approve access; no API key is needed.

Tools: `umail_list_sending_identities`, `umail_list_threads`, `umail_list_messages`, `umail_get_thread`, `umail_get_message`, `umail_get_message_headers`, `umail_set_thread_read_state`, `umail_send_message`, `umail_reply_to_message`, `umail_get_job`.

**The consent screen decides what a client may do:** which mailboxes it may use (default: all) and whether it may send without approval (default: every send waits for your approval at the operator inbox). A client gets no access until you consent. `https://mail.example.com/clients` lists every client with access, including the CLI; change a client's mailboxes, recipients, or send mode there, or revoke it. Revoking ends its access at once; the client can ask again and you see the consent screen again.

## Update

Keep the same account, profile, stage, and private configuration:

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm exec alchemy plan --stage prod --profile default
pnpm exec alchemy deploy --stage prod --profile default
```

Password changes require redeployment and invalidate existing sessions/grants. Verify a mail round trip after deployment. **Deleting a conversation hides it but does not erase its archived raw objects.**

This project uses prerelease Alchemy/Effect dependencies and [maintained patches](docs/operations.md#dependency-patches). There are no stable release or support guarantees yet. See [operations and recovery limits](docs/operations.md).

Licensed under [MIT](LICENSE.md). The Oxlint plugin in `tools/oxlint/anti-slop` is vendored from [anti-slop](https://github.com/dmmulroy/anti-slop) by Dillon Mulroy (MIT).
