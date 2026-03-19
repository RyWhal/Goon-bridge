ALTER TABLE disclosure_filings
  ADD COLUMN member_resolution_confidence TEXT,
  ADD COLUMN member_resolution_score INTEGER,
  ADD COLUMN member_resolution_reason TEXT;

ALTER TABLE disclosure_trade_rows
  ADD COLUMN member_resolution_confidence TEXT,
  ADD COLUMN member_resolution_score INTEGER,
  ADD COLUMN member_resolution_reason TEXT;

CREATE INDEX idx_disclosure_filings_resolution_confidence
  ON disclosure_filings(member_resolution_confidence);

CREATE INDEX idx_disclosure_trade_rows_resolution_confidence
  ON disclosure_trade_rows(member_resolution_confidence);
