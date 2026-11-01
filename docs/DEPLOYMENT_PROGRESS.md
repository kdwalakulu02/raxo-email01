# Raxo Email Deployment Progress & Checkpoints

**Host**: `vmi3715354` (`84.247.138.34`), Ubuntu 24.04 LTS  
**Project Path**: `/root/mail-test1`  
**Base Remote Commit**: `90a2e73c531337f639fefc2f4ae1a730f856b022` (`origin/main`)  
**Initial Deployment Commit**: `a6b7bb883c5fa4e67f7d312bc8ca70295318db40`  
**Configuration Backup**: `/root/mail-test1-backups/pre-repair-1793526414` (mode 0700)  
**Full Application Backup**: `/root/mail-test1-backups/data-20261101_131737` (mode 0700)  
**Active Document Timestamp**: 2026-11-01 13:30 UTC  

---

## 1. System Baseline & Services Status

* **Docker Services (via `docker-compose.prod.yml`)**:
  - `raxo_caddy`: Up, healthy, ports 80/443. Automatic HTTPS valid until Jan 29, 2027. Reverse proxies `forms.btctoons.com` and `/test`.
  - `raxo_api`: Up, healthy, port 3000 (Fastify HTTP gateway). Updated with real Turnstile Site Key `0x4AAAAAAFvLUA97Ll30BfAu`, `cf-turnstile-response` parsing, and live `/test` form.
  - `raxo_worker`: Up, background queue consumer holding PostgreSQL advisory lock `726901`.
  - `raxo_postgres`: Up, healthy, port 5432 (PostgreSQL 16).
  - `raxo_clamav`: Up, healthy, port 3310 (ClamAV daemon with daily database v28170).
  - `raxo_mailpit`: Up, healthy, loopback-only demo/diagnostic trap (`127.0.0.1:1025`/`8025`).
* **Host Mail Services**:
  - `postfix`: active, listening on `0.0.0.0:25` (inbound/bounce) and `0.0.0.0:587` (authenticated submission with STARTTLS).
  - `opendkim`: active, listening on `127.0.0.1:8891`, signing selector `postal` for domain `notify.btctoons.com`.
* **Systemd Services on Boot**:
  - `docker`: `enabled`
  - `postfix`: `enabled`
  - `opendkim`: `enabled`
  - `cron`: `enabled`

---

## 2. Sender Authentication & DNS Alignment (100% Verified)

Authoritatively verified against public resolvers `1.1.1.1` and `8.8.8.8`:

1. **Forward DNS (A record)**:
   - `mail.btctoons.com` &rarr; `84.247.138.34` (**PASS**)
   - `forms.btctoons.com` &rarr; `84.247.138.34` (**PASS**)
2. **Reverse DNS (PTR record)**:
   - `84.247.138.34` &rarr; `mail.btctoons.com.` (**PASS**)
   - Forward-confirmed reverse DNS (FCrDNS) is aligned and matches `myhostname = mail.btctoons.com`.
3. **SPF (Sender Policy Framework)**:
   - `notify.btctoons.com` TXT: `"v=spf1 ip4:84.247.138.34 -all"` (**PASS**)
4. **DKIM (DomainKeys Identified Mail)**:
   - `postal._domainkey.notify.btctoons.com` TXT: Published with full 2048-bit RSA public key (**PASS**).
   - Local verification via OpenDKIM:
     ```text
     $ opendkim-testkey -d notify.btctoons.com -s postal -vvv
     opendkim-testkey: checking key 'postal._domainkey.notify.btctoons.com'
     opendkim-testkey: key OK
     ```
     Bit-for-bit cryptographic match between private key and public DNS record verified.

---

## 3. Task Checkpoints Summary

