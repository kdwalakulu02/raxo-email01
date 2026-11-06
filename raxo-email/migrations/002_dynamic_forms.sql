-- Phase 1: Dynamic Forms, Held Notifications, and Extended Rate Buckets

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_state_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_state_check
  CHECK (state IN ('queued','preparing','retry_wait','submitting',
                  'submitted','unknown','blocked','failed','cancelled',
                  'held_unverified'));

ALTER TABLE rate_buckets DROP CONSTRAINT IF EXISTS rate_buckets_bucket_kind_check;
ALTER TABLE rate_buckets ADD CONSTRAINT rate_buckets_bucket_kind_check
  CHECK (bucket_kind IN ('ip_minute','form_day','register_ip_hour','verify_form_hour'));

CREATE TABLE IF NOT EXISTS registered_forms (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  recipient_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'active', 'deactivated')),
  verification_token_hash text,
  verification_expires_at timestamptz,
  management_token_hash text NOT NULL,
  resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  last_verification_sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deactivated_at timestamptz
);

CREATE INDEX IF NOT EXISTS registered_forms_recipient ON registered_forms(recipient_email);
CREATE INDEX IF NOT EXISTS registered_forms_status_created ON registered_forms(status, created_at);
