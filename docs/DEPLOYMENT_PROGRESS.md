# Raxo Email Deployment Progress & Checkpoints

**Host**: `vmi3715354` (`84.247.138.34`), Ubuntu 24.04 LTS  
**Project Path**: `/root/mail-test1`  
**Current Base Commit**: `90a2e73c531337f639fefc2f4ae1a730f856b022` (`origin/main`)  
**Configuration Backup**: `/root/mail-test1-backups/pre-repair-1793526414` (mode 0700)  
**Full Application Backup**: `/root/mail-test1-backups/data-20261101_131737` (mode 0700)  
**Active Document Timestamp**: 2026-11-01 12:48 UTC  

---

## 1. System Baseline & Services Status

* **Docker Services (via `docker-compose.prod.yml`)**:
  - `raxo_caddy`: Up, healthy, ports 80/443. Automatic HTTPS valid until Jan 29, 2027. Reverse proxies `forms.btctoons.com` and `/test`.
  - `raxo_api`: Up, healthy, port 3000 (Fastify HTTP gateway). Updated to support `cf-turnstile-response` and live `/test` form.
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

## 2. Task Checkpoints Summary

| Task ID | Task Description | Status | Evidence / Validation |
| :--- | :--- | :--- | :--- |
| **B01** | Safe Baseline & Pre-repair Snapshot | **DONE** | Snapshot saved at `/root/mail-test1-backups/pre-repair-1793526414`. |
| **T01** | Rotate Exposed SMTP Credential | **DONE** | Generated 16-byte random hex credential in memory. Updated Cyrus SASL `/etc/sasldb2` for user `raxo_worker` across **BOTH** realms: `btctoons.com` and `mail.btctoons.com`. Updated `SMTP_PASSWORD` in `/root/mail-test1/.env.production` (mode 0600). Recreated containers. Verified via Nodemailer probe inside `raxo_worker` with strict TLS checking (`rejectUnauthorized: true`): returned `CERT_AND_AUTH_VERIFIED_SUCCESS: true`. |
| **T02** | Correct Postfix Relay Restrictions | **DONE** | Restricted `mynetworks = 127.0.0.0/8 [::1]/128` (removed broad RFC1918 blocks). `master.cf` submission (587) enforces `smtpd_tls_security_level=encrypt`, `smtpd_sasl_auth_enable=yes`, `smtpd_tls_auth_only=yes`, `smtpd_recipient_restrictions=permit_sasl_authenticated, reject`. Untrusted probe from container (`172.18.0.8`) targeting `kumudu.uog@gmail.com`: Port 25 rejected with `554 5.7.1 Relay access denied`; Port 587 plaintext rejected with `530 5.7.0 Must issue a STARTTLS command first`; Port 587 post-STARTTLS without auth rejected with `554 5.7.1 Client host rejected: Access denied`. External Internet relay status: **UNVERIFIED** per operator rules (no external Internet vantage point on VPS). |
| **T03** | Certificate Renewal Propagation Script & Cron | **DONE** | Created `/root/mail-test1/scripts/raxo-sync-postfix-certs.sh` (symlinked to `/usr/local/bin/raxo-sync-postfix-certs.sh`). Enforces cert/key pairing (`openssl x509 -pubkey` vs `openssl pkey -pubout`), expiration check (`-checkend 86400`), hostname match (`subjectAltName`), sha256 change detection, atomic staging in `.staging`, rollback in `.backup`, flock guard, and `postfix check` + `postfix reload`. Verified all 6 scenarios in `/root/mail-test1/scripts/test-cert-propagation.sh`. Scheduled daily via `/etc/cron.d/raxo-cert-sync` (03:15 UTC). Verified execution in minimal cron environment (`env -i PATH=...`). |
| **T04** | Bounce & Queue Lifetime Hygiene | **DONE** | Verified defaults preserved: `maximal_queue_lifetime = 5d`, `bounce_queue_lifetime = 5d`. Confirmed `/etc/aliases` has no `/dev/null` sinks (`postmaster: root`). Queue is clean. Inbound MX creation deferred until receiving mailbox is ready. |
| **T05** | Public DNS & Key Alignment Recheck | **DONE** | Authoritatively rechecked via `1.1.1.1` and `8.8.8.8`: (1) `forms.btctoons.com` & `mail.btctoons.com` &rarr; `84.247.138.34` (OK); (2) SPF at `notify.btctoons.com` &rarr; `"v=spf1 ip4:84.247.138.34 -all"` (OK); (3) DKIM at `postal._domainkey.notify.btctoons.com` &rarr; `(NO RECORD)` (MISSING); (4) PTR for `84.247.138.34` &rarr; `vmi3715354.contaboserver.net.` (Contabo default); (5) DMARC &rarr; `(NO RECORD)`. Derived exact DKIM TXT record bit-for-bit from `/etc/opendkim/keys/notify.btctoons.com/postal.private` matching `postal.txt`. Distinguish local matching from public DNS verification. |
| **T06** | Full Isolated Verification Test Suite (116/116) | **DONE** | Ran isolated PostgreSQL container `raxo_test_postgres` on `127.0.0.1:55432` (`raxo_demo`), separate test database `raxo_email_test`, ephemeral storage, and Mailpit trap. Production database untouched. Diagnosed test harness: Node emits `error` on spawn failures (`ENOENT` for `curl` inside minimal `node:22-slim`); added `cp.on("error")` handler in `test/unit.services.test.ts` and built `raxo-test-runner` containing `curl`. Executed full suite: **56/56 Unit Tests PASSED** (7 suites in 3.6s); **60/60 Integration Tests PASSED** (7 suites including F03/F04 A14–A16 and F08 W17–W18; run under `--user node` so R02 `chmod 0555` EACCES unlink check is not bypassed). Total: **116 executed, 116 passed, 0 failed, 0 skipped**. Cleaned up test database and forwarder. |
| **T07** | PDF Validation, Backup/Restore, Live Test Form | **DONE** | (1) Validated PDF fixture `examples/verified_test.pdf` (637 bytes, Letter size, PDF 1.4); verified text extraction with `pdftotext` without errors or `|| true`: extracts `Raxo Email verified production delivery test PDF fixture`. (2) Implemented `scripts/backup.sh` and `scripts/restore.sh`. Tested full backup (`db_dump.pgcustom`, `storage.tar.gz`, `config.tar.gz`, `SHA256SUMS`) and verified restore into isolated database `raxo_restore_test` without errors or `|| true`, confirming all 8 tables and storage archives. Off-server backup marked **PENDING** (no remote destination configured). (3) Updated `src/multipart.ts` to parse `cf-turnstile-response`. Updated `src/views.ts` and `src/http.ts` to serve live operator test form at `https://forms.btctoons.com/test` and `examples/operator-test-form.html` with `data-action="submit_form"` and fields `full_name`, `email`, `message`, `attachments`. Rebuilt `mail-test1-api` container. |

