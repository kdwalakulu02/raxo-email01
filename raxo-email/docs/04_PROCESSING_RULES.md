# 04 — Exact processing algorithms

Implement these algorithms as written. Do not add speculative infrastructure.

## A. Server startup

1. Load .env explicitly, then validate environment and forms JSON.
2. Resolve STORAGE_DIR to an absolute path. Create data directories with mode 0700; files mode 0600. Do not use an ephemeral container layer.
3. Verify DB schema is migrated; do not silently migrate during HTTP requests.
4. Validate scanner and SMTP configuration. Reject production demo settings, missing CAPTCHA/IP-hash secret, public bind with DEMO_MODE, plaintext SMTP outside loopback, or STORAGE_DIR under a served static directory.
5. Listen on configured host/port. Disable request body/SMTP debug logging.
6. Graceful shutdown stops new requests, completes/aborts active bounded uploads, closes DB pool. Never delete committed data on shutdown.

DEMO_MODE=true is valid only when NODE_ENV is not production, HOST is literal 127.0.0.1 or ::1, SMTP host resolves solely to loopback or the known local Compose Mailpit service, and no SMTP credentials are provided. Do not make "hostname contains localhost" a trust check.

For Docker demo containers, bind inside container as needed only under a separate explicit local compose profile whose host port is loopback. Do not weaken the normal host validation; containerized app demo is optional and excluded from the required local script.

## B. Rate limiting and identity

For a known enabled form, consume attempt counters before parsing large bodies. Trust socket.remoteAddress by default; do not trust arbitrary forwarding headers. Production can configure explicit trusted proxy CIDRs.

HMAC-SHA256(IP_HASH_SECRET, UTC-date + normalized remote IP) generates an IP bucket identifier. Do not log/store raw IP. Fixed windows: minute floor for form+IP; UTC date for form total. SQL upserts increment only below limits. Both increments commit together in a short transaction. If either would exceed its limit, rollback and return 429. Expire minute buckets after 1h and daily buckets after 36h.

The counters limit attempts, not only accepted messages. Validation errors do not refund them. DB unavailable ->503, no acceptance. In-flight parser semaphore cap is 2/process; slot is released in finally.

## C. Multipart parsing and staging

Use @fastify/multipart's streaming request.parts API. Explicitly set part/file/field limits. It does not enforce the aggregate multipart request limit merely because Fastify bodyLimit is set; add an aggregate raw-byte-counting stream in preParsing with receivedEncodedLength handled according to Fastify's documented hook contract.

Reject declared Content-Length above aggregate limit immediately, but also count bytes for chunked requests. Do not allocate a Buffer for an unbounded body. Boundary/headers count toward aggregate; decoded file streams count toward combined raw-file limits.

For each attachment:

- require part name attachments;
- require a sanitized .pdf filename, a PDF MIME declaration and detected PDF bytes;
- replace directory/control/CRLF characters in display filename; length <=120; generated UUID is the storage key;
- write to temp file opened exclusively, stream through hash and limit checks;
- fsync file, close, atomically rename into quarantine, fsync parent directory;
- store id, key, size, checksum and display filename in the in-memory parsed metadata.

Consume all parts. Reject duplicate text fields, unknown fields, too many parts, truncation, client aborts, errors or byte overflow. Cleanup every temp/new staged file on rejected requests. Abort/drain streams as the parser API requires; do not leave hung sockets.

All files stay private. A file extension/magic match is not a malware verdict.

## D. CAPTCHA and normalized fields

After parsing bounded input:

1. If _honey is nonempty, delete newly staged files and return generic receipt with no retained record/notification.
2. Verify required fields, configured types and lengths.
3. Verify origin against form's exact allowlist. In production missing/null Origin is rejected; integrations without browser Origin are not in v0.1.
4. Verify CAPTCHA token server-side for production using fixed Cloudflare Turnstile verification endpoint. Check success, action="submit_form" and returned hostname against configured form origin hostnames. Use a 5s timeout. Never accept browser-reported success. Network error fails closed.
5. Loopback demo may bypass CAPTCHA explicitly. The example page must identify this as local-only.
6. Compute normalized fingerprint. A URL field is stored as text; never fetched.

Production embedding must set data-action="submit_form" and data-response-field-name="_captcha_token" on the widget so its field matches our parser. Retry the same logical submission with a fresh CAPTCHA token while preserving _submission_id. Turnstile is only a replaceable CAPTCHA dependency, not an email transport dependency. No Turnstile account is needed for the local demo.

## E. Durable acceptance

Use algorithm and dedup rules in contracts doc. Staged bytes already have persistence acknowledgement. Begin SQL transaction, create submission, file rows and one queued notification, commit. On unique client ID conflict read original in scope and compare fingerprint. Roll back and clean newly staged files on conflict/failure.

Return received only after COMMIT. Do not catch a DB exception and still return success. If the client disconnects after commit, the durable record stays; a supplied client submission ID permits a safe retry.

A staged object with no committed reference is an orphan. Cleanup is idempotent; a sweeper catches orphan files older than 24h if a process crashed before immediate cleanup.

## F. Worker ownership

worker.ts holds a session-level PostgreSQL advisory lock with fixed numeric key 726901 on a dedicated connection. If lock not acquired, exit with an explanatory nonzero result. Do not use a pooled arbitrary session for this lock. Loss of lock connection stops claims and stops before any new network side effect.

Heartbeat schema_meta worker_heartbeat every 20s. At startup and periodically:

- expired preparing -> queued;
- expired submitting -> unknown and corresponding attempt outcome=unknown;
- never recover unknown to queued.

