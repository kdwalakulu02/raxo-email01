# Raxo Email — Rust backend

Rust implementation of the Raxo Email backend (Tokio, axum, sqlx/PostgreSQL, lettre).
RaxoSentinel is the only scanner (ClamAV is not used) and is reached over its Unix socket.
RaxoSentinel is an external, pinned component; its source is not part of this repository.

## Public frontend

The `forms.raxo.email` site is plain HTML/CSS/vanilla JS in [`web/`](web/), compiled into `raxo-api`
with `include_bytes!` (no runtime files, no build tool). Edit `web/index.html`, `web/styles.css`,
`web/app.js` or `web/assets/*`, then release as usual.

- `web/index.html` is rendered by `views::render_generator_page`; `{{KEY}}` placeholders are filled
  in a single pass with HTML-escaped values.
- `GET /assets/{name}` serves only the files listed in [`src/web.rs`](src/web.rs); add new assets there.
- The generator posts to `POST /api/forms` (JSON). The response includes `html_snippet` and
  `attachment_snippet` (PDF-upload variant) for the copyable embed code.

## Pinned RaxoSentinel

| Item            | Value |
| --------------- | ----- |
| Release         | private prerelease `internal-mail-integration-20261107` (`kdwalakulu02/raxosentinel`) |
| Source commit   | `551fd35f3bd638952341d50c5fb172de17841cc8` |
| Build           | Ubuntu 24.04, rustup toolchain 1.99.1 (from `rust-toolchain.toml`), `cargo build --release --locked` |
| Executable      | `raxosentinel 0.1.0`, SHA-256 `43330d779c1bdf1f33535008e1e674dbaeff872b83bcf0b7ab6fce3760103b9a` |
| Database        | generation `phase2d6-unified`, 542,057 indicators, `database.rsidb` SHA-256 `0cd89989302a8fe91e9f21f32302afe937b9c1f4d19186ec9f1128d671e86b4f` (unchanged; not regenerated) |
| Previous binary | source `38a6a14`, SHA-256 `b5007cbd23e673c1f2af6703e6722496ca42f5389d1a280ac87753dbcea37782` (kept for rollback) |

The binary is built from the pinned source; it is not committed. The staging compose file mounts it from
`SENTINEL_BIN_DIR` (default: `${PRIVATE_DIR}/bin/bin`, the previous binary). Roll back by unsetting
`SENTINEL_BIN_DIR` and recreating the `sentinel` service only.

Scanner requirement: the new build parses PDFs strictly. A PDF with invalid xref offsets is `UNSCANNED`
and is therefore withheld by the attachment policy (`not_inspected`), even if common viewers open it.

## Attachment policy

Each attachment is scanned independently and gets its own decision (`ATTACHMENT_POLICY=withhold`, default):

| Sentinel verdict                                     | Disposition           | Category        |
| ---------------------------------------------------- | --------------------- | --------------- |
| CLEAN                                                | included              | –               |
| CLEAN with `incomplete` reasons (partial inspection) | included, with a note | –               |
| DETECTED, SUSPICIOUS, all threats named `Policy.*`   | withheld              | `policy`        |
| DETECTED, SUSPICIOUS (any other threat)              | withheld              | `flagged`       |
| UNSCANNED, ERROR, BUSY, TIMEOUT                      | withheld              | `not_inspected` |

The message body and permitted attachments are still delivered, with a plain-text/HTML security notice
(count, escaped original filenames, flagged vs. blocked by the file-type policy vs. could-not-be-inspected).
`policy` covers what the scanner reports as `Policy.*` (executables, scripts, disk images, macro-enabled
Office documents). A CLEAN verdict whose report lists `incomplete` reasons (RaxoSentinel v2, e.g. too many
PDF objects or an unsupported stream encoding) is delivered, and the notice lists it as only partially
inspected; the reasons are stored in `scan_results.incomplete`. Withheld files are never attached. The
delivered MIME is stored immutably, so retries re-send the same message and cannot deliver a withheld file.
`ATTACHMENT_POLICY=block_message` restores whole-message blocking.
`ATTACHMENT_SCAN_RETRIES` (0–4) adds delayed re-scans for transient scanner failures before withholding.
Dispositions are recorded in `attachments` (migrations `005`, `007`, `008`), verdicts in `scan_results`.

### File retention

Attachment and MIME files are kept only while they are needed; senders can resubmit.

