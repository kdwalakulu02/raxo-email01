# 03 — Fixed contracts and baseline SQL

## Form configuration file

The checked-in example has these two forms. Runtime config is a separate ignored copy. .test recipients are intentional and must never be changed to real addresses in public examples.

```json
{
  "version": 1,
  "forms": [
    {
      "id": "job-application",
      "enabled": true,
      "from": "notifications@example.test",
      "recipient": "owner@example.test",
      "subject_prefix": "Job application",
      "reply_to_field": "email",
      "success_url": null,
      "allowed_origins": ["http://127.0.0.1:3000"],
      "fields": [
        { "name": "full_name", "type": "text", "required": true, "max_length": 120 },
        { "name": "email", "type": "email", "required": true, "max_length": 254 },
        { "name": "position", "type": "text", "required": true, "max_length": 120 },
        { "name": "portfolio", "type": "url", "required": false, "max_length": 500 },
        { "name": "message", "type": "text", "required": false, "max_length": 4000 }
      ]
    },
    {
      "id": "contact",
      "enabled": true,
      "from": "notifications@example.test",
      "recipient": "owner@example.test",
      "subject_prefix": "Contact enquiry",
      "reply_to_field": "email",
      "success_url": null,
      "allowed_origins": ["http://127.0.0.1:3000"],
      "fields": [
        { "name": "full_name", "type": "text", "required": true, "max_length": 120 },
        { "name": "email", "type": "email", "required": true, "max_length": 254 },
        { "name": "message", "type": "text", "required": true, "max_length": 4000 }
      ]
    }
  ]
}
```

Validate JSON with Zod: strict objects, unique form IDs and field names, slug form IDs matching ^[a-z0-9][a-z0-9-]{0,39}$, no reserved names, maximums in scope doc. Mail addresses are simple single addresses, no display names or CR/LF. URL fields accept only http/https; never fetch them. Production success_url and allowed_origins must use HTTPS and cannot be wildcard. success_url is set by operator, never a visitor.

Normalize string values to NFC, trim outer whitespace, convert CRLF to LF for text bodies, and enforce code point and UTF-8 byte limits. Empty optional values become null; no HTML interpretation. Reject invalid email with schema validation. Preserve email local part, normalize its domain.

The reply_to_field must reference a configured email field. If optional and absent, omit Reply-To.

## HTTP

POST /forms/:form_id accepts multipart/form-data only.
User field names must exist in the form schema.
Control fields:

- attachments: repeat file parts, maximum 5; PDF only.
- _captcha_token: optional in loopback demo, required in production.
- _honey: optional text; nonempty means silently discard without mail/storage.
- _submission_id: optional UUID v4 for retry deduplication.

No duplicate text/control fields. Unknown fields and any client _to/_cc/_from/_next/_subject/_webhook are rejected.

Application/json and urlencoded bodies get 415 in this version. No generic send route exists.
Disabled form -> 403. Unknown form -> 404. In-flight upload capacity or persistence dependency unavailable -> 503.

JSON success when Accept explicitly includes application/json:

```json
{ "submission_id": "00000000-0000-4000-8000-000000000001", "status": "received" }
```

Return 202, not 200 delivered.
HTML success: 303 to configured success_url when non-null; otherwise a minimal hosted receipt page at the same POST response with 202. Do not put field values in URLs. All pages include clear labels and escaped plain text.

Honeypot response is generic 202 with status=received and submission_id=null; HTML gives the same generic receipt wording. No stored record or SMTP action.

Errors:

```json
{
  "error": {
    "code": "file_too_large",
    "message": "Attachments exceed the allowed size.",
    "request_id": "00000000-0000-4000-8000-000000000002"
  }
}
```

Codes: invalid_form_data(422), unsupported_type(415), file_too_large(413), invalid_pdf(422), captcha_failed(422), rate_limited(429), idempotency_conflict(409), service_unavailable(503). Invalid syntax -> 400. Do not echo submitted content or stack traces. HTML failure renders safe explanatory text with the same status.

GET /health/live -> 200 {"status":"ok"} when process alive.
GET /health/ready -> 200 {"status":"ready"} only if DB, storage write probe, scanner readiness/freshness and worker heartbeat <=60s pass; otherwise 503 {"status":"not_ready"}. It does not test remote deliverability. The heartbeat is stored in DB under schema_meta so HTTP/worker agree.

No GET record API or file download API. Requests to /send, /emails and /owner return 404.

The loopback demo additionally serves GET /demo/job-application and GET /demo/contact. Production returns404 for both. No other routes are allowed.

## SQL: copy this baseline into migrations/001_initial.sql

