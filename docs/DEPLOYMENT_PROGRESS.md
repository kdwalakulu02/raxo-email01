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