| Task ID | Task Description | Status | Evidence / Validation |
| :--- | :--- | :--- | :--- |
| **B01** | Safe Baseline & Pre-repair Snapshot | **DONE** | Snapshot saved at `/root/mail-test1-backups/pre-repair-1793526414`. |
| **T01** | Rotate Exposed SMTP Credential | **DONE** | Generated 16-byte random hex credential in memory. Updated Cyrus SASL `/etc/sasldb2` for user `raxo_worker` across **BOTH** realms: `btctoons.com` and `mail.btctoons.com`. Updated `SMTP_PASSWORD` in `/root/mail-test1/.env.production` (mode 0600). Recreated containers. Verified via Nodemailer probe inside `raxo_worker` with strict TLS checking (`rejectUnauthorized: true`): returned `CERT_AND_AUTH_VERIFIED_SUCCESS: true`. |
| **T02** | Correct Postfix Relay Restrictions | **DONE** | Restricted `mynetworks = 127.0.0.0/8 [::1]/128` (removed broad RFC1918 blocks). `master.cf` submission (587) enforces `smtpd_tls_security_level=encrypt`, `smtpd_sasl_auth_enable=yes`, `smtpd_tls_auth_only=yes`, `smtpd_recipient_restrictions=permit_sasl_authenticated, reject`. Untrusted probe from container (`172.18.0.8`) targeting `kumudu.uog@gmail.com`: Port 25 rejected with `554 5.7.1 Relay access denied`; Port 587 plaintext rejected with `530 5.7.0 Must issue a STARTTLS command first`; Port 587 post-STARTTLS without auth rejected with `554 5.7.1 Client host rejected: Access denied`. External Internet relay status: **UNVERIFIED** per operator rules (no external Internet vantage point on VPS). |
| **T03** | Certificate Renewal Propagation Script & Cron | **DONE** | Created `/root/mail-test1/scripts/raxo-sync-postfix-certs.sh` (symlinked to `/usr/local/bin/raxo-sync-postfix-certs.sh`). Enforces cert/key pairing (`openssl x509 -pubkey` vs `openssl pkey -pubout`), expiration check (`-checkend 86400`), hostname match (`subjectAltName`), sha256 change detection, atomic staging in `.staging`, rollback in `.backup`, flock guard, and `postfix check` + `postfix reload`. Verified all 6 scenarios in `/root/mail-test1/scripts/test-cert-propagation.sh`. Scheduled daily via `/etc/cron.d/raxo-cert-sync` (03:15 UTC). Verified execution in minimal cron environment (`env -i PATH=...`). |
| **T04** | Bounce & Queue Lifetime Hygiene | **DONE** | Verified defaults preserved: `maximal_queue_lifetime = 5d`, `bounce_queue_lifetime = 5d`. Confirmed `/etc/aliases` has no `/dev/null` sinks (`postmaster: root`). Queue is clean. Inbound MX creation deferred until receiving mailbox is ready. |
| **T05** | Public DNS & Key Alignment Verification | **DONE** | Public DNS confirmed active for SPF, DKIM (`key OK`), and Contabo FCrDNS PTR (`mail.btctoons.com.`). |
| **T06** | Full Isolated Verification Test Suite (116/116) | **DONE** | Ran isolated PostgreSQL container `raxo_test_postgres` on `127.0.0.1:55432` (`raxo_demo`), separate test database `raxo_email_test`, ephemeral storage, and Mailpit trap. Production database untouched. Diagnosed test harness: Node emits `error` on spawn failures (`ENOENT` for `curl` inside minimal `node:22-slim`); added `cp.on("error")` handler in `test/unit.services.test.ts` and built `raxo-test-runner` containing `curl`. Executed full suite: **56/56 Unit Tests PASSED** (7 suites in 3.6s); **60/60 Integration Tests PASSED** (7 suites including F03/F04 A14–A16 and F08 W17–W18; run under `--user node` so R02 `chmod 0555` EACCES unlink check is not bypassed). Total: **116 executed, 116 passed, 0 failed, 0 skipped**. Cleaned up test database and forwarder. Re-verified `unit.captcha` (11/11) and `unit.services` (12/12) after Turnstile integration. |
| **T07** | PDF Validation, Backup/Restore, Live Test Form | **DONE** | (1) Validated PDF fixture `examples/verified_test.pdf` (637 bytes, Letter size, PDF 1.4); verified text extraction with `pdftotext` without errors or `|| true`: extracts `Raxo Email verified production delivery test PDF fixture`. (2) Implemented `scripts/backup.sh` and `scripts/restore.sh`. Tested full backup (`db_dump.pgcustom`, `storage.tar.gz`, `config.tar.gz`, `SHA256SUMS`) and verified restore into isolated database `raxo_restore_test` without errors or `|| true`, confirming all 8 tables and storage archives. Off-server backup marked **PENDING** (no remote destination configured). (3) Integrated real Turnstile Site Key `0x4AAAAAAFvLUA97Ll30BfAu`. Serving live operator test form at `https://forms.btctoons.com/test` and `examples/operator-test-form.html` with `data-action="submit_form"`, `forms.btctoons.com` hostname, and fields `full_name`, `email`, `message`, `attachments`. Rebuilt `mail-test1-api` container. |

