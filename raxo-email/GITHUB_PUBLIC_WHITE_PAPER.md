# Raxo Email Forms Core

## A recoverable form-to-email gateway

White paper, revision 2 — 25 October 2026 — RaxoCode

**Status:** proposed public component. This document describes an implementation target, not an operating email service or completed benchmark.

**Implementation status note (October 2026):** Raxo Email Forms Core v0.1.0-alpha has been implemented and verified against the specifications in this paper. All 46 unit and integration tests (U01–U06, A01–A11, S01–S03, W01–W11, C01–C04, R01–R05) and deterministic end-to-end local demo verification pass.

## Problem

A contact form or job application often ends its useful life in an email notification. If that message fails to arrive, an operator may have neither the submission nor its attachment available elsewhere.

The proposed gateway makes the saved submission the primary record. Email becomes a notification derived from that record.

## Defined first product

A single operator configures several named forms. A browser posts fields and optional PDF files to a form endpoint. The gateway durably stores the submission, places a notification in a database-backed queue, and returns a receipt. A worker scans the files and hands one notification to the configured SMTP server.

The operator inspects records and exports files using a CLI. There is no administrative website or public customer account system in the first release.

The initial format is PDF only. DOC/DOCX support is not silently claimed; it can be evaluated in a later release with additional validation. The initial recipient is fixed by configuration and cannot be supplied by a visitor.

## Architecture

One TypeScript package contains HTTP, worker and CLI entry points. PostgreSQL stores submission metadata and notification state. Private persistent disk stores uploads and composed MIME. A storage interface and transport interface keep later extension possible without adding cloud dependencies now.

The worker uses Nodemailer for MIME/SMTP handling. Local development targets Mailpit, which captures messages rather than delivering them to the Internet [S1, S2].

The application does not implement SMTP itself. An operator may connect it to a self-hosted mail engine such as Postal. That engine handles signing and remote delivery. No Postal installation or automated domain provisioning is part of this release.

## Recovery model

The acceptance boundary is a database transaction after upload persistence. The submission, attachment metadata and queued notification appear together. File-store writes that cannot be committed to the database are reclaimed as orphans.

The notification has an explicit state. A successful HTTP response means received. A positive SMTP handoff response means submitted to the configured mail server. Neither proves inbox placement or reading.

A connection can fail after a server has accepted a message. In that case the gateway records unknown rather than automatically replaying a potentially delivered message. Stable identifiers support investigation but do not create an exactly-once guarantee.

## Attachment controls

Files are bounded in count and bytes, stored with generated keys, checked for PDF type and scanned before notification or export. The database stores checksums for integrity checks. Pending, infected, incomplete or stale scan results block release.

No public download route or expiring bearer links are included. CLI exports require access to the operator host. This deliberately keeps the first release smaller.

Scanner availability and signature freshness are operational requirements. Malware scanning lowers known risk but cannot guarantee every file is harmless [S3].

## Scope and openness

The intended public repository contains the complete standalone component: contracts, source, tests, CLI, local examples and deployment boundaries. No private import is necessary to run it.

The first release excludes multi-customer onboarding, billing, full mailbox protocols, campaigns, tracking pixels and a general email API. These exclusions are deliberate, not hidden unfinished features.

The original material uses MIT. Other operators can reuse or host it under that license. RaxoCode does not claim authorship of dependency projects or a registered trademark.

## Verification before a software release

The required demonstration uses synthetic data: submit a PDF, inspect the saved record, capture a notification in Mailpit, export the PDF and compare checksums. Failure tests cover database rollback, oversized uploads, scanner failure, worker restarts and ambiguous SMTP outcomes.

The documentation release can be published before source code exists, provided its status remains explicit. A software release requires passing the acceptance matrix and a fresh-checkout demonstration. No external customer counts, uptime or deliverability results are asserted.

## Future reuse

The form contract, immutable submission snapshot, file checksum records, notification state model, SQL migrations and transport/storage interfaces can form part of a broader raxo.email product later. That does not require building a speculative commercial platform now.

Actual independent email delivery still requires appropriate mail infrastructure. Workers alone cannot directly connect to recipient SMTP servers on port 25 [S4].

## References

[S1] Nodemailer SMTP: https://nodemailer.com/smtp

[S2] Mailpit: https://mailpit.axllent.org/docs/install/docker/

[S3] ClamAV scanning: https://docs.clamav.net/manual/Usage/Scanning.html

[S4] Cloudflare TCP restrictions: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

The full implementation source register is in [docs/08_SOURCES_AND_DECISIONS.md](docs/08_SOURCES_AND_DECISIONS.md).
