-- ============================================================================
-- Congressional Vibe Check — Initial Schema
-- ============================================================================
-- Run this in the Supabase SQL Editor to create all tables.
-- ============================================================================

-- 1. Members of Congress (source: Congress.gov)
CREATE TABLE members (
  bioguide_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direct_order_name TEXT,
  party TEXT,
  state TEXT,
  district INTEGER,            -- NULL for senators
  chamber TEXT,                -- 'House' or 'Senate' (most recent)
  image_url TEXT,
  congress INTEGER,            -- congress session they were fetched from
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_members_state ON members(state);
CREATE INDEX idx_members_party ON members(party);
CREATE INDEX idx_members_name_trgm ON members USING gin (name gin_trgm_ops);

-- Enable trigram extension for fuzzy name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Roll call votes (source: Congress.gov)
CREATE TABLE votes (
  id BIGSERIAL PRIMARY KEY,
  congress INTEGER NOT NULL,
  chamber TEXT NOT NULL,        -- 'house' or 'senate'
  roll_call_number INTEGER NOT NULL,
  date DATE,
  question TEXT,
  description TEXT,
  result TEXT,
  total_yea INTEGER,
  total_nay INTEGER,
  total_not_voting INTEGER,
  bill_congress INTEGER,
  bill_type TEXT,
  bill_number INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(congress, chamber, roll_call_number)
);
CREATE INDEX idx_votes_date ON votes(date);
CREATE INDEX idx_votes_congress ON votes(congress);

-- 3. How each member voted on each roll call
CREATE TABLE member_votes (
  id BIGSERIAL PRIMARY KEY,
  vote_id BIGINT REFERENCES votes(id) ON DELETE CASCADE,
  bioguide_id TEXT REFERENCES members(bioguide_id),
  position TEXT NOT NULL,      -- 'Yea', 'Nay', 'Not Voting', 'Present'
  UNIQUE(vote_id, bioguide_id)
);
CREATE INDEX idx_member_votes_bioguide ON member_votes(bioguide_id);

-- 4. Bills / legislation (source: Congress.gov)
CREATE TABLE bills (
  id BIGSERIAL PRIMARY KEY,
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL,     -- 'hr', 's', 'hjres', 'sjres', etc.
  bill_number INTEGER NOT NULL,
  title TEXT,
  policy_area TEXT,
  latest_action_text TEXT,
  latest_action_date DATE,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(congress, bill_type, bill_number)
);
CREATE INDEX idx_bills_congress ON bills(congress);

-- 5. FEC candidate mapping (the bridge between Congress.gov and OpenFEC)
CREATE TABLE fec_candidates (
  candidate_id TEXT PRIMARY KEY,  -- FEC ID like 'H0TX22116'
  bioguide_id TEXT REFERENCES members(bioguide_id),
  name TEXT,
  party TEXT,
  state TEXT,
  office TEXT,                    -- 'H', 'S', 'P'
  election_years INTEGER[],
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_fec_candidates_bioguide ON fec_candidates(bioguide_id);

-- 6. Individual contributions / Schedule A (source: OpenFEC)
CREATE TABLE contributions (
  id BIGSERIAL PRIMARY KEY,
  candidate_id TEXT REFERENCES fec_candidates(candidate_id),
  committee_id TEXT,
  committee_name TEXT,
  contributor_name TEXT,
  contributor_employer TEXT,
  contributor_occupation TEXT,
  contributor_state TEXT,
  contribution_amount NUMERIC(12,2),
  contribution_date DATE,
  two_year_period INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_contributions_candidate ON contributions(candidate_id);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_contributions_employer ON contributions(contributor_employer);

-- ============================================================================
-- Row Level Security
-- ============================================================================
-- Allow the Worker (using anon key) to read and write all tables.
-- For production, consider using service_role key for writes instead.

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE fec_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;

-- Read access for everyone (anon)
CREATE POLICY "Allow public read" ON members FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON votes FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON member_votes FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON bills FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON fec_candidates FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON contributions FOR SELECT USING (true);

-- Write access for service role (Worker uses service_role key for ingestion)
CREATE POLICY "Allow service write" ON members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON votes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON member_votes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON bills FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON fec_candidates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON contributions FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- Useful views for the correlation feature
-- ============================================================================

-- Top donors by employer for a given candidate
CREATE OR REPLACE VIEW donor_summary AS
SELECT
  c.candidate_id,
  fc.bioguide_id,
  c.contributor_employer,
  COUNT(*) AS contribution_count,
  SUM(c.contribution_amount) AS total_amount,
  MIN(c.contribution_date) AS first_contribution,
  MAX(c.contribution_date) AS last_contribution
FROM contributions c
JOIN fec_candidates fc ON fc.candidate_id = c.candidate_id
WHERE c.contributor_employer IS NOT NULL
  AND c.contributor_employer != ''
GROUP BY c.candidate_id, fc.bioguide_id, c.contributor_employer;

-- Member voting record with bill info
CREATE OR REPLACE VIEW member_voting_record AS
SELECT
  mv.bioguide_id,
  m.name AS member_name,
  m.party,
  m.state,
  v.congress,
  v.chamber,
  v.roll_call_number,
  v.date AS vote_date,
  v.question,
  v.description AS vote_description,
  v.result,
  mv.position
FROM member_votes mv
JOIN members m ON m.bioguide_id = mv.bioguide_id
JOIN votes v ON v.id = mv.vote_id;