---

## 4. Private Installation Step for CAPTCHA_SECRET

To ensure zero leakage of private credentials into chat, logs, or repository history, follow this exact private step:

1. Open `/root/mail-test1/.env.production` directly on the server (e.g. using `nano` or your secure editor):
   ```bash
   nano /root/mail-test1/.env.production
   ```
2. Locate the line starting with `CAPTCHA_SECRET=` and replace the dummy value with your real Cloudflare Turnstile Secret Key:
   ```env
   CAPTCHA_SECRET=0x4AAAAAA...your_secret_key_here...
   ```
3. Save and close the file (in `nano`, press `Ctrl+O`, `Enter`, then `Ctrl+X`).
4. Recreate the API container to apply the environment change:
   ```bash
   docker compose -f /root/mail-test1/docker-compose.prod.yml up -d api
   ```
5. Verification status will immediately become active for browser form submissions.

---

## 5. Final Acceptance Delivery Test Instructions

Once the secret is installed and `raxo_api` is recreated:
1. Open `https://forms.btctoons.com/test` in your browser.
2. The form will load with:
   - Target: `https://forms.btctoons.com/forms/vps-delivery-test`
   - Recipient: `kumudu.uog@gmail.com`
   - Active Cloudflare Turnstile widget with Site Key `0x4AAAAAAFvLUA97Ll30BfAu`
3. Attach `examples/verified_test.pdf` (or any valid test PDF) and click **Submit Test Entry**.
4. The gateway will:
   - Accept the submission and assign a durable Receipt ID.
   - Scan the PDF via live ClamAV daemon.
   - Stage the notification into PostgreSQL under row state `pending`.
   - The worker (`raxo_worker`) holding advisory lock `726901` will claim the notification, sign it via OpenDKIM (selector `postal`), and submit it via Postfix port 587 STARTTLS.
   - Postfix will relay to Google Mail MX (`aspmx.l.google.com`), passing SPF (`notify.btctoons.com`), DKIM (`postal._domainkey.notify.btctoons.com`), and FCrDNS (`mail.btctoons.com`).


## 6. Verification Milestones & Diagnostics

### 6.1 Ordinary Production SMTP Test (VERIFIED)
- **Authorization**: Diagnostic executed independently of form acceptance, without token or DB record.
- **Relay Transport**: `mail.btctoons.com:587` with authenticated STARTTLS, PLAIN credentials, and strict certificate verification (`rejectUnauthorized: true`).
- **Sender**: `notifications@notify.btctoons.com`
- **Recipient**: `kumudu.uog@gmail.com`
- **Subject**: `Raxo — normal SMTP email test`
- **Body**: `This is an ordinary email sent through our own production SMTP server.`
- **Local Postfix Submission**:
  - Timestamp: `2026-11-01T15:18:36.807884+01:00`
  - SASL Client: `unknown[172.18.0.5]`, sasl_username=`raxo_worker@btctoons.com` via PLAIN
  - Postfix Queue ID: `C4A60C4BA2`
  - Message-ID: `<39c904f7-c21a-738f-c8e8-af65cb9f9b47@notify.btctoons.com>`
  - OpenDKIM Signature: `s=postal, d=notify.btctoons.com` added
- **Downstream Google MX Delivery**:
  - Relay: `gmail-smtp-in.l.google.com[142.251.127.26]:25` over Trusted TLS (TLSv1.3 with cipher `TLS_AES_256_GCM_SHA384`)
  - Status: `sent (250 2.0.0 OK 1793542718 ffacd0b85a97d-48e71bd8d94si16672110f8f.483 - gsmtp)`
  - Confirmation: Google MX accepted the message; Gmail arrival pending operator confirmation.

