# ADR 0010: Name installations with UMAIL_STACK

## Status

Accepted.

## Context

Alchemy identifies this installation by Cloudflare account, stack `uMail` and stage. Copying the repository or changing `UMAIL_DOMAIN` does not create another installation. Max wants a separate installation at `mail.academind.ai`, while preserving the existing deployment and Purelymail's reception at `academind.ai`.

The pinned Alchemy beta.81 requires a string stack name at module import, before its CLI installs the dotenv ConfigProvider. Its native `--env-file` selects one installation's configuration; explicit files override the shell, while the shell overrides the default `.env`.

## Decision

Read and validate `UMAIL_STACK` through Effect Config in `site.ts`. Default an absent variable to exactly `uMail`: an upgrade with the existing private `.env` must select the same state and resource names. Document `UMAIL_STACK=uMail` explicitly in the example and existing-install instructions. Reject blank values, whitespace and punctuation rather than normalize installation identity. Accept 1–32 ASCII letters/digits/internal hyphens, starting with a letter, preserving case.

Resolve the name before constructing `Alchemy.Stack`, using Node's argument parser for `--env-file` (or Alchemy's typed forwarded options in a dev exec child) and Effect's env/dotenv providers with `preserveEmptyStrings: true`. Compose the providers with the CLI's precedence. Alchemy's loader drops empty strings, which could make a blank selected identity fall through to another stack; it cannot enforce this identity contract. Keep all existing resource IDs, stages, retention and routing unchanged. A different stack is a new installation; a valid typo also selects new state, visible in a dry-run. Each installation uses a private env file and the same ordinary `prod` stage. No installation-specific branch, copy or stage exception is needed.

Stop after stack selection. Cloudflare [documents literal subdomain recipients and apex-only catch-all](https://developers.cloudflare.com/email-service/configuration/subdomains/). Its [rule API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/) offers `literal`/`all`, with no domain wildcard contract. Alchemy's [current Routing provider](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.83/packages/alchemy/src/Cloudflare/Email/Routing.ts) still invokes zone-wide enable, as does the installed beta.81. Today's Create mailbox only writes application state. Removing the catch-all without provisioning each runtime recipient would break reception. Keeping that workflow requires the larger route-controller design from task 931, with scoped credentials and tracked readiness. The [named DNS endpoint](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/) does not establish coexistence with external apex MX; that contract needs verification before an Academind deployment.

## Alternatives

- Keep `uMail` hardcoded and edit copied repositories: simplest implementation, but splits maintenance and makes identity an undocumented code edit.
- Require `UMAIL_STACK`: prevents an omitted identity selecting the existing stack, but breaks every existing env file. The requested deployment preservation favors the existing identity as the default. New installations must explicitly set a different name.
- Use a brand-specific stage: current non-prod stage semantics create previews; changing those semantics obscures installation identity.
- Replace the catch-all with deploy-defined recipients: simpler routing ownership, but changes console/CLI creation and cannot preserve every runtime-created mailbox automatically.

## Consequences

Stack selection isolates application resources and auth/data namespaces, not physical zone routing singletons. Do not deploy to `mail.academind.ai` yet. It still needs the routing decision, supported child-only onboarding, its private env file, account/zone verification, subdomain DNS and Max's deployment approval. Never change the apex's Purelymail MX, SPF or DMARC.

The prod dry-run must target `uMail/prod` and show only the usual `App/AUTH_OPERATOR_ID` update. If authentication cannot refresh noninteractively, land the tested change and require that dry-run before any deploy. No deployment is authorized in this task.
