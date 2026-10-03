# AgentMail (umail)

Setup, deploy and update steps are in [README.md](README.md). Stages, previews and cleanup are in [docs/operations.md](docs/operations.md). Decisions and their plans are in [adrs/](adrs/).

## UI changes

Review every UI change yourself in a browser before you report it. Never hand the visual check to Max: a UI change that only Max has looked at is unfinished.

- Deploy a preview stage `pr-<n>` (the PR number) with the profile and flags you use for `prod` ([README: Deploy](README.md#deploy)), swapping only the stage.
- Open `https://pr-<n>.<UMAIL_DOMAIN>/login` with agent-browser. Sign in with `UMAIL_OPERATOR_EMAIL` and `UMAIL_OPERATOR_PASSWORD` from `.env`. Pass them as shell variables (`set -a; . ./.env; set +a`) and never print their values.
- Review every page the change touches in light and dark mode (`agent-browser set media dark|light`), at desktop width and at 320px (`agent-browser set viewport 320 800`).
- Report what you saw, with screenshots.
- Destroy the preview when you're done. Its mail domain stays registered in Email Routing, so tell Max it needs cleaning up by hand ([Stages and removal](docs/operations.md#stages-and-removal)).
- Never run `alchemy dev` against Max's `dev` stage without asking him first.