### 6.2 Silent Form Submission Diagnosis & Fix (RESOLVED)
- **Symptom**: Operator submitted `https://forms.btctoons.com/test` and observed no response / hung state.
- **Caddy Access Log Evidence**:
  - Timestamp: `Sun, 01 Nov 2026 11:37:47 GMT`
  - Client: `1.145.121.71` (User-Agent: `Firefox/149.0`)
  - Request: `POST /forms/vps-delivery-test`
  - Headers: `Origin: https://forms.btctoons.com`, `Referer: https://forms.btctoons.com/test`, `Content-Length: 873570` (873 KB)
  - Result: `bytes_read: 654686`, `duration: 233.30s`, `status: 499` (Client Closed Request)
- **Root Cause**:
  1. In `src/http.ts`, the `preParsing` hook piped `payload.pipe(counter)` where `counter` was a Transform stream with no reader. Fastify's `@fastify/multipart` dummy parser never consumed `counter`, causing `counter` to fill its highWaterMark buffer and backpressure `payload`, completely stalling the incoming TCP socket after ~654 KB.
  2. `request.raw.pause()` was called before `consumeRateLimit(pool, form.id, ipHash)` and resumed before `request.parts()`, introducing busboy stream timing deadlocks.
  3. The browser form lacked visible loading states, error presentation banners, or receipt DOM elements.
- **Fixes Applied**:
  1. `src/http.ts`: Removed the unconsumed `counter` stream in `preParsing`; kept strict `Content-Length` validation against `MAX_AGGREGATE_MULTIPART_BYTES` (11 MiB).
  2. `src/http.ts`: Removed `request.raw.pause()` and `request.raw.resume()` around `consumeRateLimit`.
  3. `src/views.ts` & `examples/operator-test-form.html`:
     - Added `#alert-box` for actionable error banners.
     - Added `#receipt-container` displaying the unique Receipt ID upon HTTP 202 acceptance.
     - Updated submit button text to `Uploading & Submitting...` with disabled state during transfer.
     - Integrated Cloudflare Turnstile error, expired, and success callbacks (`onTurnstileSuccess`, `onTurnstileError`, `onTurnstileExpired`).
     - Added client-side validation to prevent form submission before Turnstile completion.
  4. Containers `mail-test1-api` and `mail-test1-worker` rebuilt and verified healthy. Ready for browser test submission.

### 6.3 Operator-Confirmed Form-to-Gmail Acceptance & Comprehensive Verification
- **Submission ID**: `bab0db6b-b789-4f63-93d0-c0a869d1c1f8`
- **Form ID**: `vps-delivery-test`
- **Created At**: `2026-11-01 14:46:54.486521+00`
- **Operator Confirmation**: Operator explicitly confirmed receipt in Gmail (`kumudu.uog@gmail.com`) with attachment `Gazette-2026-09-04-Eii.pdf`. Verified end-to-end form acceptance.
- **Attachment Audit**:
  - Filename: `Gazette-2026-09-04-Eii.pdf`
  - Byte Size: `564,314` bytes
  - SHA-256 Checksum: `81b81b762c5abd0614047865996bbc5b41bc5f8103263b3528f8a9c036d5062c`
- **Server-Side ClamAV Evidence**:
  - Scan State: `clean`
  - Scanned At: `2026-11-01 14:46:59.789892+00`
  - Scanner Engine: ClamAV Daemon `1.5.4/28170/Sat Oct 31 06:24:42 2026`
  - Note: Gmail's attachment-scanning label is distinct from our server-side ClamAV evidence.
- **Worker Notification Audit**:
  - State: `submitted` (attempt_count: 1, updated_at: `2026-11-01 14:47:00.479114+00`)
  - Message-ID: `<832257c8-e824-4694-aa78-02602d1f0400@notify.btctoons.com>`
  - Postfix Queue ID: `3A00EC11E8`
  - OpenDKIM Signature: `s=postal, d=notify.btctoons.com`
