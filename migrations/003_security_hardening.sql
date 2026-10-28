-- Migration 003: Security Hardening Rate Limits
-- Expands rate_buckets bucket_kind check to support:
-- - register_recipient_hour: per-recipient email form registration limit (anti-mailbombing)
-- - global_minute: system-wide submission throttling (anti-DDoS)
-- - deactivate_form_hour: per-form deactivation attempt throttling (anti-bruteforce)

ALTER TABLE rate_buckets DROP CONSTRAINT IF EXISTS rate_buckets_bucket_kind_check;
ALTER TABLE rate_buckets ADD CONSTRAINT rate_buckets_bucket_kind_check
  CHECK (bucket_kind IN (
    'ip_minute',
    'form_day',
    'register_ip_hour',
    'register_recipient_hour',
    'verify_form_hour',
    'global_minute',
    'deactivate_form_hour'
  ));