- Attachment files (clean and quarantined, included and withheld) are deleted as soon as the notification's
  MIME message is persisted, or when the notification ends without one (blocked, cancelled, failed).
- Uploads to a form that is not verified yet (`held_unverified`) are deleted at submission time and
  recorded as withheld `not_retained` (migration `008`). After verification the email is delivered with a
  note listing those files and asking the sender to send them again. Nothing is kept for held submissions.
- The MIME file is kept while the notification can still be sent or retried (`queued`, `retry_wait`,
  `preparing`, `submitting`) and deleted, with `mime_key`/`mime_sha256` cleared, once it is terminal
  (`submitted`, `unknown`, `failed`, `blocked`, `cancelled`), for every kind of submission.
- The hourly retention sweep removes any files missed by the inline cleanup.
- Only database metadata stays: file name, size, SHA-256, verdict, disposition and `scan_results`.
  Form fields still expire after 90 days.
- `raxo-cli attachments export` fails with exit code 3 ("Attachment content is not retained after the
  notification is built") once the file is gone. A notification whose MIME pointer is lost after the files
  were removed fails closed with `attachment_integrity_error`; it is never rebuilt without its attachments.

## Outbound delivery and DKIM

Every outbound message (form notifications and system messages such as activation mails) is DKIM-signed
at send time when DKIM is configured: `rsa-sha256`, `relaxed/relaxed`, headers `From` (over-signed),
`To`, `Cc`, `Subject`, `Date`, `Message-ID`, `Reply-To`, `MIME-Version`, `Content-Type`. The signature is
computed over the stored immutable MIME and only prepended, so retries re-sign the same bytes. The signing
domain should align with the From domain (From equal to or a subdomain of `DKIM_DOMAIN`); a misaligned
From is logged as a warning and still signed.

`SMTP_DELIVERY_MODE` selects how mail leaves the host:

- `relay` (default): unchanged submission to `SMTP_HOST:SMTP_PORT` with `SMTP_TLS_MODE` and optional AUTH
  (used for tests and Mailpit).
- `direct`: no relay. The worker resolves the recipient domain's MX records, ordered by preference with
  equal preferences shuffled. A domain without MX falls back to its A/AAAA records (implicit MX). Null MX
  (`MX 0 .`, RFC 7505) and NXDOMAIN fail permanently, and SERVFAIL or a timeout is `SafeRetry`.
  - Connects to port `SMTP_DIRECT_PORT` and says `EHLO SMTP_HELO_NAME`. There is no AUTH.
  - STARTTLS is opportunistic, like Postfix `smtp_tls_security_level=may`. It is used whenever
    advertised and the certificate is checked against the MX hostname with webpki roots. If the check
    fails, delivery still goes over TLS. If the handshake itself fails, the same host is retried once
    in plaintext.
  - If a host is unreachable or answers 4xx before MAIL FROM is accepted, the next MX is tried, up to
    5 addresses in total.
  - A 5xx reply to MAIL or RCPT means `Failed`; a 4xx reply to RCPT or DATA means `SafeRetry`.
  - If the connection breaks after the message body was sent but before the final reply, the result
    is `Unknown`, which is never retried automatically.
  - The receipt records `delivery`, `mx_host`, `ip`, `tls` (`verified` / `unverified` / `none`) and
    `dkim` (`d`, `s`).

Each send carries a single recipient, so there is always exactly one RCPT domain per SMTP transaction.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `SMTP_DELIVERY_MODE` | `relay` | `relay` or `direct` (direct is rejected with `DEMO_MODE=true`) |
| `SMTP_HELO_NAME` | `raxo-email.local` (relay) | EHLO name, a FQDN; **required** in direct mode, should match the sending IP's PTR |
| `SMTP_DIRECT_PORT` | `25` | Destination port for direct MX delivery (override only for tests) |
| `SMTP_DIRECT_IPV4_ONLY` | `true` | Only connect to IPv4 addresses of MX hosts (`false` tries IPv4 first, then IPv6) |
| `SMTP_NODE_ID` | `local` outside production | Stable sending-node ID; **required** in production |
| `SMTP_WORKER_CONCURRENCY` | `3` | Maximum processing tasks per worker process (1–64); the node connection limit still applies |
| `DKIM_DOMAIN` | – | Signing domain (`d=`) |
| `DKIM_SELECTOR` | – | Selector (`s=`); the key is published at `<selector>._domainkey.<domain>` |
| `DKIM_PRIVATE_KEY_PATH` | – | RSA private key, PEM PKCS#8 or PKCS#1, ≥ 1024 bits (2048 recommended) |

The three `DKIM_*` variables must be set together or not at all. When they are set, the key is loaded and
test-signed at startup, and an invalid key aborts startup. Key material is never logged.
`SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_USERNAME` and `SMTP_PASSWORD` apply only to relay mode.

### Capacity and queue

Form notifications, activation messages and operator test messages all use the durable queue.
Each sending node defaults to **15 SMTP attempts per minute** and **3 concurrent SMTP
connections**; the default limit for a recipient email is 15 attempts per minute across nodes.
Every attempt, including a retry, consumes capacity. In-flight attempts count until they
finish and completed attempts count for another 60 seconds. Recipient email grouping is
not an authenticated tenant identity: aliases can bypass that grouping, but not the node cap.

All worker processes sending from one node must use the same PostgreSQL database,
`SMTP_NODE_ID` and storage/lock directory. Give different sending nodes different IDs.
Do not delete, copy or replace a node's `smtp-capacity` lock directory while workers are
running. A moved or restored lock directory requires a planned rebind with all workers
stopped. Other mail programs and older Raxo releases do not obey these limits.

Workers schedule recipient groups fairly. A temporary failure backs off the destination
domain on that node (initially 1 minute, then 5 minutes, 30 minutes and 2 hours) without
blocking unrelated domains. Safe failures are retried up to five total attempts; an
ambiguous post-DATA outcome or an expired submitting lease becomes `unknown` and is
never retried automatically. Inspect it before taking any manual action. Queued activation
messages expire with their verification token. Like every MIME file, theirs are removed
after terminal outcomes or by the retention sweep (see [File retention](#file-retention)).

Run these commands with the service's normal environment and database access:

```sh
raxo-cli capacity node --node contabo-1 --provider contabo --per-minute 15 --connections 3
raxo-cli capacity default --per-minute 15
raxo-cli capacity recipient --email owner@example.org --per-minute 5
raxo-cli capacity recipient --email owner@example.org --per-minute default
raxo-cli capacity stats --node contabo-1
```

`stats` reports node policy, recent attempts by outcome, queue states and active
destination backoffs. It is an operator command, not a public endpoint.

**Rollback:** migration `006_outbound_capacity` is additive, but the older worker and API
do not enforce capacity and send activation messages directly. Stop all workers before
switching releases; do not run old and new workers concurrently. If rolling back, arrange
separate outbound throttling or disable sending until the new release is restored.

### CLI

```sh
# generate an RSA-2048 key (PKCS#8 PEM, mode 0600, never overwrites) and print the DNS TXT record
raxo-cli dkim generate --domain raxo.email --selector raxo1 --out /etc/raxo/dkim/raxo1.pem
#   Name:  raxo1._domainkey.raxo.email
#   Value: v=DKIM1; k=rsa; p=MIIBIjANBg...
# compare the configured key with the published TXT record (exit 0 match, 3 mismatch/not published, 4 DNS error)
raxo-cli dkim check
# queue a real test message and inspect its notification ID for the eventual outcome
raxo-cli send-test --to you@example.org --from notifications@raxo.email
raxo-cli notifications show <notification-id>
```

`dkim check` reads the normal configuration but does not connect to the database. `send-test`
requires database and storage access, returns `queued` rather than a delivery receipt, and
requires a running worker. A successful SMTP receipt means the destination accepted the
message; it does not prove inbox placement or recipient-side authentication.

### Production environment (`.env.production.example`)

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://raxo:CHANGE_ME@127.0.0.1:5432/raxo
FORMS_CONFIG_PATH=/etc/raxo/forms.json
STORAGE_DIR=/var/lib/raxo/data
MESSAGE_ID_DOMAIN=raxo.email
CAPTCHA_SECRET=CHANGE_ME
IP_HASH_SECRET=CHANGE_ME_LONG_RANDOM
TRUSTED_PROXY_CIDRS=127.0.0.1/32
OUTBOUND_ENABLED=true

# direct delivery, no relay; forward and reverse DNS must agree
SMTP_DELIVERY_MODE=direct
SMTP_HELO_NAME=mail.raxo.email
SMTP_DIRECT_PORT=25
SMTP_DIRECT_IPV4_ONLY=true
SMTP_MAX_MESSAGE_BYTES=20971520
SMTP_NODE_ID=contabo-1
SMTP_WORKER_CONCURRENCY=3

DKIM_DOMAIN=raxo.email
DKIM_SELECTOR=raxo1
DKIM_PRIVATE_KEY_PATH=/etc/raxo/dkim/raxo1.pem

SENTINEL_SOCKET=/run/raxosentinel/scan.sock
SENTINEL_TIMEOUT_MS=15000
SENTINEL_MAX_SIZE=52428800
ATTACHMENT_POLICY=withhold
ATTACHMENT_SCAN_RETRIES=0
ATTACHMENT_NOTICE_HTML=true

# relay mode only (unused when SMTP_DELIVERY_MODE=direct)
# SMTP_HOST=127.0.0.1
# SMTP_PORT=587
# SMTP_TLS_MODE=starttls_required
# SMTP_USERNAME=
# SMTP_PASSWORD=
```

The DNS side is outside this service. Publish:
- the DKIM TXT record;
- SPF: `v=spf1 ip4:84.247.138.34 -all` on the From domain;
- DMARC: `_dmarc` with at least `p=none` initially;
- matching forward and provider-controlled reverse DNS for `mail.raxo.email`.

Outbound TCP/25 must be open at the VPS provider.

## Build and test

```sh
cargo build --release
# tests need a throw-away PostgreSQL (they fail, not skip, if it is unreachable)
docker run -d --name raxo_rust_testpg -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=testpw postgres:16
cargo test
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Staging stack: `deploy/staging-rust/compose.rust.yml` (see `tests/compare/` for the driver).

## Scanner update verification (staging, pinned build)

Run with `node tests/compare/run.mjs rust S`: clean PDF delivered; EICAR in a PDF-prefixed deflated ZIP and in
a stored ZIP withheld as `flagged`; mixed clean + two detected delivers only the clean file with a notice;
scanner stopped withholds the file as `not_inspected` and still delivers the body. Plain ZIP uploads are
rejected at upload (PDF only), so ordinary EICAR ZIPs were checked directly against the scanner socket (DETECTED).

## Known limitations (verified against what was executed)

- Only `application/pdf` uploads are accepted (inherited upload validation). Archive formats are
  therefore exercised only as PDF-header polyglots; plain zip/tar/gz uploads get HTTP 422.
- With the pinned build, the PDF-prefixed ZIP with a deflated EICAR member is DETECTED and withheld
  (verified in staging, see below). Not verified: other archive/obfuscation variants beyond the fixtures used.
- Sentinel's PDF parser is strict and classic-xref only (see its `docs/PDF_INSPECTION_PHASE3C2.md`);
  malformed or object-stream PDFs are `UNSCANNED` and get withheld. Real-world PDF coverage was not measured.
- The API caps in-flight submissions at 2 and answers 503 beyond that (20 of 40 burst requests were rejected in staging).
- Inbound / signed-message handling (`inbound.rs`) is groundwork only: detection and secure original
  storage exist, there is no inbound SMTP listener.
- Not performed: a Node-vs-Rust comparison (dropped at the project owner's direction) and any performance
  benchmark. No performance claim is made.
- Sentinel binary/database are obtained from the private sentinel repository at a pinned commit
  (see `deploy/sentinel`); a fresh clone needs read access to it.
- Automated direct-delivery and DKIM tests use local fake SMTP servers, an injected resolver and
  in-memory signature verification. Live deliverability and inbox placement must be checked separately.
- Opportunistic TLS accepts unverified certificates by design (like Postfix `may`), so there is no
  MTA-STS or DANE enforcement. There is no per-domain connection reuse.
- The public embedded-form route `/f/{form_id}` does not verify Turnstile, unlike `/forms/{form_id}`.
  Plan additional abuse controls before relying on it for untrusted traffic. The outbound queue can
  grow without bound if arrivals exceed sending capacity; monitor it and provision accordingly.
- DKIM signing uses the `rsa` 0.9 crate, which is affected by RUSTSEC-2023-0071 (Marvin timing
  side-channel). Signing happens locally with no attacker-observable decryption oracle, so the
  practical risk is low.
- `migrations_001_to_004_are_byte_identical_to_node_reference` needs the Node reference repository at
  `../raxo-email/migrations` and fails when it is absent.
