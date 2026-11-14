-- Rust-only extension: uploads to forms that are not verified yet are discarded at submission time.
-- Additive; widens the withheld category check.
ALTER TABLE attachments DROP CONSTRAINT attachments_withheld_category_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_withheld_category_check
  CHECK (withheld_category IS NULL OR withheld_category IN ('flagged','not_inspected','policy','not_retained'));
