# Implemented Quickstart Guide

This quickstart guides you through setting up and running Raxo Email Forms Core (`raxo-email` v0.1.0-alpha) locally from a clean checkout.

## Prerequisites

- Linux x86_64
- Node.js >= 22 (tested on Node 22.23.3)
- pnpm (tested on pnpm 12.6.0)
- Local loopback services:
  - PostgreSQL 15 on port `55432` (`raxo_demo` / `local_demo_only`)
  - Mailpit on port `1025` (SMTP) and `8025` (HTTP API)
  - ClamAV daemon (`clamd`) on port `3310`

## 1. Setup Configuration & Environment

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Create local environment file from example
cp .env.example .env

# Generate unique IP hashing secret in .env
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {readFileSync,writeFileSync} from "node:fs"; const p=".env"; const s=readFileSync(p,"utf8"); if(!/^IP_HASH_SECRET=$/m.test(s)) throw new Error("Expected blank IP_HASH_SECRET"); writeFileSync(p,s.replace(/^IP_HASH_SECRET=$/m,"IP_HASH_SECRET="+randomBytes(32).toString("hex")));'

# Create forms configuration from example
mkdir -p config data/quarantine data/clean data/mime data/tmp exports
cp config/forms.example.json config/forms.json
```

## 2. Start Services & Apply Migrations

```bash
# Start background loopback services (PostgreSQL, Mailpit, ClamAV)
./scripts/services.sh up

# Run database migrations into raxo_email_demo
pnpm run db:migrate
```

## 3. Verify with End-to-End Demo

```bash
# Run deterministic end-to-end demo verification
pnpm run demo:verify
```

The demo script:

1. Submits a synthetic job application with a valid PDF to `http://127.0.0.1:3000/forms/job-application`.
2. Validates 202 Accepted receipt and tests idempotent deduplication on resubmission.
3. Worker scans PDF with ClamAV, generates immutable MIME, and hands off to local Mailpit SMTP.
4. Polls Mailpit API, exports attachment using the operator CLI, and asserts identical 3-way SHA-256 checksums.

## 4. Run Development Servers

Run the HTTP gateway and worker processes in separate terminals:

```bash
# Terminal 1: HTTP Gateway
pnpm run dev

# Terminal 2: Background Worker
pnpm run dev:worker
```

Open `http://127.0.0.1:3000/demo/job-application` in your browser to submit forms interactively.
Open Mailpit Web UI at `http://127.0.0.1:8025` to inspect captured emails.

## 5. Operator CLI Commands

```bash
# Validate forms configuration
pnpm run cli -- forms validate

# List recent submissions metadata (excludes field values)
pnpm run cli -- submissions list --form job-application --limit 20 --json

# Show details of a submission (fields, attachment metadata, notification status)
pnpm run cli -- submissions show <submission-uuid> --json

# Export clean verified PDF attachment exclusively (mode 0600)
pnpm run cli -- attachments export <attachment-uuid> --out ./exports/applicant.pdf

# Tombstone submission and cancel unstarted notifications
pnpm run cli -- submissions delete <submission-uuid> --confirm

# Run retention cleanup manually with optional timestamp
pnpm run cli -- retention run --now 2026-10-25T00:00:00Z
```
