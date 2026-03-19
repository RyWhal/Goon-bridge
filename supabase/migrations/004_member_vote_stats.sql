-- ============================================================================
-- Congressional Vibe Check — Member Vote Stats
-- ============================================================================

CREATE TABLE member_vote_stats (
  bioguide_id TEXT PRIMARY KEY REFERENCES members(bioguide_id) ON DELETE CASCADE,
  total_votes INTEGER NOT NULL DEFAULT 0,
  yea_votes INTEGER NOT NULL DEFAULT 0,
  nay_votes INTEGER NOT NULL DEFAULT 0,
  present_votes INTEGER NOT NULL DEFAULT 0,
  not_voting_votes INTEGER NOT NULL DEFAULT 0,
  unknown_votes INTEGER NOT NULL DEFAULT 0,
  attended_votes INTEGER NOT NULL DEFAULT 0,
  attendance_rate NUMERIC(6,5) NOT NULL DEFAULT 0,
  house_votes INTEGER NOT NULL DEFAULT 0,
  senate_votes INTEGER NOT NULL DEFAULT 0,
  first_vote_date DATE,
  last_vote_date DATE,
  first_congress INTEGER,
  last_congress INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_vote_stats_last_vote_date ON member_vote_stats(last_vote_date DESC);
CREATE INDEX idx_member_vote_stats_total_votes ON member_vote_stats(total_votes DESC);

ALTER TABLE member_vote_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON member_vote_stats FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON member_vote_stats FOR ALL USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION refresh_member_vote_stats(target_bioguide_ids TEXT[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  refreshed_count INTEGER := 0;
BEGIN
  IF target_bioguide_ids IS NULL OR array_length(target_bioguide_ids, 1) IS NULL THEN
    DELETE FROM member_vote_stats;

    INSERT INTO member_vote_stats (
      bioguide_id,
      total_votes,
      yea_votes,
      nay_votes,
      present_votes,
      not_voting_votes,
      unknown_votes,
      attended_votes,
      attendance_rate,
      house_votes,
      senate_votes,
      first_vote_date,
      last_vote_date,
      first_congress,
      last_congress,
      updated_at
    )
    SELECT
      mv.bioguide_id,
      COUNT(*)::INTEGER AS total_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes'))::INTEGER AS yea_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) IN ('nay', 'no'))::INTEGER AS nay_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) = 'present')::INTEGER AS present_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) IN ('not voting', 'not present', 'absent', 'no vote')
      )::INTEGER AS not_voting_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) NOT IN (
          'yea', 'aye', 'yes', 'nay', 'no', 'present', 'not voting', 'not present', 'absent', 'no vote'
        )
      )::INTEGER AS unknown_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes', 'nay', 'no', 'present')
      )::INTEGER AS attended_votes,
      COALESCE(
        (
          COUNT(*) FILTER (
            WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes', 'nay', 'no', 'present')
          )::NUMERIC / NULLIF(COUNT(*), 0)::NUMERIC
        ),
        0
      ) AS attendance_rate,
      COUNT(*) FILTER (WHERE lower(v.chamber) = 'house')::INTEGER AS house_votes,
      COUNT(*) FILTER (WHERE lower(v.chamber) = 'senate')::INTEGER AS senate_votes,
      MIN(v.date) AS first_vote_date,
      MAX(v.date) AS last_vote_date,
      MIN(v.congress) AS first_congress,
      MAX(v.congress) AS last_congress,
      now() AS updated_at
    FROM member_votes mv
    JOIN votes v ON v.id = mv.vote_id
    GROUP BY mv.bioguide_id;
  ELSE
    DELETE FROM member_vote_stats
    WHERE bioguide_id = ANY(target_bioguide_ids);

    INSERT INTO member_vote_stats (
      bioguide_id,
      total_votes,
      yea_votes,
      nay_votes,
      present_votes,
      not_voting_votes,
      unknown_votes,
      attended_votes,
      attendance_rate,
      house_votes,
      senate_votes,
      first_vote_date,
      last_vote_date,
      first_congress,
      last_congress,
      updated_at
    )
    SELECT
      mv.bioguide_id,
      COUNT(*)::INTEGER AS total_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes'))::INTEGER AS yea_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) IN ('nay', 'no'))::INTEGER AS nay_votes,
      COUNT(*) FILTER (WHERE lower(trim(mv.position)) = 'present')::INTEGER AS present_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) IN ('not voting', 'not present', 'absent', 'no vote')
      )::INTEGER AS not_voting_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) NOT IN (
          'yea', 'aye', 'yes', 'nay', 'no', 'present', 'not voting', 'not present', 'absent', 'no vote'
        )
      )::INTEGER AS unknown_votes,
      COUNT(*) FILTER (
        WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes', 'nay', 'no', 'present')
      )::INTEGER AS attended_votes,
      COALESCE(
        (
          COUNT(*) FILTER (
            WHERE lower(trim(mv.position)) IN ('yea', 'aye', 'yes', 'nay', 'no', 'present')
          )::NUMERIC / NULLIF(COUNT(*), 0)::NUMERIC
        ),
        0
      ) AS attendance_rate,
      COUNT(*) FILTER (WHERE lower(v.chamber) = 'house')::INTEGER AS house_votes,
      COUNT(*) FILTER (WHERE lower(v.chamber) = 'senate')::INTEGER AS senate_votes,
      MIN(v.date) AS first_vote_date,
      MAX(v.date) AS last_vote_date,
      MIN(v.congress) AS first_congress,
      MAX(v.congress) AS last_congress,
      now() AS updated_at
    FROM member_votes mv
    JOIN votes v ON v.id = mv.vote_id
    WHERE mv.bioguide_id = ANY(target_bioguide_ids)
    GROUP BY mv.bioguide_id;
  END IF;

  GET DIAGNOSTICS refreshed_count = ROW_COUNT;
  RETURN refreshed_count;
END;
$$;

DROP VIEW IF EXISTS member_voting_record;

CREATE VIEW member_voting_record
WITH (security_invoker = true) AS
SELECT
  mv.bioguide_id,
  m.name AS member_name,
  m.party,
  m.state,
  v.id AS vote_id,
  v.congress,
  v.chamber,
  v.roll_call_number,
  v.date AS vote_date,
  v.question,
  v.description AS vote_description,
  v.result,
  v.bill_congress,
  v.bill_type,
  v.bill_number,
  b.title AS bill_title,
  b.policy_area,
  mv.position,
  CASE
    WHEN lower(trim(mv.position)) IN ('yea', 'aye', 'yes') THEN 'yea'
    WHEN lower(trim(mv.position)) IN ('nay', 'no') THEN 'nay'
    WHEN lower(trim(mv.position)) = 'present' THEN 'present'
    WHEN lower(trim(mv.position)) IN ('not voting', 'not present', 'absent', 'no vote') THEN 'not-voting'
    ELSE 'unknown'
  END AS normalized_position
FROM member_votes mv
JOIN members m ON m.bioguide_id = mv.bioguide_id
JOIN votes v ON v.id = mv.vote_id
LEFT JOIN bills b
  ON b.congress = v.bill_congress
 AND b.bill_type = v.bill_type
 AND b.bill_number = v.bill_number;

SELECT refresh_member_vote_stats(NULL);
