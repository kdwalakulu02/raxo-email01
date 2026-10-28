# Repository instructions for coding agents

## Authority

For this public build, use the documents in this repository. Do not import scope from an older Raxo planning pack, private roadmap or conversation. Current direct user instructions override this file.

If two current documents conflict, do not guess: record the conflict in BUILD_STATUS.md and resolve it before the affected implementation. The locked scope and contracts govern feature meaning; tickets govern order.

## Scope lock

Build the exact local-first form gateway in docs/01_LOCKED_SCOPE.md. The earlier full email platform is not this release. No private dependency, dashboard, sending SaaS, billing, mailboxes, cloud deployment or SMTP engine.

Use one npm package, TypeScript, Fastify, PostgreSQL, disk storage and Nodemailer. Keep HTTP and worker as separate processes sharing modules. No React, Next.js, Redis, S3, Drizzle, ORM, event bus, Kubernetes, Rust rewrite or CLI framework.

## Working rules

- Inspect current repository before edits; preserve user work.
- Follow G00–G12 sequentially. Each ticket has files, outputs and a stop gate.
- Keep route handlers small; parsing, persistence, MIME and SMTP belong in their modules.
- Do not leave TODO/stub/mock on a completed runtime path.
- Test doubles are only in tests and loopback demo mode; production rejects them.
- Never disable assertions, skip required integration tests, silently swallow a failure, or fake success.
- Use parameterized SQL and transaction-safe writes.
- Do not rename fields/states or change status semantics.
- An accepted submission is durable before HTTP success.
- SMTP acceptance is called submitted, never delivered or read.
- Uncertain sends are unknown and never automatically repeated.
- Files never become public URLs.
- Produce small meaningful commits only if instructed; never reset user data or force-push.

## Data and publication

Only synthetic example data. No credentials, CVs, logs, SMTP transcripts, dumps, hidden planning ZIPs or real business recipient lists in git.

Create .gitignore and .dockerignore before local runtime files. Runtime configuration lives in ignored config/forms.json and .env; checked-in examples use .test addresses.

Do not initialize a parent folder containing other packs. Do not create a remote, push, create a GitHub release, publish a package, buy a server, change DNS or send external email without instruction. These instructions prepare a publishable repo; they do not authorize those actions.

## Claim accuracy

README starts as design stage. Update only features actually passing tests. Local Mailpit evidence is not Internet deliverability evidence. This project does not ship a mail server or an uptime guarantee.
