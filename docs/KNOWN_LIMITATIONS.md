# Known limitations (integration/node-sentinel)

Everything below was observed or executed; nothing is claimed that was not run.

## Test status (executed via `tests/node/run-node-tests.sh`, Node 22 container, throw-away PostgreSQL/ClamAV/Mailpit)

| Step                | Result                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `typecheck`         | passed                                                                                       |
| `test:unit`         | 56 / 56 passed                                                                               |
| `test:integration`  | 59 / 60 passed; 1 failed: `R02` (retention, disk-deletion failure)                           |
| `format:check`      | **fails** on 7 files (`src/multipart.ts`, `src/views.ts`, two `docs/*.md`, `examples/operator-test-form.html` were already unformatted on `main`; `src/dual-scan.ts` and `test/unit.config.test.ts` are integration changes) |
| Staging e2e (`tests/staging/e2e.mjs`) | run earlier against the isolated stack (result files are not committed because they contain runtime data) |

`R02` injects a failed delete by `chmod 0555` on the quarantine directory. The test container runs as
root, which ignores directory permissions, so the delete succeeds and the assertion
`Attachment file must remain after failed deletion` fails. This looks like a test-environment artefact,
but it has not been re-run as a non-root user, so it is not verified as such.

## RaxoSentinel integration

- **Shadow only.** Sentinel never blocks. ClamAV remains the only blocking authority.
- **Detection gap:** an EICAR payload inside a PDF-header polyglot whose ZIP member is *deflated*
  is reported `CLEAN` by Sentinel while ClamAV detects it. EICAR in plain PDF and stored-ZIP polyglots
  is detected by both.
- **Latency (earlier staging benchmark, small sample):** tiny PDF: Sentinel p50 ≈ 0.5 s, ClamAV ≈ 50 ms;
  9 MB PDF: Sentinel ≈ 0.7 s, ClamAV ≈ 1.6 s. Both scanners run in parallel.
- **Sentinel database and binary are not in this repository.** They are fetched from the private
  sentinel repository at a pinned commit and hash-verified (`deploy/sentinel`). A fresh clone
  therefore needs read access to that repo (token or a local clone).
- No rollback generation / hot-reload workflow is wired into the staging stack.
- The sentinel runtime requires glibc >= 2.39; the app image uses Ubuntu 24.04 for that reason.
- The Node app invokes the `raxosentinel client` binary once per scan (process spawn per attachment).

## Application behaviour that is intentional or inherited

- Forms accept **PDF only** (`application/pdf` and `%PDF-` header). "EICAR inside archives" is tested as
  PDF-header polyglots (stored/deflated ZIP), because plain ZIP uploads are rejected with 422.
- Per-IP limit is 5 submissions/minute, so the e2e script sleeps between submissions.
- Scanner failure budget: 5 failures -> notification `blocked` (`scanner_unavailable`). SMTP: 5 attempts
  (60 s, 5 min, 30 min, 2 h); ambiguous SMTP outcomes become `unknown` and are never auto-retried.

## Deployment

- `deploy/staging/prepare-clamav-defs.sh`: the *copy* path (`CLAMAV_DEFS_SRC`) was used; the freshclam
  download path has not been executed.
- Deployment on the production host (Contabo) was not exercised from this layout.
- `.github/workflows/ci.yml` was only adjusted for the `raxo-email/` working directory; it has not run on GitHub.
- No separate "handover" document was found in the repositories; this list is derived from the code,
  the tests and observed staging behaviour.
