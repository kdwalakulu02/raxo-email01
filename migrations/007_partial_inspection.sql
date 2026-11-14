-- Rust-only extension: file-type policy withholding and partial scanner inspection.
-- Additive; widens the withheld category check and records why an inspection was incomplete.
ALTER TABLE attachments DROP CONSTRAINT attachments_withheld_category_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_withheld_category_check
  CHECK (withheld_category IS NULL OR withheld_category IN ('flagged','not_inspected','policy'));

ALTER TABLE scan_results ADD COLUMN incomplete text;
