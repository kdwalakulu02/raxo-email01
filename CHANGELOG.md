# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha] - 2026-10-25

### Added

- **HTTP Gateway (`src/http.ts`, `src/server.ts`)**: Fastify-based form gateway with streaming multipart parser (`@fastify/multipart`), rate-limiting (`src/rate-limit.ts`), Turnstile CAPTCHA bypass on loopback (`src/captcha.ts`), origin allowlisting, and atomic acceptance transactions.
- **Durable Storage & Scanning (`src/storage.ts`, `src/scanner.ts`)**: Private quarantine/clean/mime/tmp storage layout with atomic fsync, ClamAV daemon (`clamd`) integration with 48h signature freshness enforcement and EICAR detection.
- **Repository & Acceptance (`src/repository.ts`, `src/accept.ts`)**: PostgreSQL transactional persistence, idempotency deduplication on `_submission_id`, 24-hour expiration window, and 409 conflict detection.
- **MIME & SMTP (`src/mime.ts`, `src/smtp.ts`)**: Immutable plain-text MIME generation via Nodemailer `streamTransport`, strict outcome classifier (`submitted`, `safe_retry`, `failed`, `unknown`).
- **Worker & Durable Handoff (`src/queue.ts`, `src/worker.ts`)**: Dedicated PostgreSQL session advisory lock `726901`, heartbeat in `schema_meta`, crash recovery of expired leases, CAS `preparing -> submitting`, and bounded exponential retries.
- **Operator CLI (`src/cli.ts`)**: Host-local CLI for `forms validate`, `submissions list`, `submissions show`, `attachments export`, `submissions delete --confirm`, `retention run`, and `notifications show`.
- **Retention & Deletion (`src/retention.ts`)**: Tombstoning, cancel-before-send, idempotent disk deletion, field/receipt redaction, 90-day retention boundaries, and orphan file sweeper.
- **Static Examples & Deterministic Demo (`examples/`, `scripts/demo.ts`)**: Standard native HTML multipart form examples (`job-application.html`, `contact.html`) and end-to-end demo verification script (`pnpm run demo:verify`).
- **CI & Release Checks (`.github/workflows/ci.yml`, `Dockerfile`, `scripts/release-check.ts`, `THIRD_PARTY_NOTICES.md`)**: GitHub Actions workflow with pinned action SHAs, multi-stage non-root container build, and release audit script.

### Fixed (Repair Pass F01–F10)

- **F01 (Storage & Retention)**: Scoped orphan sweeps strictly to `tmp/` staging files; guarded live quarantine files by cross-referencing DB attachments fail-closed.
- **F02 (Retention & Storage)**: Ensured non-ENOENT disk deletion failures mark `cleanup_done = false` and preserve redaction transaction for retry; redacted `original_name` to `[redacted]` on successful deletion.
- **F03 (Streaming Multipart)**: Replaced ad-hoc readable streams with backpressure-aware `PassThrough` pipelines; settled and unlinked all staged bytes on client abort, invalid PDF header, or limit violations.
- **F04 (CAPTCHA Context Binding)**: Derived allowed hostnames from configured form origins; strictly validated `action === 'submit_form'` and exact normalized hostname matching against Cloudflare Turnstile responses.
- **F05 (Byte Integrity & Immutable MIME Retries)**: Enforced SHA-256 and size verification of stored attachments before clean scan caching and MIME generation; enforced checksum verification on persisted MIME on retry, refusing silent recomposition with `mime_integrity_error`.
- **F06 (Outbound Control)**: Wired `OUTBOUND_ENABLED=false` to skip claiming and prevent SMTP calls, retaining jobs in `queued` state until enabled.
- **F07 (Lock Ordering)**: Unified lock ordering across CLI deletion, 90-day retention expiration, and worker preflight to lock `notifications` first `FOR UPDATE` then `submissions` second `FOR UPDATE`.
- **F08 (Advisory Lock Ownership & Lease Recovery)**: Handled advisory lock client error/end events to drop ownership and halt claims/sends; verified matching lease before submitting CAS; added periodic lease recovery running every 30s during worker execution.
- **F09 (Directory Protection)**: Added `storage/` to `.gitignore`; aligned quickstart directory creation with `STORAGE_DIR` default (`./data`); verified exclusion of runtime files in release archive.
- **F10 (Bounded Service Readiness)**: Bounded readiness loops and socket probes with explicit timeouts; reported failed dependencies with nonzero exit code; tracked Mailpit with local PID file instead of global pkill.