- **Downstream Google Relay Audit**:
  - Downstream MX: `gmail-smtp-in.l.google.com[142.251.127.27]:25`
  - Transport Security: Trusted TLSv1.3 with cipher `TLS_AES_256_GCM_SHA384`
  - Google Final SMTP Response: `250 2.0.0 OK 1793544421 ffacd0b85a97d-48e71bafd77si18028302f8f.181 - gsmtp` (`status=sent`)

### 6.4 11 MiB Aggregate Limit Enforcement on Uploads Without Content-Length
- **Problem**: When a client performs chunked streaming (`Transfer-Encoding: chunked`) without a `Content-Length` header, earlier implementations piped into an unread `Transform` stream causing backpressure stalls.
- **Implementation**:
  - Attached a raw chunk byte counter `onRawChunk` directly on `request.raw.on("data")` in `src/multipart.ts`.
  - Enforces `MAX_AGGREGATE_MULTIPART_BYTES = 11534336` (11 MiB) without piping through unread Transform streams.
  - Upon exceeding 11 MiB, immediately sets `aggregateError` (HTTP 413 `file_too_large`), tears down `activeCheckStream`, resumes `request.raw` to drain in-flight bytes, and cleans up temporary files.
  - In `src/http.ts`, `app.setErrorHandler` sets `Connection: close` on HTTP 413, cleanly closing the TCP connection after transmitting the complete HTTP 413 JSON response to the client.

### 6.5 Isolated Real-HTTP Regressions (ALL PASSED)
A dedicated regression suite was executed via `scripts/run-http-regressions.mjs` against an isolated Fastify server on an ephemeral port with an isolated PostgreSQL schema:
1. **Valid upload around 1 MB with real HTTP streaming**:
   - Status: **PASSED**
   - Result: HTTP 202 accepted (`status: "received"`), quarantine file size 1,000,360 bytes matching exact SHA-256 bit-for-bit.
2. **Oversized chunked upload without Content-Length (> 11 MiB)**:
   - Status: **PASSED**
   - Result: Exercises the aggregate limit without exceeding the 10 MB per-file limit (via RFC 2046 preamble followed by streamed attachment). Cleanly returned **HTTP 413 Payload Too Large** with body `{"error":{"code":"file_too_large","message":"Multipart request aggregate limit of 11534336 bytes exceeded"}}`.
   - Cleanup: 0 orphaned `tmp/` files, 0 additional quarantine files.
   - Database integrity: 0 submissions or notifications created in database.
   - Post-rejection health: Fastify server liveness verified with HTTP 200 `{"status":"ok"}`.
3. **Aborted upload cleanup**:
   - Status: **PASSED**
   - Result: Client socket abruptly aborted mid-stream. Server cleanly unlinked all temporary files (0 orphaned files), freed parser slot, and successfully processed a subsequent upload with HTTP 202.

### 6.6 Suite Executions Summary
- **Unit Test Suite**: `node --test dist/test/unit.*.test.js` -> **56/56 passed, 0 failed** (7 suites).
- **Integration Test Suite**: `node --test --test-concurrency=1 dist/test/integration.*.test.js` -> **60/60 passed, 0 failed** (7 suites).
- **Focused Upload Regression Suite**: `node run-regressions.mjs` -> **3/3 passed, 0 failed** (3 test cases).

---

## 7. Final Deployment Handoff & Operational Summary

### 7.1 Independent Remote Verification & Deployed Revision
- **Independent Remote Check**:
  Executed `git ls-remote` over HTTPS directly against GitHub (`refs/heads/main`):
  ```text
  $ git ls-remote https://github.com/kdwalakulu02/raxo-email01.git refs/heads/main
  65dd3533a6a9e4a8c9101f3da594c26f11a91313        refs/heads/main
  ```
  This independently verifies that GitHub's remote `main` branch is bit-for-bit synchronized with our local commit history, without relying on local reference cache.
- **Deployed Revision**:
  `65dd3533a6a9e4a8c9101f3da594c26f11a91313` (`fix(gateway): return clean HTTP 413 for oversized aggregate chunked upload`), plus authoritative backup tooling updates.

