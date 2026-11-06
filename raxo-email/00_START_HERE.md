# Raxo Email — GitHub-only build instructions

Revision 2 | 25 October 2026

This pack replaces the earlier broad plan **for the first public repository only**. It deliberately reduces the first deliverable. It contains Markdown specifications, not a working application.

## Exactly what the coder must build

A self-hosted **form-to-email gateway with retained attachments**:

- A website posts to a configured form endpoint.
- The gateway durably stores the submission and files.
- A worker scans the files and sends one notification to a fixed recipient through the operator's SMTP server.
- The operator inspects submissions and exports clean files with a CLI.
- A local demonstration uses Mailpit; it sends no Internet email.

Working name: Raxo Email Forms Core. Suggested repository: raxocode/raxo-email.
This is a useful standalone component of the future raxo.email service.

## Not in this repository build

No commercial signup, billing, customer platform, dashboard, generalized email sending API, full mailboxes, IMAP, domain provisioning, MTA installation or cloud deployment. Do not implement these "to prepare for later."

PostgreSQL, storage and transport interfaces are reusable later. That is sufficient future preparation. There is no private folder or private package in this pack.

## What to do

1. Extract into a new empty working directory for raxo-email.
2. Keep the folder's CONTENTS at the repository root; do not nest raxo-email/raxo-email.
3. Give the coding agent [01_AGENT_PROMPT.md](01_AGENT_PROMPT.md).
4. The agent follows the tickets in order, using [AGENTS.md](AGENTS.md).
5. Publish documentation first if desired; its README must say design stage.
6. Publish working software only after every required test passes.

The only initial files are Markdown. The agent must generate the non-Markdown source/config/CI files named in the specification. Do not publish a claim of working code merely because the documents are uploaded.

## Build documents

| Document                          | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| docs/01_LOCKED_SCOPE.md           | Exact deliverable and forbidden additions         |
| docs/02_FILES_AND_COMMANDS.md     | Complete target tree, dependency rules, commands  |
| docs/03_CONTRACTS_AND_SQL.md      | Config, HTTP contract, exact baseline SQL         |
| docs/04_PROCESSING_RULES.md       | File, worker, SMTP, crash and deletion algorithms |
| docs/05_IMPLEMENTATION_TICKETS.md | Ordered tasks with allowed files and checks       |
| docs/06_ACCEPTANCE_TESTS.md       | Concrete fixtures and release assertions          |
| docs/07_GITHUB_PUBLICATION.md     | Documentation, CI and safe publishing             |
| docs/08_SOURCES_AND_DECISIONS.md  | Upstream references and locked decisions          |

The repository front matter is already supplied: README, white paper, license, security and contributing files. AGENTS.md and the agent documents may stay public: they contain no confidential operations.

## Definition of done

A fresh checkout starts locally. A synthetic job application with a PDF is retained, captured once in Mailpit, and exported with the same checksum. SMTP failure preserves the submission. A timeout with uncertain acceptance becomes unknown, never an automatic resend. Automated checks prove these behaviors.

No live SMTP account, business credential, production DNS or VPS is needed to meet the local release definition.
