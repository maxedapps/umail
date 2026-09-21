# Security

Security fixes target the current main branch; there are no maintained release branches.

Use this repository's **Security → Advisories → Report a vulnerability** form for private reports when available. Include the affected revision, reproduction steps, and impact using synthetic mail and credentials.

Private reporting is not enabled during private-repository preparation. If the form is unavailable, ask a maintainer to establish a private reporting channel without disclosing vulnerability details. Never include credentials, approval links, real messages, or exploit details in a public issue.

Before the public launch, maintainers must [enable private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), verify the form is accessible, and subscribe to security notifications.

Keep `.env`, Alchemy state, OAuth credential files, database exports, and mail archives out of issues and support bundles. Revoke or rotate any exposed credentials before cleaning up their copies.