---

## 3. Detailed Verification Results

### 3.1 Test Harness Explanation & Fix
In `test/unit.services.test.ts`:
- **Observed Failure**: When executing tests in a minimal container environment (`node:22-slim`) where `curl` was not installed, `spawn("curl", ...)` failed to launch the binary.
- **Node.js Subprocess Lifecycle**: When `spawn()` cannot find or execute the binary, Node emits an `'error'` event (`ENOENT`). Without an explicit `cp.on("error")` listener on the `ChildProcess` instance, Node throws an unhandled EventEmitter error, preventing the Promise from settling and causing test runners to hang or abort.
- **Fix**: Added `cp.on("error", (err) => resolve({ status: 127, stdout, stderr: err.message }))` in `runProcessAsync`. This safely catches spawn errors and maps them to standard exit status 127 (command not found) without altering any test assertions. Built `raxo-test-runner` with `curl` to allow integration tests requiring curl to run cleanly.

### 3.2 PDF Generation & Independent Parser Validation
- Fixture path: `examples/verified_test.pdf` (and `/tmp/verified_test.pdf`).
- File size: 637 bytes.
- Structure: PDF 1.4 catalog, page tree, 1 page (Letter size 612x792 pts), Helvetica font, content stream with calculated length, cross-reference table, and `%%EOF` marker.
- **Verification without suppression**:
  - `pdfinfo examples/verified_test.pdf`:
    - `Pages: 1`
    - `Page size: 612 x 792 pts (letter)`
    - `PDF version: 1.4`
    - Exit code: 0
  - `pdftotext examples/verified_test.pdf -`:
    - Extracted exact text: `Raxo Email verified production delivery test PDF fixture`
    - Exit code: 0

