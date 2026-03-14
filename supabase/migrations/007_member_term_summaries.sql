-- ============================================================================
-- Congressional Vibe Check — Cached member term summaries
-- ============================================================================

ALTER TABLE members
ADD COLUMN first_congress INTEGER,
ADD COLUMN last_congress INTEGER,
ADD COLUMN total_terms INTEGER,
ADD COLUMN congresses_served INTEGER,
ADD COLUMN years_served INTEGER;
