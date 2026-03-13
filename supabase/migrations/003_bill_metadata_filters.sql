ALTER TABLE bills
ADD COLUMN IF NOT EXISTS origin_chamber TEXT,
ADD COLUMN IF NOT EXISTS update_date DATE,
ADD COLUMN IF NOT EXISTS introduced_date DATE,
ADD COLUMN IF NOT EXISTS sponsor_bioguide_id TEXT,
ADD COLUMN IF NOT EXISTS sponsor_name TEXT,
ADD COLUMN IF NOT EXISTS sponsor_party TEXT,
ADD COLUMN IF NOT EXISTS sponsor_state TEXT,
ADD COLUMN IF NOT EXISTS committee_names TEXT[],
ADD COLUMN IF NOT EXISTS bill_status TEXT,
ADD COLUMN IF NOT EXISTS bill_status_label TEXT,
ADD COLUMN IF NOT EXISTS bill_status_step INTEGER;

CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(congress, bill_status);
CREATE INDEX IF NOT EXISTS idx_bills_sponsor_party ON bills(congress, sponsor_party);