Claim due queued/retry_wait row with FOR UPDATE SKIP LOCKED. Check submission is not deleted. Mark preparing, new lease UUID and expiry, commit. Do not hold DB locks during scans/network.

Renew lease every 20s. Every state update requires matching lease token. Before SMTP, compare-and-swap preparing -> submitting and insert attempt row in one transaction; also confirm submission is not deleted. If that transaction fails or lease is lost, no SMTP call.

For consistent locking, both worker final-preflight and deletion acquire notification row first, then submission row in the same order. PostgreSQL may still report a deadlock; retry only the short DB transaction before side effects.

## G. File scan and MIME preparation

For each attachment, load only its generated storage key. Verify bytes/checksum. If clean scan is older than 48h, rescan. Scanner errors retry preparation after 60s; limit 5 scan/preparation failures using notifications.prepare_failures from the baseline migration. After budget, mark blocked with scanner_unavailable; no SMTP attempt.

Clamd adapter uses a reviewed client protocol implementation in scanner.ts:

- connect only to configured operator-controlled private endpoint;
- VERSION command confirms signature timestamp <=48h;
- INSTREAM sends zINSTREAM plus NUL, then 4-byte network-order length + chunk, then zero-length frame;
- only an explicit complete OK reply permits clean; FOUND blocks; ERROR, timeout, disconnect or size limit cannot be clean;
- cap chunks/total bytes and apply 30s deadline;
- no mock scanner in production.

Use official protocol docs while implementing framing/reading. Test responses before connecting real scanner. Configure scanner archive/PDF limits to cover accepted sizes and report encrypted/unscannable content as blocked. Do not infer a successful scan from exit code alone without parsing the result.

Create a plain-text notification from immutable config/fields snapshot:
Subject: <subject_prefix> — <submission UUID>
From: configured sender.
To: configured recipient.
Reply-To: validated selected email field, if present.
Body: receipt ID, UTC received time, configured field labels/values as plain text.
Attachments: clean PDF bytes read from trusted storage, never path/href supplied by visitor.

Nodemailer stream transport with buffer=true composes one Buffer; disableFileAccess and disableUrlAccess are true. Do not use jsonTransport for queue serialization. Check final Buffer byte length against min(product and transport limits). Persist immutable MIME and checksum before submitting. Retry uses same MIME; never rewrite Date/Message-ID on safe retry.

## H. SMTP submission outcomes

Set explicit envelope from trusted config; one recipient only. Use Nodemailer raw buffer submission with logging/debug disabled. TLS modes: plain_local only for loopback demo, implicit for TLS socket, starttls_required otherwise. No rejectUnauthorized=false.

Result type:

```ts
type SubmitResult =
  | { kind: "submitted"; receipt: { response: string; accepted: string[] } }
  | { kind: "safe_retry"; code: string }
  | { kind: "failed"; code: string }
  | { kind: "unknown"; code: string };
```

Store redacted bounded receipt; do not store SMTP AUTH or raw transcript.

Classification:

- explicit SMTP 4xx refusal -> safe_retry;
- explicit SMTP 5xx refusal -> failed;
- proven connection/DNS failure before greeting (such as refused connection) -> safe_retry;
- authentication/config/TLS validation failure before mail -> failed;
- timeout/disconnect during DATA or ambiguous protocol stage -> unknown;
- unrecognized transport errors -> unknown, never guess safe retry.
- positive final acceptance with the expected recipient accepted -> submitted.

Do not rely on a text substring alone to infer protocol stage. Use documented structured error evidence and a local test peer. A pooled SMTP connection is unnecessary; disable pooling for v0.1.

Before network I/O, persist attempt with outcome=submitting and increment attempt_count. On success persist receipt and state=submitted. On safe_retry schedule the bounded retry; on fifth failed handoff mark failed. Other outcomes map directly. A crash after possible acceptance leaves submitting which expires to unknown. MTA downstream retries are not Raxo retries.

The SMTP client saying accepted establishes no remote Gmail/Outlook delivery. No event integration or delivered status in this version.

## I. Operator CLI and deletion

submissions list queries latest nondeleted records with stable (created_at,id) ordering, limit 1–100. show reads one record and its attachment/notification metadata.

attachments export verifies nondeleted parent and clean scan. If scan is stale, rescan before export; unavailable scanner blocks. Read storage using generated key, verify checksum, create the user's output with exclusive flag and mode 0600. Never follow storage symlinks or overwrite a file. Operator output path is allowed outside STORAGE_DIR but cannot overwrite runtime storage; reject an output located inside STORAGE_DIR.

submissions delete --confirm tombstones immediately and cancels jobs that have not begun SMTP. It cannot recall an already-submitting/accepted message. Keep enough object keys to complete deletion.

retention run does the same for records older than 90 days; tests inject a clock. For tombstoned records, delete file and MIME objects idempotently, redact fields/snapshot/display names and SMTP receipts, mark attachments deleted and cleanup_done=true. Leave minimal IDs/fingerprint/dedup tombstone for 24h minimum; eventual metadata purge may follow documented policy.

If disk deletion fails, cleanup_done remains false and the next retention run retries. Do not delete SQL rows first and lose keys. Retention never sends mail or unblocks unknown attempts.

## J. Logging

Log request/notification IDs, states and safe error codes. Never request bodies, field answers, recipients, SMTP credentials, CAPTCHA tokens, original uploads or raw MIME. CLI show is an intentional operator view, not a server log.

No raw production logs or real submissions enter docs or test fixtures.
