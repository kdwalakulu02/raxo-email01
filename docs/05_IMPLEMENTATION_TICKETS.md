# 05 — Ordered implementation tickets

Execute G00–G12. One ticket at a time. Each has a completion gate. If a gate fails, fix it before dependent work.

BUILD_STATUS.md starts with a checklist G00–G12 all unchecked and one evidence table:
ticket | status | files | commands run | result | limitation.
Only actual observations enter the table. Never mark tests passed on the basis of intended code.

## G00 — Scaffold and pin

Create package.json, package-lock.json, tsconfig.json, .nvmrc, .gitignore, .dockerignore, .prettierignore, .prettierrc.json, .env.example, compose.dev.yml, config/dev-init.sql, docs/DEPENDENCY_VERSIONS.md, BUILD_STATUS.md.

Use exact stack/scripts from doc 02. Resolve compatible patched dependencies and stable container digests. Make services:up and services:down work; create development and test DBs without touching unrelated databases. Do not add -v to down.

Gate: node/npm versions recorded; npm ls succeeds; audit reviewed; PostgreSQL/Mailpit/ClamAV health succeeds; plugin registration probe succeeds. Empty source build can be scaffolded but no fake application claims. Record unresolved security advisories instead of ignoring them.

Do not start HTTP features before this gate.

## G01 — Config, types and migration

Files: src/config.ts, errors.ts, types.ts, db.ts, migrate.ts; migrations/001_initial.sql; config/forms.example.json; test/helpers.ts; test/unit.config.test.ts.

Copy exact contracts/SQL. Make initial schema_migrations creation idempotent directly in SQL; do not dynamically rewrite migration text. Define a schema_meta worker_heartbeat record shape {last_seen: ISO timestamp}.

Tests cover invalid/missing environment, unsafe production/demo mode, unknown form keys, reserved field names, duplicate form IDs, invalid recipient, URL scheme and invalid limits. Migration tool stores/checks checksum and refuses edits to applied SQL.

Gate: clean test DB migrates twice; second run no changes; deliberately modified migration checksum fails; invalid config cannot start a listener.

## G02 — Storage and scanner primitives

Files: src/storage.ts, scanner.ts; test/unit.input.test.ts; test/integration.clamav.test.ts.

Implement private generated-key storage with persistent staging, read/delete, MIME persistence and safe path resolution. Implement clamd VERSION/INSTREAM and stale/error handling. Tests use actual scanner plus deterministic protocol peer for error scenarios; test fixtures stay synthetic.

Gate: known clean PDF scans; checksum round-trip; blocked fixture; interrupted/stale scanner never returns clean; file limits/traversal/symlink attempts fail; deletion idempotent.

No HTTP acceptance yet.

## G03 — Repository, counters and acceptance transaction

Files: src/repository.ts, rate-limit.ts, accept.ts; test/integration.accept.test.ts.

Implement transaction boundaries, normalized fingerprint, client ID dedup, snapshot and one-notification uniqueness. Make repository accept staged metadata without SMTP calls.

Gate: new acceptance has one submission/files/notification; forced DB rollback has none; identical concurrent client ID produces one record; conflict body returns409; rate-limiter race at final allowed attempt permits only one; orphan cleanup retains committed objects.

## G04 — Multipart, CAPTCHA and HTTP

Files: src/multipart.ts, captcha.ts, http.ts, server.ts; existing unit/input and integration/accept tests.

Implement only the three production routes and two loopback-demo routes:
GET /demo/job-application and /demo/contact serve the static checked-in examples ONLY in DEMO_MODE. In production those routes return404.

Attach aggregate raw multipart byte counter, in-flight semaphore and all limits. Build safe JSON/HTML responses. Server loads explicit environment and config, dependencies passed to buildApp for tests. No SMTP send in request handler.

Gate: valid form202; missing/duplicate/unknown field422; wrong content415; raw/chunked oversize413; aborted upload cleans temp files; DB outage503; CAPTCHA failure422; client-supplied recipient rejected; honeypot no record; wrong origin rejected; nonexistent future routes404.

## G05 — MIME and SMTP adapter

Files: src/mime.ts, smtp.ts; test/unit.smtp-outcomes.test.ts.

Build immutable plain-text MIME using trusted bytes and config snapshot. Verify byte size. Implement typed outcome classifier and Nodemailer handoff.

Gate: parse MIME with mailparser; fixed From/To/Reply-To and escaped-as-plain-text fields; PDF checksum matches; URL/path injection not used; explicit4xx/5xx and pre-connect failure classification; post-DATA disconnect unknown; arbitrary unrecognized error unknown. No DB or HTTP inside smtp.ts.

## G06 — Worker and durable handoff

Files: src/queue.ts, worker.ts; test/integration.worker.test.ts; small repository helpers as needed.

Implement advisory single-worker lock, heartbeat, lease, scan, immutable MIME reuse, submitting-attempt commit and bounded handoff retries. Complete SQL compare-and-swap logic.

