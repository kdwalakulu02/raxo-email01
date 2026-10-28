# Raxo Email Forms Core

Raxo Email Forms Core is a self-hosted, local-first website form gateway that retains fields and PDF files in durable storage before handing an email notification to a configured SMTP server.

**Status:** v0.1.0-alpha working component.

If downstream sending or network connectivity fails, submissions and uploaded attachments remain safely preserved on the operator's host.

---

## Example Form

Standard native HTML forms submit multipart data directly to the gateway:

```html
<form
  action="http://127.0.0.1:3000/forms/job-application"
  method="POST"
  enctype="multipart/form-data"
>
  <!-- Optional client submission ID for 24-hour idempotent deduplication -->
  <input type="hidden" name="_submission_id" value="3fa85f64-5717-4562-b3fc-2c963f66afa6" />
  <!-- Honeypot anti-spam field (must remain empty) -->
  <input type="hidden" name="_honey" value="" />

  <label for="fullName">Full Name</label>
  <input type="text" id="fullName" name="full_name" required maxlength="120" />

  <label for="email">Email</label>
  <input type="email" id="email" name="email" required maxlength="254" />

  <label for="position">Position</label>
  <input type="text" id="position" name="position" required maxlength="120" />

  <label for="portfolio">Portfolio URL</label>
  <input type="url" id="portfolio" name="portfolio" maxlength="500" />

  <label for="message">Message</label>
  <textarea id="message" name="message" rows="4" maxlength="4000"></textarea>

  <label for="attachments">Resume (PDF only, max 5 files, 10MB total)</label>
  <input type="file" id="attachments" name="attachments" accept=".pdf" multiple />

  <!-- Cloudflare Turnstile CAPTCHA widget (production) -->
  <div
    class="cf-turnstile"
    data-sitekey="your-turnstile-sitekey"
    data-action="submit_form"
    data-response-field-name="_captcha_token"
  ></div>

  <button type="submit">Submit Application</button>
</form>
```

---

## Workflow

1. **Save (Durable Ingest)**: Client submits `multipart/form-data`. Streams are validated, bounded, fsynced to private quarantine storage, and committed atomically to PostgreSQL before returning `202 Accepted` with a receipt UUID.
2. **Scan (Antivirus Gate)**: Background worker verifies attachment magic bytes and scans files using ClamAV (`clamd`). Malware detections immediately block the notification and quarantine the file.
3. **Queue (Reliable Outbox)**: Single-worker process holds PostgreSQL advisory lock `726901`. Heartbeats, lease renewals, and crash recovery ensure at-least-once handoff without duplicate concurrent workers.
4. **Handoff (SMTP Submission)**: Composes immutable plain-text MIME with raw PDF attachments and submits to your authorized SMTP server via Nodemailer. Bounded exponential retries are scheduled on transient 4xx refusals; ambiguous disconnects are marked `unknown` without dangerous automatic re-sends.

---

## Verified Quickstart

Follow the full [Implemented Quickstart Guide](docs/IMPLEMENTED_QUICKSTART.md) to set up and verify in under two minutes:

```bash
# 1. Install dependencies
pnpm install --frozen-lockfile

# 2. Setup configuration & secrets
cp .env.example .env
mkdir -p config data/quarantine data/clean data/mime data/tmp exports
cp config/forms.example.json config/forms.json
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {readFileSync,writeFileSync} from "node:fs"; const p=".env"; const s=readFileSync(p,"utf8"); if(!/^IP_HASH_SECRET=$/m.test(s)) throw new Error("Expected blank IP_HASH_SECRET"); writeFileSync(p,s.replace(/^IP_HASH_SECRET=$/m,"IP_HASH_SECRET="+randomBytes(32).toString("hex")));'

# 3. Start local services and apply database migrations
./scripts/services.sh up
pnpm run db:migrate

# 4. Run deterministic end-to-end verification
pnpm run demo:verify
```

For manual testing, run the HTTP gateway and worker processes in separate terminals:

