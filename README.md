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
- Not run: tests on the production host; CI on GitHub; rustfmt (not installed in the build environment).
- Sentinel binary/database are obtained from the private sentinel repository at a pinned commit
  (see `deploy/sentinel`); a fresh clone needs read access to it.
