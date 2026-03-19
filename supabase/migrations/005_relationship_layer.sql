-- ============================================================================
-- Congressional Vibe Check — Phase 2 Relationship Layer
-- ============================================================================

CREATE TABLE organizations (
  id BIGSERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  ticker TEXT,
  parent_organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  source_coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organizations_ticker ON organizations(ticker);

CREATE TABLE organization_aliases (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,
  source_row_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, normalized_alias)
);

CREATE INDEX idx_organization_aliases_org_id ON organization_aliases(organization_id);

CREATE TABLE organization_identifiers (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_type, identifier_type, identifier_value)
);

CREATE INDEX idx_organization_identifiers_org_id ON organization_identifiers(organization_id);

CREATE TABLE organization_lobbying_filings (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  ticker TEXT,
  symbol TEXT,
  filing_uuid TEXT,
  source_row_key TEXT NOT NULL UNIQUE,
  name TEXT,
  normalized_name TEXT,
  description TEXT,
  country TEXT,
  year INTEGER,
  period TEXT,
  filing_type TEXT,
  document_url TEXT,
  income NUMERIC(14,2),
  expenses NUMERIC(14,2),
  posted_name TEXT,
  dt_posted DATE,
  client_id TEXT,
  registrant_id TEXT,
  senate_id TEXT,
  house_registrant_id TEXT,
  chambers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organization_lobbying_org_id ON organization_lobbying_filings(organization_id);
CREATE INDEX idx_organization_lobbying_symbol ON organization_lobbying_filings(symbol);
CREATE INDEX idx_organization_lobbying_dt_posted ON organization_lobbying_filings(dt_posted DESC);

CREATE TABLE organization_contract_awards (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  ticker TEXT,
  symbol TEXT,
  source_row_key TEXT NOT NULL UNIQUE,
  recipient_name TEXT,
  recipient_parent_name TEXT,
  normalized_recipient_name TEXT,
  normalized_parent_name TEXT,
  country TEXT,
  total_value NUMERIC(16,2),
  action_date DATE,
  performance_start_date DATE,
  performance_end_date DATE,
  awarding_agency_name TEXT,
  awarding_sub_agency_name TEXT,
  awarding_office_name TEXT,
  performance_country TEXT,
  performance_city TEXT,
  performance_county TEXT,
  performance_state TEXT,
  performance_zip_code TEXT,
  performance_congressional_district TEXT,
  award_description TEXT,
  naics_code TEXT,
  permalink TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organization_contracts_org_id ON organization_contract_awards(organization_id);
CREATE INDEX idx_organization_contracts_symbol ON organization_contract_awards(symbol);
CREATE INDEX idx_organization_contracts_action_date ON organization_contract_awards(action_date DESC);

CREATE TABLE member_committee_assignments (
  id BIGSERIAL PRIMARY KEY,
  bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  committee_code TEXT,
  committee_name TEXT NOT NULL,
  normalized_committee_name TEXT NOT NULL,
  chamber TEXT,
  congress INTEGER,
  role TEXT,
  source_row_key TEXT NOT NULL UNIQUE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_committee_assignments_bioguide ON member_committee_assignments(bioguide_id);
CREATE INDEX idx_member_committee_assignments_name ON member_committee_assignments(normalized_committee_name);

CREATE TABLE member_subcommittee_assignments (
  id BIGSERIAL PRIMARY KEY,
  bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  committee_assignment_id BIGINT REFERENCES member_committee_assignments(id) ON DELETE CASCADE,
  parent_committee_code TEXT,
  parent_committee_name TEXT,
  subcommittee_code TEXT,
  subcommittee_name TEXT NOT NULL,
  normalized_subcommittee_name TEXT NOT NULL,
  chamber TEXT,
  congress INTEGER,
  role TEXT,
  source_row_key TEXT NOT NULL UNIQUE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_subcommittee_assignments_bioguide ON member_subcommittee_assignments(bioguide_id);
CREATE INDEX idx_member_subcommittee_assignments_name ON member_subcommittee_assignments(normalized_subcommittee_name);

CREATE TABLE member_stock_trades (
  id BIGSERIAL PRIMARY KEY,
  bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_row_key TEXT NOT NULL UNIQUE,
  symbol TEXT,
  asset_name TEXT,
  normalized_asset_name TEXT,
  transaction_date DATE,
  disclosure_date DATE,
  transaction_type TEXT,
  amount_range TEXT,
  share_count NUMERIC(18,4),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_stock_trades_bioguide ON member_stock_trades(bioguide_id);
CREATE INDEX idx_member_stock_trades_org_id ON member_stock_trades(organization_id);

CREATE TABLE relationship_facts (
  id BIGSERIAL PRIMARY KEY,
  member_bioguide_id TEXT REFERENCES members(bioguide_id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id TEXT,
  fact_date DATE,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_relationship_facts_member ON relationship_facts(member_bioguide_id);
CREATE INDEX idx_relationship_facts_org ON relationship_facts(organization_id);
CREATE INDEX idx_relationship_facts_type ON relationship_facts(fact_type);
CREATE INDEX idx_relationship_facts_date ON relationship_facts(fact_date DESC);
CREATE UNIQUE INDEX idx_relationship_facts_unique
  ON relationship_facts (
    fact_type,
    COALESCE(member_bioguide_id, ''),
    COALESCE(organization_id, -1),
    source_table,
    source_row_id,
    COALESCE(related_entity_type, ''),
    COALESCE(related_entity_id, '')
  );

CREATE TABLE correlation_cases (
  id BIGSERIAL PRIMARY KEY,
  member_bioguide_id TEXT NOT NULL REFERENCES members(bioguide_id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  case_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_date DATE,
  time_window_days INTEGER,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_correlation_cases_member ON correlation_cases(member_bioguide_id);
CREATE INDEX idx_correlation_cases_org ON correlation_cases(organization_id);
CREATE INDEX idx_correlation_cases_event_date ON correlation_cases(event_date DESC);
CREATE UNIQUE INDEX idx_correlation_cases_unique
  ON correlation_cases (
    member_bioguide_id,
    COALESCE(organization_id, -1),
    case_type,
    COALESCE(event_date, DATE '0001-01-01'),
    summary
  );

CREATE OR REPLACE VIEW member_correlation_cases
WITH (security_invoker = true) AS
SELECT
  cc.id,
  cc.member_bioguide_id,
  m.name AS member_name,
  cc.organization_id,
  o.canonical_name AS organization_name,
  o.ticker AS organization_ticker,
  cc.case_type,
  cc.summary,
  cc.event_date,
  cc.time_window_days,
  cc.status,
  cc.evidence_payload,
  cc.updated_at
FROM correlation_cases cc
JOIN members m ON m.bioguide_id = cc.member_bioguide_id
LEFT JOIN organizations o ON o.id = cc.organization_id;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_lobbying_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_contract_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_committee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_subcommittee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_stock_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE correlation_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON organizations FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON organization_aliases FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON organization_identifiers FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON organization_lobbying_filings FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON organization_contract_awards FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON member_committee_assignments FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON member_subcommittee_assignments FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON member_stock_trades FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON relationship_facts FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON correlation_cases FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON organizations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON organization_aliases FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON organization_identifiers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON organization_lobbying_filings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON organization_contract_awards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON member_committee_assignments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON member_subcommittee_assignments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON member_stock_trades FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON relationship_facts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON correlation_cases FOR ALL USING (true) WITH CHECK (true);
