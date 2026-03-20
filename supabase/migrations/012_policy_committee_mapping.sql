-- ============================================================================
-- Policy To Committee Mapping — Schema and Committee-Key Backfill Support
-- ============================================================================

ALTER TABLE member_committee_assignments
  ADD COLUMN IF NOT EXISTS committee_key TEXT;
CREATE TABLE committees (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL UNIQUE,
  committee_code TEXT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  chamber TEXT,
  is_subcommittee BOOLEAN NOT NULL DEFAULT false,
  parent_committee_id BIGINT REFERENCES committees(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_aliases (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL REFERENCES committees(committee_key) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_match_review_queue (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_value TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  chamber TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_jurisdiction_seeds (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL REFERENCES committees(committee_key) ON DELETE CASCADE,
  committee_id BIGINT REFERENCES committees(id) ON DELETE SET NULL,
  congress INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  jurisdiction_text TEXT NOT NULL,
  jurisdiction_summary TEXT,
  effective_start_date DATE,
  effective_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (committee_key, congress, source_version)
);

CREATE INDEX IF NOT EXISTS idx_member_committee_assignments_committee_key
  ON member_committee_assignments(committee_key);

CREATE TABLE policy_area_committee_map (
  id BIGSERIAL PRIMARY KEY,
  policy_area TEXT NOT NULL,
  subject_term TEXT,
  committee_id BIGINT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  confidence NUMERIC(4,3) NOT NULL,
  source TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  bill_count INTEGER NOT NULL DEFAULT 0,
  first_seen_congress INTEGER,
  last_seen_congress INTEGER,
  last_seen_at TIMESTAMPTZ,
  is_manual_override BOOLEAN NOT NULL DEFAULT false,
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_area_committee_evidence (
  id BIGSERIAL PRIMARY KEY,
  map_id BIGINT NOT NULL REFERENCES policy_area_committee_map(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_url TEXT,
  weight NUMERIC(4,3),
  note TEXT,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (map_id, evidence_type, source_table, source_row_id)
);

CREATE TABLE policy_area_committee_overrides (
  id BIGSERIAL PRIMARY KEY,
  policy_area TEXT NOT NULL,
  subject_term TEXT,
  committee_id BIGINT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  override_action TEXT NOT NULL,
  confidence_delta NUMERIC(4,3),
  reason TEXT,
  source TEXT NOT NULL,
  created_by TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_start_date DATE,
  effective_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_area_committee_map_null_subject
  ON policy_area_committee_map (policy_area, committee_id)
  WHERE subject_term IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_area_committee_map_with_subject
  ON policy_area_committee_map (policy_area, subject_term, committee_id)
  WHERE subject_term IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_area_committee_overrides_null_subject
  ON policy_area_committee_overrides (policy_area, committee_id)
  WHERE subject_term IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_area_committee_overrides_with_subject
  ON policy_area_committee_overrides (policy_area, subject_term, committee_id)
  WHERE subject_term IS NOT NULL;

ALTER TABLE committees ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_match_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_jurisdiction_seeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_area_committee_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_area_committee_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_area_committee_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service write" ON committees FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON committee_aliases FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON committee_match_review_queue FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON committee_jurisdiction_seeds FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON policy_area_committee_map FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON policy_area_committee_evidence FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON policy_area_committee_overrides FOR ALL USING (true) WITH CHECK (true);
