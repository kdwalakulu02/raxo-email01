-- Per-scanner scan results. ClamAV drives delivery policy; RaxoSentinel is shadow-only.
CREATE TABLE scan_results (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES notifications(id) ON DELETE CASCADE,
  scanner text NOT NULL CHECK (scanner IN ('clamav','raxosentinel')),
  shadow boolean NOT NULL DEFAULT false,
  verdict text NOT NULL CHECK (verdict IN ('CLEAN','DETECTED','ERROR','UNSCANNED','BUSY','TIMEOUT')),
  detection text,
  engine_version text,
  database_generation text,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_results_attachment ON scan_results(attachment_id, created_at);
