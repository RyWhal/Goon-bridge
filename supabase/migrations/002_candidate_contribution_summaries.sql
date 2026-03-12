-- Candidate contribution summary cache
CREATE TABLE IF NOT EXISTS candidate_contribution_summaries (
  candidate_id TEXT NOT NULL REFERENCES fec_candidates(candidate_id),
  two_year_period INTEGER NOT NULL,
  committee_id TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (candidate_id, two_year_period)
);

CREATE INDEX IF NOT EXISTS idx_candidate_contribution_summaries_updated_at
  ON candidate_contribution_summaries(updated_at DESC);

ALTER TABLE candidate_contribution_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON candidate_contribution_summaries
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON candidate_contribution_summaries
  FOR ALL USING (true) WITH CHECK (true);
