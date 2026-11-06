# Raxo Email — Rust backend

Rust implementation of the Raxo Email backend (Tokio, axum, sqlx/PostgreSQL, lettre).
RaxoSentinel is the only scanner (ClamAV is not used) and is reached over its Unix socket.
RaxoSentinel is an external, pinned component; its source is not part of this repository.

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

## Build and test

```sh
cargo build --release
# tests need a throw-away PostgreSQL (they fail, not skip, if it is unreachable)
docker run -d --name raxo_rust_testpg -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=testpw postgres:16
cargo test        # 3 unit + 14 attachment-policy + 2 migration tests
cargo clippy --all-targets
```

Staging stack: `deploy/staging-rust/compose.rust.yml` (see `tests/compare/` for the driver).

## Known limitations (verified against what was executed)

- Only `application/pdf` uploads are accepted (inherited upload validation). Archive formats are
  therefore exercised only as PDF-header polyglots; plain zip/tar/gz uploads get HTTP 422.
- Sentinel reported CLEAN for an EICAR PDF-header polyglot whose ZIP member is *deflated*; that file was delivered.
  The stored-ZIP polyglot and plain EICAR PDF were detected and withheld. This is a Sentinel detection gap.
- The API caps in-flight submissions at 2 and answers 503 beyond that (20 of 40 burst requests were rejected in staging).
- Inbound / signed-message handling (`inbound.rs`) is groundwork only: detection and secure original
  storage exist, there is no inbound SMTP listener.
- Staging runs used `DEMO_MODE=true`, loopback API and Mailpit; production SMTP routing was not touched.
- Not performed: a Node-vs-Rust comparison (dropped at the project owner's direction) and any performance
  benchmark. No performance claim is made.
- Not run: tests on the production host; CI on GitHub; rustfmt (not installed in the build environment).
- Sentinel binary/database are obtained from the private sentinel repository at a pinned commit
  (see `deploy/sentinel`); a fresh clone needs read access to it.
