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
