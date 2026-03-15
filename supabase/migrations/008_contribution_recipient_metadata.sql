ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS normalized_recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS pdf_url TEXT;

UPDATE contributions
SET recipient_name = committee_name
WHERE recipient_name IS NULL
  AND committee_name IS NOT NULL;

UPDATE contributions
SET normalized_recipient_name = trim(
  regexp_replace(
    upper(replace(recipient_name, '&', ' AND ')),
    '[^A-Z0-9 ]+',
    ' ',
    'g'
  )
)
WHERE normalized_recipient_name IS NULL
  AND recipient_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contributions_recipient_name_trgm
  ON contributions USING gin (recipient_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contributions_normalized_recipient_name_trgm
  ON contributions USING gin (normalized_recipient_name gin_trgm_ops);