- `pnpm run dev` (API on `http://127.0.0.1:3000`)
- `pnpm run dev:worker` (background worker)
- View interactive demo forms at `http://127.0.0.1:3000/demo/job-application`
- View captured notifications in Mailpit UI at `http://127.0.0.1:8025`

---

## Test & Demo Evidence

All 46 required acceptance tests pass with zero failures:

```bash
pnpm run check
```

- **Unit Tests (21/21 passed)**:
  - `U01 & U02`: Configuration validation, production safety rejections, migration idempotence.
  - `U03 & U04`: CR/LF injection rejection, path traversal sanitization, inert text retention, UTF-8 code point limits, PDF type enforcement, storage primitives.
  - `U05 & U06`: MIME generation round-trip, oversize MIME 413, explicit 4xx/5xx/pre-connect/auth classification, post-DATA disconnect and unrecognized error mapping to `unknown`.
- **Integration Tests (25/25 passed)**:
  - `A01–A11`: HTTP multipart streaming, 202 acceptance, idempotent deduplication, 409 conflict, 422 validation, 415 type check, 413 limits, honeypot, rate limiting, and route security.
  - `S01–S03`: Live ClamAV clean PDF scan, stale signature drop fail-closed, live EICAR malware blocking.
  - `W01–W11`: Worker handoff to Mailpit, connection refusal retry, no `delivered` claim, post-DATA disconnect unknown, crash recovery (`submitting -> unknown`, `preparing -> queued`), single-worker advisory lock `726901`, bounded retries with identical MIME SHA-256, malware/offline scanner gating, oversize MIME failure.
  - `C01–C04`: Operator CLI `list`, `show`, `export` with verified checksum and mode 0600, blocked malware export rejection, overwrite rejection, exit codes 2, 3, 4.
  - `R01–R05`: Immediate tombstoning, retryable disk deletion failures, 90-day retention boundaries, orphan file sweeping, and 410 Gone on reposting deleted client IDs.

Actual execution results are documented in [docs/DEMO_RESULTS.md](docs/DEMO_RESULTS.md).

---

## Scope & Limits

- **File Attachments**: PDF only (`application/pdf`). Non-PDF files, executables, scripts, and archives are strictly rejected.
- **Single Operator**: One administrator with host-local CLI and direct database access. No multi-tenant accounts or web dashboard.
- **Fixed Recipients**: Submissions are delivered only to pre-configured recipients defined in `config/forms.json`. Client-supplied recipient headers are rejected.
- **Local Storage**: Retains files on local private disk storage (`0700` directories) with atomic rename and fsync. No S3 or cloud storage dependencies.

---

## Limitations

- **Not an SMTP Engine**: This project does not ship an outbound mail server, DNS management, SPF/DKIM/DMARC signing, or IP reputation warm-up. You must connect it to an authorized SMTP server (such as a local Mailpit instance for development or a mail server like Postal/Postfix for production).
- **No Delivery Guarantees**: Positive SMTP handoff is recorded as `submitted`. Raxo Email does not claim inbox placement, delivery, or read receipts.
- **No Multi-Tenant SaaS**: There is no user signup, customer billing, or arbitrary `/send` API in this release.

---

## Documentation & Project Links

- [White Paper](GITHUB_PUBLIC_WHITE_PAPER.md)
- [Implemented Quickstart Guide](docs/IMPLEMENTED_QUICKSTART.md)
- [Locked Scope](docs/01_LOCKED_SCOPE.md)
- [Contracts and SQL Schema](docs/03_CONTRACTS_AND_SQL.md)
- [Processing Rules](docs/04_PROCESSING_RULES.md)
- [Build Status and Evidence](BUILD_STATUS.md)
- [Changelog](CHANGELOG.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [License](LICENSE.md)

---

## Third-Party Notices & Upstream Acknowledgements

Raxo Email Forms Core builds upon excellent open-source projects including Fastify, @fastify/multipart, Nodemailer, node-postgres, Zod, and ClamAV. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full licensing details.
