# AgentMail (umail)

Setup, deploy and update steps are in [README.md](README.md). Stages, previews and cleanup are in [docs/operations.md](docs/operations.md). Decisions and their plans are in [adrs/](adrs/).

## Deploy

Max's stages deploy from the repo root; there is no CI deploy. Dry-run first (`--dry-run --no-input`) and read the plan:

```sh
env -u CLOUDFLARE_API_TOKEN pnpm exec alchemy deploy --stage prod --profile mschwarzmueller --no-input --yes
```

- The `mschwarzmueller` profile targets the account of the commented `CLOUDFLARE_ACCOUNT_ID` in `.env`. `default` has no Cloudflare provider, and other profiles target another account: a state-store prompt means the wrong profile.
- `App/AUTH_OPERATOR_ID` plans as "update" on every deploy (`AuthProvision` runs each time). That is harmless.
- Cloudflare allows one worker consumer per queue, and Alchemy creates the new consumer before deleting the old one. Before a deploy that moves a queue consumer to another worker, detach the old one (`DELETE accounts/{id}/queues/{qid}/consumers/{cid}`), then deploy.
- For Cloudflare API calls, use the profile's OAuth token (`values.access` in `~/.alchemy/profiles/mschwarzmueller/cloudflare.json`) and a browser-like User-Agent: Cloudflare answers Python's default urllib one with 403.
- A full reset ([Stages and removal](docs/operations.md#stages-and-removal)): dry-run both destroy and deploy, and delete the retained D1 and R2 by exact id through the API. Afterwards run `pnpm umail login` again and re-authorize the umail MCP client (`/mcp` in Claude Code).

## Server code runs in Node

`alchemy deploy` and the root worker tests evaluate `alchemy.run.ts`, `apps/server/src/app.ts` and all their imports in Node through Alchemy's Oxc loader, not the Worker bundler.

- No `?raw` imports (`ERR_UNKNOWN_FILE_EXTENSION`; the console stylesheet is `web/styles.ts` for this reason) and no `</script>` inside a tagged template.
- After adding non-TS imports or unusual syntax to server code, check: `node --import ./node_modules/alchemy/bin/register-oxc.js -e 'import("./alchemy.run.ts")'`.
- oxfmt formats `html` tagged templates as HTML, so assert on page markup whitespace-tolerantly.

## Formatting

`pnpm fmt` runs `oxfmt .` over the whole repo, Markdown included, and rewrites ADRs and plans you didn't touch. Run `pnpm exec oxfmt <paths you changed>` instead.

## Live checks on a preview

- Previews cannot send: every outbound job ends `rejected` with `E_SENDER_DOMAIN_NOT_AVAILABLE`. Approval emails never arrive, so approval-link pages exist only in the browser-spec fixtures.
- Inbound mail: send from prod AgentMail through the `umail` MCP tools to `probe@pr-<n>-mail.<UMAIL_DOMAIN>`; it goes out without approval.
- A failed forward: `forwarding set` to the preview's own `inbox@…`, which stays unverified. This creates an account-wide Cloudflare destination address; delete it afterwards with `DELETE accounts/{id}/email/routing/addresses/{id}` and `CF_EMAIL_ROUTING_TOKEN` (retry on 429).
- CLI login against a preview: set `XDG_STATE_HOME` to a scratch dir so Max's credentials stay untouched.
- MCP token: dynamic registration accepts only an https redirect (`https://example.com/callback`). Authorize in the signed-in agent-browser and read the code from the URL.
- Raw Workers Logs: `POST accounts/{id}/workers/observability/telemetry/query` with the profile token. `alchemy logs` flattens structured fields.

## UI changes

Review every UI change yourself in a browser before you report it. Never hand the visual check to Max: a UI change that only Max has looked at is unfinished.

- Deploy a preview stage `pr-<n>` (the PR number) with the command you use for `prod` ([Deploy](#deploy)), swapping only the stage.
- Open `https://pr-<n>.<UMAIL_DOMAIN>/login` with agent-browser. Sign in with `UMAIL_OPERATOR_EMAIL` and `UMAIL_OPERATOR_PASSWORD` from `.env`. Pass them as shell variables (`set -a; . ./.env; set +a`) and never print their values.
- Review every page the change touches in light and dark mode (`agent-browser set media dark|light`), at desktop width and at 320px (`agent-browser set viewport 320 800`).
- Report what you saw, with screenshots.
- Destroy the preview when you're done. Its mail domain stays registered in Email Routing, so tell Max it needs cleaning up by hand ([Stages and removal](docs/operations.md#stages-and-removal)).
- Never run `alchemy dev` against Max's `dev` stage without asking him first.
