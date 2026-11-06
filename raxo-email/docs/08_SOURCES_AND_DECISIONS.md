# 08 — Locked decisions and primary sources

Reviewed 25 October 2026. Version-sensitive dependencies must be checked and pinned at G00. This source register is not a claim that software has been built.

## Scope decisions

| ID  | Locked choice                             | Reason                                                    |
| --- | ----------------------------------------- | --------------------------------------------------------- |
| D01 | Public first release is form gateway only | Small useful component with a clear demo                  |
| D02 | One npm package and no dashboard          | Reduce coder drift and moving parts                       |
| D03 | PostgreSQL + SQL files + disk storage     | Durable records without a new storage platform            |
| D04 | Notification row is outbox                | One acceptance transaction and no broker                  |
| D05 | Generic SMTP through Nodemailer           | Reuse operator infrastructure; no sending API vendor lock |
| D06 | Mailpit local capture                     | Development requires no real credentials                  |
| D07 | PDF only                                  | Bound validation and scanning scope                       |
| D08 | No public download route                  | Smaller authorization surface                             |
| D09 | Unknown outcome never auto-resends        | Avoid pretending SMTP has exactly-once semantics          |
| D10 | No cloud services needed for demo         | Reproducible public project                               |
| D11 | Turnstile only for production CAPTCHA     | CAPTCHA is distinct from email transport                  |
| D12 | MIT original material                     | Useful public reuse with preserved attribution            |

This revised public scope replaces the earlier broad architecture for the first GitHub deliverable. It does not implement or remove a future private service plan. Do not pull that plan into these tickets.

## Primary sources

| URL                                                                                  | Implementation use                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| https://nodejs.org/en/blog/release/v24.22.1                                          | Reviewed Node24 patched LTS baseline                                |
| https://github.com/nodejs/Release                                                    | Supported runtime schedule                                          |
| https://fastify.dev/docs/latest/Reference/Hooks/                                     | preParsing byte-counting stream lifecycle                           |
| https://github.com/fastify/fastify-multipart                                         | Streaming parts and aggregate limit caveat                          |
| https://github.com/fastify/fastify-multipart/security/advisories/GHSA-vmph-573x-85f6 | Do not select vulnerable multipart versions below10.1.1             |
| https://nodemailer.com/smtp                                                          | SMTP setup and TLS                                                  |
| https://nodemailer.com/errors                                                        | Structured SMTP errors; do not guess from text                      |
| https://nodemailer.com/message                                                       | MIME/attachment configuration                                       |
| https://nodemailer.com/transports                                                    | Buffered stream composition and transport responsibilities          |
| https://mailpit.axllent.org/docs/install/docker/                                     | Local SMTP/UI service                                               |
| https://mailpit.axllent.org/docs/api-v1/                                             | Capture verification; inspect actual pinned API before writing demo |
| https://www.postgresql.org/docs/17/sql-select.html                                   | Row locking and SKIP LOCKED                                         |
| https://docs.clamav.net/manual/Usage/Scanning.html                                   | Scanner readiness, signatures and private daemon endpoint           |
| https://docs.clamav.net/manual/Usage/ClamdProtocol.html                              | VERSION and INSTREAM framing                                        |
| https://developers.cloudflare.com/turnstile/get-started/server-side-validation/      | Fixed server-side verification, action/hostname validation          |
| https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/                  | No direct outbound SMTP port25 from Workers                         |
| https://github.com/postalserver/postal                                               | Possible operator-supplied mail engine; not bundled/rebranded       |

Use primary docs for the version actually installed. Do not invent Mailpit API paths, SMTP response IDs or scanner reply framing. The dependency ledger must record the exact tested versions, compatibility check and any advisory review.

## Explicit claim boundary

For this planning pack: Markdown content, links and archive boundary can be checked. No Raxo runtime code, SMTP transport, migration, demo, deployment or deliverability has been executed.

The future coder must fill BUILD_STATUS.md and docs/DEMO_RESULTS.md with actual evidence. Empty or synthetic intended results do not count.
