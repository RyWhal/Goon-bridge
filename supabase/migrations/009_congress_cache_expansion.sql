-- Congress cache expansion
-- Adds per-congress member cache rows and durable payload caches for
-- member detail and bill detail subresources.

CREATE TABLE IF NOT EXISTS member_congresses (
  bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  congress INTEGER NOT NULL,
  name TEXT NOT NULL,
  party TEXT,
  state TEXT,
  district INTEGER,
  chamber TEXT,
  image_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bioguide_id, congress)
);

CREATE INDEX IF NOT EXISTS idx_member_congresses_congress
  ON member_congresses(congress);

CREATE INDEX IF NOT EXISTS idx_member_congresses_name_trgm
  ON member_congresses USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_member_congresses_party
  ON member_congresses(party);

CREATE INDEX IF NOT EXISTS idx_member_congresses_state
  ON member_congresses(state);

CREATE TABLE IF NOT EXISTS member_details_cache (
  bioguide_id TEXT PRIMARY KEY REFERENCES members(bioguide_id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bill_details_cache (
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL,
  bill_number INTEGER NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (congress, bill_type, bill_number)
);

CREATE TABLE IF NOT EXISTS bill_actions_cache (
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL,
  bill_number INTEGER NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (congress, bill_type, bill_number)
);

CREATE TABLE IF NOT EXISTS bill_cosponsors_cache (
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL,
  bill_number INTEGER NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (congress, bill_type, bill_number)
);

ALTER TABLE member_congresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_details_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_details_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_actions_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_cosponsors_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON member_congresses
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON member_congresses
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read" ON member_details_cache
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON member_details_cache
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read" ON bill_details_cache
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON bill_details_cache
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read" ON bill_actions_cache
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON bill_actions_cache
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read" ON bill_cosponsors_cache
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON bill_cosponsors_cache
  FOR ALL USING (true) WITH CHECK (true);