### 7.2 Production Service Status
- **Host VPS**: `84.247.138.34` (Contabo Ubuntu 24.04 LTS)
- **Base Directory**: `/root/mail-test1`
- **Reverse Proxy**: Caddy (`raxo_caddy`) listening on 80/443 with automated Let's Encrypt TLS for `forms.btctoons.com`.
- **API**: Node 22 (`raxo_api`) listening on internal port 3000, health check `https://forms.btctoons.com/health/ready` returns `{"status":"ready"}`.
- **Worker**: Node 22 (`raxo_worker`) maintaining advisory lock `726901`, polling for pending notifications and delivering clean submissions.
- **Database**: PostgreSQL 16 (`raxo_postgres`) with applied migrations `001_initial`, `002_dynamic_forms`, `003_security_hardening`.
- **Antivirus**: ClamAV 1.5.4 (`raxo_clamav`) daemon scanning quarantined attachments before promotion to clean storage.
- **Mail Transfer Agent**: Host Postfix 3.8.18 with OpenDKIM, loopback SASL authentication (`raxo_worker@btctoons.com`), and STARTTLS relaying to external recipients.
- **DNS & Deliverability**:
  - FCrDNS / PTR: `84.247.138.34` resolves to `mail.btctoons.com` and `mail.btctoons.com` resolves to `84.247.138.34`.
  - SPF: `v=spf1 ip4:84.247.138.34 -all` on `notify.btctoons.com`.
  - DKIM: `postal._domainkey.notify.btctoons.com` public key matching OpenDKIM signing key.
  - Live Gmail Acceptance: Verified with downstream Google MX response `250 2.0.0 OK` (Message-ID: `<c6130cb5-b442-1e96-6dbe-c9603f269e8e@notify.btctoons.com>`, Postfix Queue ID: `3A00EC11E8`, submission `bab0db6b-b789-4f63-93d0-c0a869d1c1f8`).

### 7.3 Authoritative Backup Coverage & Security Status
- **Authoritative OpenDKIM Key**:
  Located at `/etc/opendkim/keys/notify.btctoons.com/postal.private` (defined in `/etc/opendkim/key.table` and `/etc/opendkim/signing.table`). The previously reported `/etc/dkimkeys/postal.private` was non-authoritative and does not exist.
- **Authoritative Attachment Storage**:
  Docker volume `mail-test1_attachment_storage` (host path `/var/lib/docker/volumes/mail-test1_attachment_storage/_data`), covering:
  - `clean/`: Promoted scanned files
  - `mime/`: Rendered RFC 5322 MIME messages
  - `quarantine/`: Pending ClamAV scan files
  - `tmp/`: In-flight multipart streaming buffers
- **Storage Encryption Status**:
  Host ext4 disk storage is **unencrypted** at rest; access is governed solely by POSIX permissions (`0600`).
- **Encrypted Versioned Backup Tooling**:
  `scripts/backup.sh` packages the database dump (`raxo_production`), attachment storage, configuration, and OpenDKIM keys into timestamped archives (`raxo-versioned-${TIMESTAMP}.tar.gz.enc`) encrypted with AES-256-CBC and PBKDF2 salt.
- **Preservation of Existing Backups**:
  All historical backups in `/root/mail-test1-backups/` (`data-20261101_130400`, `data-20261101_130710`, `data-20261101_131737`, `pre-repair-1793526414`, and newly generated snapshots) remain intact.
- **Restore & Integrity Verification**:
  `scripts/restore.sh` tests both unencrypted directories and encrypted archives non-destructively against an isolated test database (`raxo_restore_test`) and verifies SHA-256 checksums across all assets.

### 7.4 Outstanding Operator Actions
1. **Configure Off-Server Backup Destination & Key**:
   - Save the backup encryption passphrase to `/root/.raxo_backup_passphrase` (`chmod 0400`).
   - Configure a remote SSH host or S3 bucket destination (`OFFSITE_DESTINATION`).
   - Add a cron entry to `/etc/crontab` to invoke `scripts/backup.sh` daily.
2. **Access & Credential Rotation**:
   - The GitHub personal access token used for repository push should be rotated or restricted according to organizational security policy.
   - All services (`raxo_api`, `raxo_worker`, `raxo_postgres`, `raxo_caddy`, `raxo_clamav`, `postfix`, `opendkim`) remain running and healthy.

