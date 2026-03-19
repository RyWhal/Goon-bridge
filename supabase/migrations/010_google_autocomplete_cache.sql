CREATE TABLE IF NOT EXISTS google_autocomplete_cache (
  bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  probe_key TEXT NOT NULL,
  query TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bioguide_id, probe_key)
);

CREATE INDEX IF NOT EXISTS idx_google_autocomplete_cache_updated_at
  ON google_autocomplete_cache(updated_at DESC);

ALTER TABLE google_autocomplete_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON google_autocomplete_cache
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON google_autocomplete_cache
  FOR ALL USING (true) WITH CHECK (true);
