# Raxo Email — Rust backend

Rust implementation of the Raxo Email backend (Tokio, axum, sqlx/PostgreSQL, lettre).
RaxoSentinel is the only scanner (ClamAV is not used) and is reached over its Unix socket.
RaxoSentinel is an external, pinned component; its source is not part of this repository.

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

| Sentinel verdict                       | Disposition | Category        |
| -------------------------------------- | ----------- | --------------- |
| CLEAN                                  | included    | –               |
| DETECTED, SUSPICIOUS                   | withheld    | `flagged`       |
| UNSCANNED, ERROR, BUSY, TIMEOUT        | withheld    | `not_inspected` |

The message body and permitted attachments are still delivered, with a plain-text/HTML security notice
(count, escaped original filenames, flagged vs. could-not-be-inspected). Withheld files are never
attached and stay in quarantine. The delivered MIME is stored immutably, so retries re-send the same
message and cannot deliver a withheld file. `ATTACHMENT_POLICY=block_message` restores whole-message blocking.
`ATTACHMENT_SCAN_RETRIES` (0–4) adds delayed re-scans for transient scanner failures before withholding.
Dispositions are recorded in `attachments` (migration `005`), verdicts in `scan_results`.

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
| `SMTP_HELO_NAME` | `raxo-email.local` (relay) | EHLO name, a FQDN; **required** in direct mode, should match the PTR (`mail.btctoons.com`) |
| `SMTP_DIRECT_PORT` | `25` | Destination port for direct MX delivery (override only for tests) |
| `SMTP_DIRECT_IPV4_ONLY` | `true` | Only connect to IPv4 addresses of MX hosts (`false` tries IPv4 first, then IPv6) |
| `DKIM_DOMAIN` | – | Signing domain (`d=`) |
| `DKIM_SELECTOR` | – | Selector (`s=`); the key is published at `<selector>._domainkey.<domain>` |
| `DKIM_PRIVATE_KEY_PATH` | – | RSA private key, PEM PKCS#8 or PKCS#1, ≥ 1024 bits (2048 recommended) |

The three `DKIM_*` variables must be set together or not at all. When they are set, the key is loaded and
test-signed at startup, and an invalid key aborts startup. Key material is never logged.
`SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_USERNAME` and `SMTP_PASSWORD` apply only to relay mode.

### CLI

```sh
# generate an RSA-2048 key (PKCS#8 PEM, mode 0600, never overwrites) and print the DNS TXT record
raxo-cli dkim generate --domain btctoons.com --selector raxo1 --out /etc/raxo/dkim/raxo1.pem
#   Name:  raxo1._domainkey.btctoons.com
#   Value: v=DKIM1; k=rsa; p=MIIBIjANBg...
# compare the configured key with the published TXT record (exit 0 match, 3 mismatch/not published, 4 DNS error)
raxo-cli dkim check
# send a DKIM-signed system message through the configured delivery mode, print classification + receipt
raxo-cli send-test --to you@example.org [--from notifications@btctoons.com]
```

`dkim check` and `send-test` read the normal configuration from the environment (`DATABASE_URL` must be
set but no database connection is made). `send-test` sends real mail in direct mode.

### Production environment (`.env.production.example`)

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://raxo:CHANGE_ME@127.0.0.1:5432/raxo
FORMS_CONFIG_PATH=/etc/raxo/forms.json
STORAGE_DIR=/var/lib/raxo/data
MESSAGE_ID_DOMAIN=btctoons.com
CAPTCHA_SECRET=CHANGE_ME
IP_HASH_SECRET=CHANGE_ME_LONG_RANDOM
TRUSTED_PROXY_CIDRS=127.0.0.1/32
OUTBOUND_ENABLED=true

# direct delivery from 84.247.138.34 (PTR mail.btctoons.com), no relay
SMTP_DELIVERY_MODE=direct
SMTP_HELO_NAME=mail.btctoons.com
SMTP_DIRECT_PORT=25
SMTP_DIRECT_IPV4_ONLY=true
SMTP_MAX_MESSAGE_BYTES=20971520

DKIM_DOMAIN=btctoons.com
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
- matching forward DNS for `mail.btctoons.com`.

Outbound TCP/25 must be open at the VPS provider.

## Build and test

```sh
cargo build --release
# tests need a throw-away PostgreSQL (they fail, not skip, if it is unreachable)
docker run -d --name raxo_rust_testpg -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=testpw postgres:16
cargo test        # 12 unit + 14 attachment-policy + 10 direct-delivery + 2 migration tests
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
- Staging runs used `DEMO_MODE=true`, loopback API and Mailpit; production SMTP routing was not touched.
- Not performed: a Node-vs-Rust comparison (dropped at the project owner's direction) and any performance
  benchmark. No performance claim is made.
- Not run: tests on the production host; CI on GitHub.
- Sentinel binary/database are obtained from the private sentinel repository at a pinned commit
  (see `deploy/sentinel`); a fresh clone needs read access to it.
- Direct delivery and DKIM were verified only against local fake SMTP servers, an injected resolver and
  in-memory DKIM verification. No real mail was sent to the internet, and deliverability to large
  providers (Gmail, Outlook) was not measured. `raxo-cli send-test` is the first live check.
- Opportunistic TLS accepts unverified certificates by design (like Postfix `may`), so there is no
  MTA-STS or DANE enforcement. Retries after `SafeRetry` follow the existing queue backoff. There is no
  per-domain connection reuse or rate limiting.
- DKIM signing uses the `rsa` 0.9 crate, which is affected by RUSTSEC-2023-0071 (Marvin timing
  side-channel). Signing happens locally with no attacker-observable decryption oracle, so the
  practical risk is low.
- `migrations_001_to_004_are_byte_identical_to_node_reference` needs the Node reference repository at
  `../raxo-email/migrations` and fails when it is absent.