Use app-generated UUIDs and no database extension requirement. Application supplies snapshots/fields; JSON schema validation is in code.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE schema_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE submissions (
  id uuid PRIMARY KEY,
  form_id text NOT NULL,
  client_submission_id uuid,
  fingerprint text NOT NULL,
  fields jsonb,
  config_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  cleanup_done boolean NOT NULL DEFAULT false,
  UNIQUE (form_id, client_submission_id)
);
CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  scan_state text NOT NULL DEFAULT 'pending'
    CHECK (scan_state IN ('pending','clean','blocked','error','deleted')),
  scan_version text,
  scanned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  message_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','preparing','retry_wait','submitting',
                    'submitted','unknown','blocked','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  prepare_failures integer NOT NULL DEFAULT 0 CHECK (prepare_failures >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  mime_key text,
  mime_sha256 text,
  last_error_code text,
  smtp_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE send_attempts (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id),
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  outcome text NOT NULL CHECK (outcome IN
    ('submitting','submitted','safe_retry','failed','unknown')),
  error_code text,
  receipt jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (notification_id, attempt_number)
);
CREATE TABLE rate_buckets (
  form_id text NOT NULL,
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('ip_minute','form_day')),
  bucket_key text NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (form_id, bucket_kind, bucket_key)
);
CREATE INDEX attachments_submission ON attachments(submission_id);
CREATE INDEX submissions_listing ON submissions(created_at DESC,id DESC);
CREATE INDEX notifications_due ON notifications(next_attempt_at,created_at)
  WHERE state IN ('queued','retry_wait');
CREATE INDEX notifications_leases ON notifications(lease_expires_at)
  WHERE state IN ('preparing','submitting');
```

Migration runner bootstraps schema_migrations with the identical IF NOT EXISTS definition before checking files. Do not rewrite migration text. All other tables must not silently mask schema drift. Store exact file checksum after execution in the same transaction; reject modified applied migrations. Advisory lock prevents simultaneous migrations.

No destructive down migrations, reset command or table drop is included.

## Acceptance transaction

After persistent staging:
BEGIN -> insert submissions -> insert attachment rows -> insert queued notifications -> COMMIT.
Rollback means no accepted record. Notification is the outbox: no extra broker/outbox table is needed. A no-file submission still has one queued notification.

Store the form config snapshot including the fixed sender/recipient and plain subject prefix. SHA-256 fingerprint is canonical JSON of normalized fields plus ordered attachment name/size/checksum tuples. Exclude CAPTCHA, honeypot, receipt UUID and boundary details.

Dedup:

- Without _submission_id, every accepted POST creates a record.
- With one, unique(form_id, client_submission_id) selects original within 24h.
- Same fingerprint -> original receipt, no new notification, orphan new staged objects reclaimed.
- Changed fingerprint -> 409, original untouched.
- Deleted record -> 410 if its dedup tombstone still exists.
- After 24h, an old client ID gets 409 expired_submission_id, never silently treated as a new notification while its row exists.

Do not implement a non-atomic SELECT then INSERT. Catch unique conflict or use INSERT ON CONFLICT with a scoped follow-up read.

## State transitions

queued/retry_wait -> preparing -> submitting -> submitted.
preparing -> blocked (malware), retry_wait (scanner dependency), failed (invalid MIME/config).
submitting -> retry_wait only on explicit safe-not-accepted evidence; failed on definitive rejection; unknown on ambiguous outcomes.
Expired preparing -> queued. Expired submitting -> unknown.
Pending queued/retry_wait/blocked/failed -> cancelled on deletion.
Unknown and submitted are not automatically queued again.

No state named delivered, inbox or read exists in v0.1.

## CLI

```text
npm run cli -- forms validate
npm run cli -- submissions list --form job-application --limit 20 --json
npm run cli -- submissions show <uuid> --json
npm run cli -- attachments export <uuid> --out ./exports/demo.pdf
npm run cli -- submissions delete <uuid> --confirm
npm run cli -- retention run --now <ISO-UTC>
npm run cli -- notifications show <uuid> --json
```

All CLI commands use the operator's DB/storage access. Invalid args exit 2; missing/inaccessible object exits 3; dependency failure exits 4; success exits 0. No retry/resolve command is included in v0.1. Unknown attempts are inspected in the CLI and engine logs; automatic/manual resend tooling is a later task.

Listing excludes deleted content and prints metadata, not field values. Show includes normalized fields, file checksums/states and notification status; never dumps secrets or raw MIME. Export requires a clean fresh scan, verified checksum, and a new output file created exclusively; no overwrite. Data paths cannot escape STORAGE_DIR.