### 3.3 Certificate Synchronization Engine & Boot State
- Script installed: `/root/mail-test1/scripts/raxo-sync-postfix-certs.sh` &rarr; `/usr/local/bin/raxo-sync-postfix-certs.sh` (mode 0755).
- Cron job installed: `/etc/cron.d/raxo-cert-sync` (daily at 03:15 UTC).
- Execution in clean cron environment:
  - Command: `env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/local/bin/raxo-sync-postfix-certs.sh`
  - Output: `[2026-11-01T12:17:13Z] Certificate and key for mail.btctoons.com are up to date. No action needed.`
  - Exit code: 0
- Services enabled on boot (`systemctl is-enabled`):
  - `docker`: `enabled`
  - `postfix`: `enabled`
  - `opendkim`: `enabled`
  - `cron`: `enabled`

### 3.4 Application Data Backup & Restore Procedure
- **Backup Script (`scripts/backup.sh`)**:
  - Dumps PostgreSQL database using `docker exec raxo_postgres pg_dump -U raxo_user -d raxo_production -F c`.
  - Archives attachment storage volume (`/var/lib/docker/volumes/mail-test1_attachment_storage/_data`).
  - Archives runtime configuration (`.env.production`, `config/forms.json`, `Caddyfile`, Postfix/OpenDKIM configs, `sasldb2`).
  - Calculates SHA256 checksums in `SHA256SUMS`.
  - Mode: 0700.
- **Restore Verification (`scripts/restore.sh`)**:
  - Verifies SHA256 checksums of all archive components.
  - Creates isolated test database `raxo_restore_test` on production PostgreSQL container.
  - Restores dump using `pg_restore -U raxo_user -d raxo_restore_test --no-owner --no-privileges` without errors or `|| true`.
  - Confirmed all 8 tables restored: `attachments`, `notifications`, `rate_buckets`, `registered_forms`, `schema_meta`, `schema_migrations`, `send_attempts`, `submissions`.
  - Extracts and tests storage directory structure (`clean`, `mime`, `quarantine`, `tmp`).
  - Tests configuration archive integrity.
  - Drops isolated test database `raxo_restore_test`.
- **Off-Server Destination**: **PENDING** (backups currently reside on host at `/root/mail-test1-backups/`; configure remote rsync, SFTP, or S3 destination when ready).

### 3.5 Browser Test Form & Turnstile Configuration
- Public test form live at: `https://forms.btctoons.com/test` (and standalone `examples/operator-test-form.html`).
- Target endpoint: `https://forms.btctoons.com/forms/vps-delivery-test`.
- Form fields: `full_name` (required), `email` (required, set to `kumudu.uog@gmail.com`), `message`, `attachments`.
- Turnstile integration:
  - Loads `https://challenges.cloudflare.com/turnstile/v0/api.js`.
  - Widget div: `<div class="cf-turnstile" data-sitekey="<sitekey>" data-action="submit_form" data-theme="dark"></div>`.
  - Injected token field: `cf-turnstile-response`.
  - Gateway multipart parser (`src/multipart.ts`) extracts `cf-turnstile-response` into `parsed.captchaToken`.
  - Gateway captcha validator (`src/captcha.ts`) verifies secret, success, action (`submit_form`), and hostname (`forms.btctoons.com` or `btctoons.com`).

