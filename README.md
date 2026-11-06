# Raxo Mail — Rust backend and preserved Node.js reference

Private repository. Active development is on
[`development/raxo-email-rust`](https://github.com/kdwalakulu02/raxo-email01/tree/development/raxo-email-rust).
The latest development changes are not necessarily merged into `main`.

The Rust backend uses **RaxoSentinel exclusively**, through its protected Unix socket. Each attachment
is scanned independently: clean files are permitted; detected/suspicious files and files that cannot
be inspected are withheld. The body and permitted attachments are delivered with a security notice
when needed. PostgreSQL records verdicts and dispositions; SMTP retries reuse immutable MIME.

See the [Rust backend README](raxo-email-rust/README.md) for build/test instructions, configuration,
verified results and limitations. Rust staging pins RaxoSentinel private prerelease
[`internal-mail-integration-20261107`](https://github.com/kdwalakulu02/raxosentinel/releases/tag/internal-mail-integration-20261107),
source commit `551fd35f3bd638952341d50c5fb172de17841cc8`, with the existing `phase2d6-unified` database
(542,057 indicators). The PDF-prefixed deflated EICAR ZIP is now detected and withheld in staging.

Branch `integration/node-sentinel` preserves the Node.js application and its older **shadow-scan**
integration. Its ClamAV requirements and deployment instructions below apply only to that reference,
not to the Rust backend.

| Path                      | Content                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `raxo-email-rust/`        | Active Rust backend, additive migrations, attachment-policy tests and scanner release pin |
| `deploy/staging-rust/`    | Isolated Rust staging stack (PostgreSQL, Mailpit, RaxoSentinel; no ClamAV) |
| `tests/compare/`          | Staging driver; use Rust selectors only, e.g. `node tests/compare/run.mjs rust S` |
| `raxo-email/`             | Node.js application (Fastify, PostgreSQL, ClamAV), migrations, unit/integration tests, Dockerfile |
| `deploy/staging/`         | Isolated staging stack (Compose), form config, env template, ClamAV defs helper |
| `deploy/sentinel/`        | Pinned RaxoSentinel version + verified fetch script (no sentinel code or DB is stored here) |
| `tests/node/`             | Containerised runner for the Node test suite                               |
| `tests/staging/`          | End-to-end and benchmark scripts for the staging stack                     |
| `docs/KNOWN_LIMITATIONS.md` | Historical Node integration issues and test results; current Rust limitations are in `raxo-email-rust/README.md` |

## Preserved Node reference behaviour

- ClamAV (INSTREAM over TCP) makes **all** blocking decisions.
- RaxoSentinel scans the same SHA-256-verified bytes **in shadow mode** through its Unix-socket
  coordinator (`raxosentinel client --json-envelope`). Its verdict is recorded in `scan_results`
  (migration `004_scan_results.sql`) and never affects delivery. Sentinel errors/timeouts are recorded
  as `ERROR`/`TIMEOUT` rows; delivery still depends on ClamAV only.
- The sentinel container has `network_mode: none`; the only channel is the socket in `PRIVATE_DIR/run`.

## Node reference: external RaxoSentinel artifacts

The following fetch script installs the older Node reference scanner. For the updated Rust scanner,
use the exact source/build pin and `SENTINEL_BIN_DIR` instructions in the [Rust README](raxo-email-rust/README.md).

`deploy/sentinel/PINNED.env` pins the private sentinel repo, the artifact commit and the SHA-256 of
every archive/binary/database. Nothing from the sentinel repo is vendored here (the database alone
contains a 104 MB file, over GitHub's per-file limit, and third-party-derived intelligence).

```bash
# Option A: from a local clone of the sentinel repo
SENTINEL_LOCAL_REPO=/path/to/raxosentinel PRIVATE_DIR=$HOME/raxo-private deploy/sentinel/fetch-sentinel.sh
# Option B: from the private GitHub repo (token with read access; never committed)
SENTINEL_GIT_TOKEN_FILE=/path/to/token PRIVATE_DIR=$HOME/raxo-private deploy/sentinel/fetch-sentinel.sh
```

The script verifies each pinned hash and fails closed on mismatch. It creates
`$PRIVATE_DIR/{bin,rsidb,run,clamav-defs}`.

## Run the isolated Node reference staging stack

```bash
cp deploy/staging/.env.staging.example deploy/staging/.env.staging   # edit: PRIVATE_DIR, passwords, IP_HASH_SECRET
deploy/sentinel/fetch-sentinel.sh                                    # see above
deploy/staging/prepare-clamav-defs.sh                                # ClamAV signatures
docker compose -f deploy/staging/compose.staging.yml --env-file deploy/staging/.env.staging up -d --build
node tests/staging/e2e.mjs                                           # end-to-end (needs Node >= 18)
```

Mailpit UI is bound to 127.0.0.1 only. No scanner ports are published. The staging stack uses its own
project name, network and volumes and does not touch any production service.

## Run the Node tests

```bash
PRIVATE_DIR=$HOME/raxo-private tests/node/run-node-tests.sh   # typecheck, unit, integration (Docker required)
```

## Never commit

Credentials/tokens, `.env*` files with secrets, runtime DBs/PostgreSQL volumes, attachments, logs,
`results/`. The ignore rules enforce this; only `*.example` templates are tracked.
