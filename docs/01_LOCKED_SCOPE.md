# 01 — Locked public v0.1 scope

## Product sentence

A single-operator website form gateway that retains fields and PDF files in durable storage before handing a notification to a configured SMTP server.

## Required user journey

1. Operator copies a checked-in forms.example.json to ignored config/forms.json and sets one recipient/sender per form.
2. Operator starts PostgreSQL, Mailpit and ClamAV locally; starts API and worker.
3. Visitor submits a configured form with fields and up to five PDFs.
4. API returns a receipt only after persistent file storage and SQL commit.
5. Worker scans every PDF, composes one immutable notification and submits it to Mailpit.
6. Operator lists/shows the submission and exports a clean PDF with the CLI.
7. If SMTP is unavailable, the record remains. If handoff may have succeeded, notification becomes unknown.

## Required features

| Area       | Build exactly                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------- |
| HTTP       | GET /health/live, GET /health/ready, POST /forms/:form_id                                      |
| Input      | Configured text/email/url fields plus PDF attachment parts                                     |
| Data       | PostgreSQL; versioned SQL migrations                                                           |
| Files      | Private persistent disk, generated keys, checksums, scan-before-release                        |
| Mail       | Plain-text notification, one fixed recipient, one fixed From, optional validated Reply-To      |
| Queue      | Notification rows form the transactional outbox; separate worker process                       |
| Inspection | Host-local CLI; no operator HTTP APIs                                                          |
| Demo       | Static sample HTML + scripted verification, synthetic PDF, local Mailpit                       |
| Security   | Type/size checks, CAPTCHA in production, throttles, no public data reads                       |
| Release    | Tests, CI, README, white paper, license, source notices, local package/container archive check |

## Explicit exclusions

Do not build:

- web dashboard, sessions, login, owner APIs or frontend framework;
- user registration, organizations, multi-tenant customer accounts;
- subscriptions, payments, private paid modules or pricing pages;
- a general-purpose /send or /emails API;
- DOC/DOCX, image, archive or arbitrary attachment formats;
- attachments from URLs, inline image fetching, HTML email, templates editor;
- public download URLs, bearer file links, SMTP server, DKIM signer, mailbox/IMAP;
- cloud Worker app, S3, Redis, ORM, message broker or orchestration system;
- Postal installation, production DNS, external sending or live public deployment.

A CLI has no authentication because it requires operator OS/database/storage access. It must not be exposed as a public HTTP service.

## Numerical limits

- 5 files, raw combined <= 10,485,760 bytes; each <= 10,485,760.
- Multipart aggregate <= 11,534,336 bytes, including boundaries and text.
- At most 20 configured fields; key <= 40 ASCII characters.
- At most 4,000 Unicode code points per text value; all UTF-8 text <= 65,536 bytes.
- 30 multipart parts maximum; no duplicate non-file fields.
- Final MIME <= 20,971,520 bytes and <= configured SMTP maximum.
- 5 form attempts/minute/form+IP, 100 attempts/day/form; failed validations still count.
- Maximum 2 in-flight upload requests per API process; return 503 when full.
- Production storage refuses new uploads below 1 GiB free disk; make threshold configurable.
- Default content retention 90 days; orphan files 24h.
- One sending worker process. PostgreSQL advisory lock prevents accidental second sender.
- SMTP handoff budget: initial try plus four known-safe retries at 60, 300, 1,800, 7,200 seconds.
- Lease 120 seconds, heartbeat 20 seconds, scanner 30-second deadline, SMTP socket 30-second deadline.
- PDF scan freshness <= 48h; ClamAV signature age <= 48h.

These defaults are product limits, not measured throughput.

## Configuration authority

Configuration is validated once at startup. Each accepted submission retains the normalized form configuration snapshot. Editing config affects future submissions only. The recipient, From, subject prefix and redirect cannot come from the visitor.

Public form IDs are names, not secrets. A CAPTCHA and throttles are required for production. CORS/Origin filters alone do not authenticate callers.

## Completion and future boundary

Finish all G00–G12 tests before a software release. The initial repository can be published with its current honest specification-stage README. Future commercial functionality is not a task in this repository build.

If the coder proposes a feature absent from this file, do not implement it. Put a one-line idea in the proposed-work section of BUILD_STATUS.md and continue the defined work.