Gate: due notification captured once under normal processing; restart while preparing recovers; restart after possible DATA acceptance becomes unknown; two-worker start cannot create two active senders; SMTP outage preserves submission; SMTP accepted but DB write fails does not cause automatic retry; same MIME checksum on safe retry.

## G07 — Operator CLI

Files: src/cli.ts; test/integration.cli.test.ts.

Implement ONLY fixed commands in doc03. Use manual args parsing, exact exit codes, JSON output and exclusive clean export. No login or new API.

Gate: list metadata excludes deleted fields; show correct record; clean export checksum; missing ID exit3; badargs exit2; dependency exit4; stale scan invokes scan; blocked export fails; existing output never overwritten.

## G08 — Retention and deletion

Files: src/retention.ts; test/integration.retention.test.ts; CLI/repository integration.

Implement tombstones, cancel-before-send, idempotent byte deletion, field redaction, orphan sweep and rate bucket cleanup. Poll retention at worker startup and hourly; CLI manual run supports deterministic test clock.

Gate: deletion races with worker cannot start a NEW handoff after tombstone; already-started mail remains honestly potentially sent; failure deleting disk bytes is retried; retained records prevent orphan deletion; dedup tombstone prevents immediate repost; 90-day retention boundary tested.

## G09 — Static examples and deterministic demo

Files: examples/contact.html, job-application.html, README.md; scripts/demo.ts; docs/DEMO_RESULTS.md.

Samples use exact multipart names and localhost action. Native HTML form uses enctype=multipart/form-data, input attachments accept=.pdf and configured fields. Submission ID generated per page submission attempt; retain it on retry, reset on new application. Explain plain HTML without JS has no retry dedup guarantee.

scripts/demo.ts:

- verifies DEMO_MODE and exclusively loopback targets;
- generates a small valid synthetic PDF with no external assets;
- starts ephemeral local API/worker using a dedicated demo form ID or the sample job form;
- submits FormData with fixed synthetic fields and a new client submission ID;
- queries exact DB record and polls local Mailpit using its documented API;
- matches stable Message-ID, retrieves/parses captured MIME;
- exports via CLI to a temporary new file and verifies three matching checksums;
- closes owned processes/connections without dropping the DB or clearing others' Mailpit messages;
- exits nonzero on missing dependency or failed assertion.

Gate: npm run demo:verify produces a concise result with IDs, checksum and observed submitted status; repeating the same POST with its original client ID returns the original receipt; docs show actual results only. No sleep longer than needed; poll with an overall <=60s deadline after services are ready.

## G10 — CI and container

Files: .github/workflows/ci.yml, Dockerfile, scripts/release-check.ts, THIRD_PARTY_NOTICES.md.

CI starts isolated PostgreSQL/Mailpit/scanner, installs with npm ci, runs check and demo verification, scans release assets. It uses synthetic local credentials. No public registry publish token or external mail credentials.

Dockerfile uses pinned Node image, multi-stage build, non-root runtime and explicit source allowlist. Data/config are runtime mounts, not copied. The same image supports node dist/src/server.js and node dist/src/worker.js.

check:release examines git tracked files plus built package/container input, rejects disallowed files, checks docs claim status and required tests/evidence, produces an allowlisted local source archive with no runtime data. It is not a substitute for a maintained secret scanner; run both. Use git grep/diff inspection when git initialized.

Gate: fresh CI run succeeds; production refuses demo/mock settings; image starts and cannot serve data dir; exact archive contains no .env/runtime config/storage/private archives; upstream notices accurate.

## G11 — Rewrite front page around observed features

Files: README.md, docs/IMPLEMENTED_QUICKSTART.md, GITHUB_PUBLIC_WHITE_PAPER.md, CHANGELOG.md, docs/DEMO_RESULTS.md, BUILD_STATUS.md.

Add a verified fresh-checkout quickstart, actual requirements and limitations. Mark built features implemented only if their test IDs pass. Keep white paper's design date and add implementation status note rather than rewriting history.

Gate: follow quickstart in a fresh isolated directory; no hidden global install, private config or missing migration. All local links resolve. No install command claims a nonexistent npm package.

## G12 — Publication preparation

Files: only docs/07_GITHUB_PUBLICATION.md, release evidence and packaging outputs as necessary.

Run final check, demo and release checks. Inspect exact public archive. Prepare a branch/commit summary and the commands for new raxocode/raxo-email repo publication.

Gate: no untracked runtime/private files in proposed commit; meaningful release notes; known limits include no remote delivered status and no mail-server installation. Do not push or make a repository public without a direct instruction.

## Final reporting

Report:

- tickets completed, blocked and not started;
- exact check commands and actual results;
- local demo instructions;
- actual software paths and docs;
- known limitations;
- GitHub publication state (prepared versus actually published).

Never report "finished" if required scripts/tests are stubs or skipped.
