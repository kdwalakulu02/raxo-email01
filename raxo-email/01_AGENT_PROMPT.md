# Copy this prompt into the coding agent

Implement this repository, not the earlier all-product Raxo roadmap.

Read these files before editing source:

1. AGENTS.md
2. docs/01_LOCKED_SCOPE.md
3. docs/02_FILES_AND_COMMANDS.md
4. docs/03_CONTRACTS_AND_SQL.md
5. docs/04_PROCESSING_RULES.md
6. docs/05_IMPLEMENTATION_TICKETS.md
7. docs/06_ACCEPTANCE_TESTS.md
8. docs/07_GITHUB_PUBLICATION.md

Build exactly Raxo Email Forms Core: one Node/TypeScript application with HTTP and worker entry points, PostgreSQL, private disk attachments, configured form recipients, SMTP handoff, CLI inspection/export and a Mailpit local demo.

Do not create a web dashboard, billing, signup, SaaS account system, private repository, generalized send API, IMAP server, custom SMTP implementation, cloud Worker or live mail deployment.

Execute tickets G00 through G12 in order. Complete one ticket, run its acceptance checks and write its evidence into BUILD_STATUS.md. Continue to the next ticket while authorized local work remains. Do not stop after merely describing a plan.

Never mark an unchecked or skipped requirement complete. If a test fails, fix it before proceeding. If a ticket cannot be completed, record the exact blocker; continue only work that does not depend on that blocked ticket. Do not disable a test or relax a contract to get green results.

At G00 establish the exact project file tree, Node pin, npm lockfile, dependency versions and image digests. Use the supplied contract names. Do not replace PostgreSQL with SQLite or introduce a monorepo/framework.

Before each ticket state its ID and files being changed. After it, record actual commands/results, unresolved items, and next ticket. Keep BUILD_STATUS.md concise and free of secrets.

All real outgoing mail is prohibited in this build. SMTP points at local Mailpit. DEMO_MODE=true is loopback-only and rejected in production. No remotes, pushes, package publication, DNS changes or deployment until explicitly requested. GitHub preparation and local git commits may be done when requested.

Initial action: inspect existing files and git status; preserve unrelated work; read the documents; start G00. Do not implement several speculative features at once. Do not ask me to choose a stack: it is already selected.

When all tickets pass, provide the local demo command, test summary, produced repository files, remaining limitations and the exact publish commands from docs/07_GITHUB_PUBLICATION.md. Do not claim the repo is published until the push is actually successful.
