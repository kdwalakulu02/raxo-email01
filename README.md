# Raxo Email — Node.js + RaxoSentinel integration

Private repository. Branch `integration/node-sentinel` preserves the working Node.js Raxo Email
application together with the RaxoSentinel **shadow-scan** integration.

| Path                      | Content                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `raxo-email/`             | Node.js application (Fastify, PostgreSQL, ClamAV), migrations, unit/integration tests, Dockerfile |
| `deploy/staging/`         | Isolated staging stack (Compose), form config, env template, ClamAV defs helper |
| `deploy/sentinel/`        | Pinned RaxoSentinel version + verified fetch script (no sentinel code or DB is stored here) |
| `tests/node/`             | Containerised runner for the Node test suite                               |
| `tests/staging/`          | End-to-end and benchmark scripts for the staging stack                     |
| `docs/KNOWN_LIMITATIONS.md` | Accurate list of known issues and test results                           |

## Behaviour

- ClamAV (INSTREAM over TCP) makes **all** blocking decisions.
- RaxoSentinel scans the same SHA-256-verified bytes **in shadow mode** through its Unix-socket
  coordinator (`raxosentinel client --json-envelope`). Its verdict is recorded in `scan_results`
  (migration `004_scan_results.sql`) and never affects delivery. Sentinel errors/timeouts are recorded
  as `ERROR`/`TIMEOUT` rows; delivery still depends on ClamAV only.
- The sentinel container has `network_mode: none`; the only channel is the socket in `PRIVATE_DIR/run`.

## RaxoSentinel is an external, pinned component

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

## Run the isolated staging stack

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