---

## 4. Operator Action Checklist

### A. Cloudflare DNS Settings (Domain: `btctoons.com`)

| Type | Name / Hostname | Value / Content | TTL |
| :--- | :--- | :--- | :--- |
| **TXT** | `postal._domainkey.notify` *(or `postal._domainkey.notify.btctoons.com`)* | `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwh8MP9psTq9J1ZOB+wr0Pto9uBPQ6wBePyERuNb554Tjf4VmrKquNsGLuSZyiYnBLFJ3dEz7cyddXMu9zZl+oDz5IMffrEbCvz3xD+daW+RicrS0qSG3LkUO58yFZusQswHsPaVTM/FA6IWf3E6Ig/r4Fq7bNDC0l3UENDgjHi+wdCzL54/sbW21fhHV4xzQ7CM/CdrfOKf5I6LkBnE411Y7K4oxLMWyzfwDvD0vN/+VAcNG7/1HADarx0auQYLS7aa8EjBSlHS1GkSJsJC5kpQzx3U8G/kqRwJwvac0tZn3Yz/k2ig+RcAocYsh1c5gl4r/mFckFAAF0ic/COqk5QIDAQAB` | Auto / 1 min |
| **TXT** | `_dmarc.notify` *(or `_dmarc.notify.btctoons.com`)* | `v=DMARC1; p=none;` | Auto / 1 min |

> **Key Derivation Note**: The DKIM public key above was freshly derived directly from the active private signing key `/etc/opendkim/keys/notify.btctoons.com/postal.private` (`openssl rsa -in postal.private -pubout -outform DER | base64`) and confirmed to match `postal.txt`.  
> **Distinction Note**: Local matching verifies that the private key on disk generates this exact public key. Successful public DNS verification occurs only when external resolvers (e.g. `1.1.1.1`) query `postal._domainkey.notify.btctoons.com` and return this TXT record. If a downstream rejection occurs, check the Postfix transcript to confirm whether SPF or DKIM failed; do not attribute SPF failure to missing DKIM.

### B. Contabo Customer Control Panel (Reverse DNS / PTR)

- **Target IP**: `84.247.138.34`
- **Current PTR**: `vmi3715354.contaboserver.net.`
- **Required PTR**: `mail.btctoons.com`
- **Location in Contabo CCP**: VPS Control &rarr; Reverse DNS Management &rarr; set PTR for `84.247.138.34` to `mail.btctoons.com`.

### C. Cloudflare Turnstile Real Keys (Production CAPTCHA)

1. In Cloudflare Dashboard &rarr; **Turnstile** &rarr; **Add Widget**.
2. **Widget Name**: `Raxo Forms Gate` (or similar).
3. **Domains**: `forms.btctoons.com`, `btctoons.com`.
4. **Widget Mode**: `Managed` (or `Non-interactive`).
5. Obtain the generated **Site Key** (`0x4AAAAAA...`) and **Secret Key** (`0x4AAAAAA...`).
6. Update private server configuration:
   - In `/root/mail-test1/.env.production`, set:
     ```env
     CAPTCHA_SECRET=<real_secret_key>
     CAPTCHA_SITEKEY=<real_site_key>
     ```
   - In `/root/mail-test1/examples/operator-test-form.html`, update line 201:
     ```html
     data-sitekey="<real_site_key>"
     ```
7. Recreate the API container:
   ```bash
   docker compose -f /root/mail-test1/docker-compose.prod.yml up -d api
   ```
8. Visit `https://forms.btctoons.com/test` in your browser to submit the verified test form with `examples/verified_test.pdf`.
