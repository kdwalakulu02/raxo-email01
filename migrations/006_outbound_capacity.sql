ALTER TABLE submissions
  ADD COLUMN kind text NOT NULL DEFAULT 'form' CHECK (kind IN ('form', 'system'));

ALTER TABLE notifications ADD COLUMN not_after timestamptz;

ALTER TABLE send_attempts
  ADD COLUMN node_id text,
  ADD COLUMN recipient_key text,
  ADD COLUMN destination_domain text;

UPDATE send_attempts a
SET recipient_key = lower(s.config_snapshot->>'recipient'),
    destination_domain = split_part(lower(s.config_snapshot->>'recipient'), '@', 2)
FROM notifications n JOIN submissions s ON s.id = n.submission_id
WHERE a.notification_id = n.id AND s.config_snapshot->>'recipient' IS NOT NULL;

CREATE TABLE smtp_capacity_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_recipient_per_minute integer NOT NULL CHECK (default_recipient_per_minute BETWEEN 1 AND 100000)
);
INSERT INTO smtp_capacity_settings (singleton, default_recipient_per_minute) VALUES (true, 15);

CREATE TABLE smtp_nodes (
  node_id text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'unspecified',
  messages_per_minute integer NOT NULL DEFAULT 15 CHECK (messages_per_minute BETWEEN 1 AND 100000),
  max_connections integer NOT NULL DEFAULT 3 CHECK (max_connections BETWEEN 1 AND 64),
  lock_identity uuid,
  lock_device bigint,
  lock_inode bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE smtp_fair_sequence;
CREATE TABLE smtp_recipient_capacity (
  recipient_key text PRIMARY KEY,
  messages_per_minute integer CHECK (messages_per_minute BETWEEN 1 AND 100000),
  last_selected bigint NOT NULL DEFAULT 0
);

CREATE TABLE smtp_destination_backoff (
  node_id text NOT NULL REFERENCES smtp_nodes(node_id),
  destination_domain text NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  not_before timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, destination_domain)
);

CREATE INDEX send_attempts_node_active ON send_attempts(node_id) WHERE finished_at IS NULL;
CREATE INDEX send_attempts_node_finished ON send_attempts(node_id, finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX send_attempts_recipient_active ON send_attempts(recipient_key) WHERE finished_at IS NULL;
CREATE INDEX send_attempts_recipient_finished ON send_attempts(recipient_key, finished_at) WHERE finished_at IS NOT NULL;
