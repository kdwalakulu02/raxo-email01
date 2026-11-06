-- Rust-only extension: per-attachment delivery disposition (withhold policy).
-- Additive; the Node application ignores these columns and constraint widening.
ALTER TABLE attachments
  ADD COLUMN delivery_disposition text NOT NULL DEFAULT 'pending'
    CHECK (delivery_disposition IN ('pending','included','withheld','delivered')),
  ADD COLUMN withheld_category text
    CHECK (withheld_category IS NULL OR withheld_category IN ('flagged','not_inspected')),
  ADD COLUMN disposition_reason text,
  ADD COLUMN disposition_at timestamptz,
  ADD CONSTRAINT attachments_withheld_has_category
    CHECK (delivery_disposition <> 'withheld' OR withheld_category IS NOT NULL);

ALTER TABLE scan_results DROP CONSTRAINT scan_results_verdict_check;
ALTER TABLE scan_results ADD CONSTRAINT scan_results_verdict_check
  CHECK (verdict IN ('CLEAN','DETECTED','SUSPICIOUS','ERROR','UNSCANNED','BUSY','TIMEOUT'));

CREATE INDEX attachments_disposition ON attachments(submission_id, delivery_disposition);
