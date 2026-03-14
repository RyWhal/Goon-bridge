-- ============================================================================
-- Congressional Vibe Check — Phase 2 Public Disclosure Ingestion
-- ============================================================================

CREATE TABLE disclosure_filings (
  id BIGSERIAL PRIMARY KEY,
  chamber TEXT NOT NULL,
  source_type TEXT NOT NULL,
  filing_identifier TEXT NOT NULL UNIQUE,
  source_row_key TEXT NOT NULL UNIQUE,
  filing_type TEXT,
  member_name TEXT,
  member_first_name TEXT,
  member_last_name TEXT,
  member_state TEXT,
  member_bioguide_id TEXT REFERENCES members(bioguide_id) ON DELETE SET NULL,
  candidate_state TEXT,
  document_url TEXT,
  archive_url TEXT,
  filed_date DATE,
  disclosure_date DATE,
  filing_status TEXT NOT NULL DEFAULT 'discovered',
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  parse_status TEXT NOT NULL DEFAULT 'pending',
  checksum_sha256 TEXT,
  quarantine_reason TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disclosure_filings_chamber ON disclosure_filings(chamber);
CREATE INDEX idx_disclosure_filings_source_type ON disclosure_filings(source_type);
CREATE INDEX idx_disclosure_filings_bioguide ON disclosure_filings(member_bioguide_id);
CREATE INDEX idx_disclosure_filings_filed_date ON disclosure_filings(filed_date DESC);
CREATE INDEX idx_disclosure_filings_parse_status ON disclosure_filings(parse_status);

CREATE TABLE disclosure_filing_text (
  id BIGSERIAL PRIMARY KEY,
  filing_id BIGINT NOT NULL REFERENCES disclosure_filings(id) ON DELETE CASCADE,
  parser_version TEXT NOT NULL,
  extraction_method TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extracted_text TEXT,
  parse_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(filing_id, parser_version)
);

CREATE INDEX idx_disclosure_filing_text_filing ON disclosure_filing_text(filing_id);
CREATE INDEX idx_disclosure_filing_text_status ON disclosure_filing_text(extraction_status);

CREATE TABLE disclosure_trade_rows (
  id BIGSERIAL PRIMARY KEY,
  filing_id BIGINT NOT NULL REFERENCES disclosure_filings(id) ON DELETE CASCADE,
  source_row_key TEXT NOT NULL UNIQUE,
  row_ordinal INTEGER NOT NULL,
  owner_label TEXT,
  owner_type TEXT,
  asset_name TEXT,
  normalized_asset_name TEXT,
  asset_type TEXT,
  symbol_guess TEXT,
  transaction_type TEXT,
  transaction_date DATE,
  notification_date DATE,
  amount_range TEXT,
  is_public_equity BOOLEAN NOT NULL DEFAULT false,
  parse_confidence TEXT,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  member_bioguide_id TEXT REFERENCES members(bioguide_id) ON DELETE SET NULL,
  quarantine_reason TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disclosure_trade_rows_filing ON disclosure_trade_rows(filing_id);
CREATE INDEX idx_disclosure_trade_rows_bioguide ON disclosure_trade_rows(member_bioguide_id);
CREATE INDEX idx_disclosure_trade_rows_org ON disclosure_trade_rows(organization_id);
CREATE INDEX idx_disclosure_trade_rows_tx_date ON disclosure_trade_rows(transaction_date DESC);
CREATE INDEX idx_disclosure_trade_rows_equity ON disclosure_trade_rows(is_public_equity);

CREATE TABLE disclosure_ingest_failures (
  id BIGSERIAL PRIMARY KEY,
  filing_id BIGINT REFERENCES disclosure_filings(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT NOT NULL,
  retryable BOOLEAN NOT NULL DEFAULT true,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disclosure_failures_filing ON disclosure_ingest_failures(filing_id);
CREATE INDEX idx_disclosure_failures_stage ON disclosure_ingest_failures(stage);
CREATE INDEX idx_disclosure_failures_retryable ON disclosure_ingest_failures(retryable);

ALTER TABLE member_stock_trades
  ADD COLUMN disclosure_filing_id BIGINT REFERENCES disclosure_filings(id) ON DELETE SET NULL,
  ADD COLUMN owner_label TEXT,
  ADD COLUMN owner_type TEXT,
  ADD COLUMN asset_type TEXT,
  ADD COLUMN parse_confidence TEXT;

CREATE INDEX idx_member_stock_trades_filing_id ON member_stock_trades(disclosure_filing_id);

ALTER TABLE disclosure_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_filing_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_trade_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_ingest_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON disclosure_filings FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON disclosure_filing_text FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON disclosure_trade_rows FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON disclosure_ingest_failures FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON disclosure_filings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON disclosure_filing_text FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON disclosure_trade_rows FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON disclosure_ingest_failures FOR ALL USING (true) WITH CHECK (true);
