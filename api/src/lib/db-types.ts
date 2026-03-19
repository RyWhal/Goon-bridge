/**
 * Supabase database types — mirrors the schema in supabase/migrations/*.sql
 *
 * Once the Supabase project is live, these can be auto-generated via:
 *   npx supabase gen types typescript --project-id <id> > api/src/lib/db-types.ts
 */
export interface Database {
  public: {
    Tables: {
      members: {
        Row: MembersRow;
        Insert: MembersInsert;
        Update: Partial<MembersInsert>;
        Relationships: [];
      };
      member_congresses: {
        Row: MemberCongressesRow;
        Insert: MemberCongressesInsert;
        Update: Partial<MemberCongressesInsert>;
        Relationships: [];
      };
      member_details_cache: {
        Row: MemberDetailsCacheRow;
        Insert: MemberDetailsCacheInsert;
        Update: Partial<MemberDetailsCacheInsert>;
        Relationships: [];
      };
      google_autocomplete_cache: {
        Row: GoogleAutocompleteCacheRow;
        Insert: GoogleAutocompleteCacheInsert;
        Update: Partial<GoogleAutocompleteCacheInsert>;
        Relationships: [];
      };
      votes: {
        Row: VotesRow;
        Insert: VotesInsert;
        Update: Partial<VotesInsert>;
        Relationships: [];
      };
      member_votes: {
        Row: MemberVotesRow;
        Insert: MemberVotesInsert;
        Update: Partial<MemberVotesInsert>;
        Relationships: [];
      };
      member_vote_stats: {
        Row: MemberVoteStatsRow;
        Insert: MemberVoteStatsInsert;
        Update: Partial<MemberVoteStatsInsert>;
        Relationships: [];
      };
      bills: {
        Row: BillsRow;
        Insert: BillsInsert;
        Update: Partial<BillsInsert>;
        Relationships: [];
      };
      bill_details_cache: {
        Row: BillPayloadCacheRow;
        Insert: BillPayloadCacheInsert;
        Update: Partial<BillPayloadCacheInsert>;
        Relationships: [];
      };
      bill_actions_cache: {
        Row: BillPayloadCacheRow;
        Insert: BillPayloadCacheInsert;
        Update: Partial<BillPayloadCacheInsert>;
        Relationships: [];
      };
      bill_cosponsors_cache: {
        Row: BillPayloadCacheRow;
        Insert: BillPayloadCacheInsert;
        Update: Partial<BillPayloadCacheInsert>;
        Relationships: [];
      };
      fec_candidates: {
        Row: FecCandidatesRow;
        Insert: FecCandidatesInsert;
        Update: Partial<FecCandidatesInsert>;
        Relationships: [];
      };
      contributions: {
        Row: ContributionsRow;
        Insert: ContributionsInsert;
        Update: Partial<ContributionsInsert>;
        Relationships: [];
      };
      candidate_contribution_summaries: {
        Row: CandidateContributionSummariesRow;
        Insert: CandidateContributionSummariesInsert;
        Update: Partial<CandidateContributionSummariesInsert>;
        Relationships: [];
      };
      organizations: {
        Row: OrganizationsRow;
        Insert: OrganizationsInsert;
        Update: Partial<OrganizationsInsert>;
        Relationships: [];
      };
      organization_aliases: {
        Row: OrganizationAliasesRow;
        Insert: OrganizationAliasesInsert;
        Update: Partial<OrganizationAliasesInsert>;
        Relationships: [];
      };
      organization_identifiers: {
        Row: OrganizationIdentifiersRow;
        Insert: OrganizationIdentifiersInsert;
        Update: Partial<OrganizationIdentifiersInsert>;
        Relationships: [];
      };
      organization_lobbying_filings: {
        Row: OrganizationLobbyingFilingsRow;
        Insert: OrganizationLobbyingFilingsInsert;
        Update: Partial<OrganizationLobbyingFilingsInsert>;
        Relationships: [];
      };
      organization_contract_awards: {
        Row: OrganizationContractAwardsRow;
        Insert: OrganizationContractAwardsInsert;
        Update: Partial<OrganizationContractAwardsInsert>;
        Relationships: [];
      };
      member_committee_assignments: {
        Row: MemberCommitteeAssignmentsRow;
        Insert: MemberCommitteeAssignmentsInsert;
        Update: Partial<MemberCommitteeAssignmentsInsert>;
        Relationships: [];
      };
      member_subcommittee_assignments: {
        Row: MemberSubcommitteeAssignmentsRow;
        Insert: MemberSubcommitteeAssignmentsInsert;
        Update: Partial<MemberSubcommitteeAssignmentsInsert>;
        Relationships: [];
      };
      disclosure_filings: {
        Row: DisclosureFilingsRow;
        Insert: DisclosureFilingsInsert;
        Update: Partial<DisclosureFilingsInsert>;
        Relationships: [];
      };
      disclosure_filing_text: {
        Row: DisclosureFilingTextRow;
        Insert: DisclosureFilingTextInsert;
        Update: Partial<DisclosureFilingTextInsert>;
        Relationships: [];
      };
      disclosure_trade_rows: {
        Row: DisclosureTradeRowsRow;
        Insert: DisclosureTradeRowsInsert;
        Update: Partial<DisclosureTradeRowsInsert>;
        Relationships: [];
      };
      disclosure_ingest_failures: {
        Row: DisclosureIngestFailuresRow;
        Insert: DisclosureIngestFailuresInsert;
        Update: Partial<DisclosureIngestFailuresInsert>;
        Relationships: [];
      };
      member_stock_trades: {
        Row: MemberStockTradesRow;
        Insert: MemberStockTradesInsert;
        Update: Partial<MemberStockTradesInsert>;
        Relationships: [];
      };
      stock_price_history_cache: {
        Row: StockPriceHistoryCacheRow;
        Insert: StockPriceHistoryCacheInsert;
        Update: Partial<StockPriceHistoryCacheInsert>;
        Relationships: [];
      };
      stock_price_quote_cache: {
        Row: StockPriceQuoteCacheRow;
        Insert: StockPriceQuoteCacheInsert;
        Update: Partial<StockPriceQuoteCacheInsert>;
        Relationships: [];
      };
      relationship_facts: {
        Row: RelationshipFactsRow;
        Insert: RelationshipFactsInsert;
        Update: Partial<RelationshipFactsInsert>;
        Relationships: [];
      };
      correlation_cases: {
        Row: CorrelationCasesRow;
        Insert: CorrelationCasesInsert;
        Update: Partial<CorrelationCasesInsert>;
        Relationships: [];
      };
    };
    Views: {
      donor_summary: {
        Row: DonorSummaryRow;
        Relationships: [];
      };
      member_voting_record: {
        Row: MemberVotingRecordRow;
        Relationships: [];
      };
      member_correlation_cases: {
        Row: MemberCorrelationCasesRow;
        Relationships: [];
      };
    };
    Functions: {
      refresh_member_vote_stats: {
        Args: {
          target_bioguide_ids?: string[] | null;
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

interface MembersRow {
  bioguide_id: string;
  name: string;
  direct_order_name: string | null;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string | null;
  image_url: string | null;
  congress: number | null;
  first_congress: number | null;
  last_congress: number | null;
  total_terms: number | null;
  congresses_served: number | null;
  years_served: number | null;
  updated_at: string;
}

interface MembersInsert {
  bioguide_id: string;
  name: string;
  direct_order_name?: string | null;
  party?: string | null;
  state?: string | null;
  district?: number | null;
  chamber?: string | null;
  image_url?: string | null;
  congress?: number | null;
  first_congress?: number | null;
  last_congress?: number | null;
  total_terms?: number | null;
  congresses_served?: number | null;
  years_served?: number | null;
  updated_at?: string;
}

interface MemberCongressesRow {
  bioguide_id: string;
  congress: number;
  name: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string | null;
  image_url: string | null;
  updated_at: string;
}

interface MemberCongressesInsert {
  bioguide_id: string;
  congress: number;
  name: string;
  party?: string | null;
  state?: string | null;
  district?: number | null;
  chamber?: string | null;
  image_url?: string | null;
  updated_at?: string;
}

interface MemberDetailsCacheRow {
  bioguide_id: string;
  payload: unknown;
  updated_at: string;
}

interface MemberDetailsCacheInsert {
  bioguide_id: string;
  payload: unknown;
  updated_at?: string;
}

interface GoogleAutocompleteCacheRow {
  bioguide_id: string;
  probe_key: string;
  query: string;
  payload: unknown;
  updated_at: string;
}

interface GoogleAutocompleteCacheInsert {
  bioguide_id: string;
  probe_key: string;
  query: string;
  payload: unknown;
  updated_at?: string;
}

interface VotesRow {
  id: number;
  congress: number;
  chamber: string;
  roll_call_number: number;
  date: string | null;
  question: string | null;
  description: string | null;
  result: string | null;
  total_yea: number | null;
  total_nay: number | null;
  total_not_voting: number | null;
  bill_congress: number | null;
  bill_type: string | null;
  bill_number: number | null;
  updated_at: string;
}

interface VotesInsert {
  id?: number;
  congress: number;
  chamber: string;
  roll_call_number: number;
  date?: string | null;
  question?: string | null;
  description?: string | null;
  result?: string | null;
  total_yea?: number | null;
  total_nay?: number | null;
  total_not_voting?: number | null;
  bill_congress?: number | null;
  bill_type?: string | null;
  bill_number?: number | null;
  updated_at?: string;
}

interface MemberVotesRow {
  id: number;
  vote_id: number;
  bioguide_id: string;
  position: string;
}

interface MemberVotesInsert {
  id?: number;
  vote_id: number;
  bioguide_id: string;
  position: string;
}

interface MemberVoteStatsRow {
  bioguide_id: string;
  total_votes: number;
  yea_votes: number;
  nay_votes: number;
  present_votes: number;
  not_voting_votes: number;
  unknown_votes: number;
  attended_votes: number;
  attendance_rate: number;
  house_votes: number;
  senate_votes: number;
  first_vote_date: string | null;
  last_vote_date: string | null;
  first_congress: number | null;
  last_congress: number | null;
  updated_at: string;
}

interface MemberVoteStatsInsert {
  bioguide_id: string;
  total_votes?: number;
  yea_votes?: number;
  nay_votes?: number;
  present_votes?: number;
  not_voting_votes?: number;
  unknown_votes?: number;
  attended_votes?: number;
  attendance_rate?: number;
  house_votes?: number;
  senate_votes?: number;
  first_vote_date?: string | null;
  last_vote_date?: string | null;
  first_congress?: number | null;
  last_congress?: number | null;
  updated_at?: string;
}

interface BillsRow {
  id: number;
  congress: number;
  bill_type: string;
  bill_number: number;
  title: string | null;
  policy_area: string | null;
  latest_action_text: string | null;
  latest_action_date: string | null;
  origin_chamber: string | null;
  update_date: string | null;
  introduced_date: string | null;
  sponsor_bioguide_id: string | null;
  sponsor_name: string | null;
  sponsor_party: string | null;
  sponsor_state: string | null;
  committee_names: string[] | null;
  bill_status: string | null;
  bill_status_label: string | null;
  bill_status_step: number | null;
  updated_at: string;
}

interface BillsInsert {
  id?: number;
  congress: number;
  bill_type: string;
  bill_number: number;
  title?: string | null;
  policy_area?: string | null;
  latest_action_text?: string | null;
  latest_action_date?: string | null;
  origin_chamber?: string | null;
  update_date?: string | null;
  introduced_date?: string | null;
  sponsor_bioguide_id?: string | null;
  sponsor_name?: string | null;
  sponsor_party?: string | null;
  sponsor_state?: string | null;
  committee_names?: string[] | null;
  bill_status?: string | null;
  bill_status_label?: string | null;
  bill_status_step?: number | null;
  updated_at?: string;
}

interface BillPayloadCacheRow {
  congress: number;
  bill_type: string;
  bill_number: number;
  payload: unknown;
  updated_at: string;
}

interface BillPayloadCacheInsert {
  congress: number;
  bill_type: string;
  bill_number: number;
  payload: unknown;
  updated_at?: string;
}

interface FecCandidatesRow {
  candidate_id: string;
  bioguide_id: string | null;
  name: string | null;
  party: string | null;
  state: string | null;
  office: string | null;
  election_years: number[] | null;
  updated_at: string;
}

interface FecCandidatesInsert {
  candidate_id: string;
  bioguide_id?: string | null;
  name?: string | null;
  party?: string | null;
  state?: string | null;
  office?: string | null;
  election_years?: number[] | null;
  updated_at?: string;
}

interface ContributionsRow {
  id: number;
  candidate_id: string | null;
  committee_id: string | null;
  committee_name: string | null;
  recipient_name: string | null;
  normalized_recipient_name: string | null;
  pdf_url: string | null;
  contributor_name: string | null;
  contributor_employer: string | null;
  contributor_occupation: string | null;
  contributor_state: string | null;
  contribution_amount: number | null;
  contribution_date: string | null;
  two_year_period: number | null;
  updated_at: string;
}

interface ContributionsInsert {
  id?: number;
  candidate_id?: string | null;
  committee_id?: string | null;
  committee_name?: string | null;
  recipient_name?: string | null;
  normalized_recipient_name?: string | null;
  pdf_url?: string | null;
  contributor_name?: string | null;
  contributor_employer?: string | null;
  contributor_occupation?: string | null;
  contributor_state?: string | null;
  contribution_amount?: number | null;
  contribution_date?: string | null;
  two_year_period?: number | null;
  updated_at?: string;
}

interface CandidateContributionSummariesRow {
  candidate_id: string;
  two_year_period: number;
  committee_id: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
}

interface CandidateContributionSummariesInsert {
  candidate_id: string;
  two_year_period: number;
  committee_id?: string | null;
  payload: Record<string, unknown>;
  updated_at?: string;
}

interface OrganizationsRow {
  id: number;
  canonical_name: string;
  normalized_name: string;
  ticker: string | null;
  parent_organization_id: number | null;
  source_coverage: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface OrganizationsInsert {
  id?: number;
  canonical_name: string;
  normalized_name: string;
  ticker?: string | null;
  parent_organization_id?: number | null;
  source_coverage?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface OrganizationAliasesRow {
  id: number;
  organization_id: number;
  alias: string;
  normalized_alias: string;
  source_type: string;
  source_row_id: string | null;
  created_at: string;
  updated_at: string;
}

interface OrganizationAliasesInsert {
  id?: number;
  organization_id: number;
  alias: string;
  normalized_alias: string;
  source_type: string;
  source_row_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface OrganizationIdentifiersRow {
  id: number;
  organization_id: number;
  source_type: string;
  identifier_type: string;
  identifier_value: string;
  created_at: string;
  updated_at: string;
}

interface OrganizationIdentifiersInsert {
  id?: number;
  organization_id: number;
  source_type: string;
  identifier_type: string;
  identifier_value: string;
  created_at?: string;
  updated_at?: string;
}

interface OrganizationLobbyingFilingsRow {
  id: number;
  organization_id: number | null;
  ticker: string | null;
  symbol: string | null;
  filing_uuid: string | null;
  source_row_key: string;
  name: string | null;
  normalized_name: string | null;
  description: string | null;
  country: string | null;
  year: number | null;
  period: string | null;
  filing_type: string | null;
  document_url: string | null;
  income: number | null;
  expenses: number | null;
  posted_name: string | null;
  dt_posted: string | null;
  client_id: string | null;
  registrant_id: string | null;
  senate_id: string | null;
  house_registrant_id: string | null;
  chambers: string[];
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface OrganizationLobbyingFilingsInsert {
  id?: number;
  organization_id?: number | null;
  ticker?: string | null;
  symbol?: string | null;
  filing_uuid?: string | null;
  source_row_key: string;
  name?: string | null;
  normalized_name?: string | null;
  description?: string | null;
  country?: string | null;
  year?: number | null;
  period?: string | null;
  filing_type?: string | null;
  document_url?: string | null;
  income?: number | null;
  expenses?: number | null;
  posted_name?: string | null;
  dt_posted?: string | null;
  client_id?: string | null;
  registrant_id?: string | null;
  senate_id?: string | null;
  house_registrant_id?: string | null;
  chambers?: string[];
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface OrganizationContractAwardsRow {
  id: number;
  organization_id: number | null;
  ticker: string | null;
  symbol: string | null;
  source_row_key: string;
  recipient_name: string | null;
  recipient_parent_name: string | null;
  normalized_recipient_name: string | null;
  normalized_parent_name: string | null;
  country: string | null;
  total_value: number | null;
  action_date: string | null;
  performance_start_date: string | null;
  performance_end_date: string | null;
  awarding_agency_name: string | null;
  awarding_sub_agency_name: string | null;
  awarding_office_name: string | null;
  performance_country: string | null;
  performance_city: string | null;
  performance_county: string | null;
  performance_state: string | null;
  performance_zip_code: string | null;
  performance_congressional_district: string | null;
  award_description: string | null;
  naics_code: string | null;
  permalink: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface OrganizationContractAwardsInsert {
  id?: number;
  organization_id?: number | null;
  ticker?: string | null;
  symbol?: string | null;
  source_row_key: string;
  recipient_name?: string | null;
  recipient_parent_name?: string | null;
  normalized_recipient_name?: string | null;
  normalized_parent_name?: string | null;
  country?: string | null;
  total_value?: number | null;
  action_date?: string | null;
  performance_start_date?: string | null;
  performance_end_date?: string | null;
  awarding_agency_name?: string | null;
  awarding_sub_agency_name?: string | null;
  awarding_office_name?: string | null;
  performance_country?: string | null;
  performance_city?: string | null;
  performance_county?: string | null;
  performance_state?: string | null;
  performance_zip_code?: string | null;
  performance_congressional_district?: string | null;
  award_description?: string | null;
  naics_code?: string | null;
  permalink?: string | null;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface MemberCommitteeAssignmentsRow {
  id: number;
  bioguide_id: string;
  committee_code: string | null;
  committee_name: string;
  normalized_committee_name: string;
  chamber: string | null;
  congress: number | null;
  role: string | null;
  source_row_key: string;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface MemberCommitteeAssignmentsInsert {
  id?: number;
  bioguide_id: string;
  committee_code?: string | null;
  committee_name: string;
  normalized_committee_name: string;
  chamber?: string | null;
  congress?: number | null;
  role?: string | null;
  source_row_key: string;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface MemberSubcommitteeAssignmentsRow {
  id: number;
  bioguide_id: string;
  committee_assignment_id: number | null;
  parent_committee_code: string | null;
  parent_committee_name: string | null;
  subcommittee_code: string | null;
  subcommittee_name: string;
  normalized_subcommittee_name: string;
  chamber: string | null;
  congress: number | null;
  role: string | null;
  source_row_key: string;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface MemberSubcommitteeAssignmentsInsert {
  id?: number;
  bioguide_id: string;
  committee_assignment_id?: number | null;
  parent_committee_code?: string | null;
  parent_committee_name?: string | null;
  subcommittee_code?: string | null;
  subcommittee_name: string;
  normalized_subcommittee_name: string;
  chamber?: string | null;
  congress?: number | null;
  role?: string | null;
  source_row_key: string;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface DisclosureFilingsRow {
  id: number;
  chamber: string;
  source_type: string;
  filing_identifier: string;
  source_row_key: string;
  filing_type: string | null;
  member_name: string | null;
  member_first_name: string | null;
  member_last_name: string | null;
  member_state: string | null;
  member_bioguide_id: string | null;
  member_resolution_confidence: string | null;
  member_resolution_score: number | null;
  member_resolution_reason: string | null;
  candidate_state: string | null;
  document_url: string | null;
  archive_url: string | null;
  filed_date: string | null;
  disclosure_date: string | null;
  filing_status: string;
  fetch_status: string;
  parse_status: string;
  checksum_sha256: string | null;
  quarantine_reason: string | null;
  raw_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface DisclosureFilingsInsert {
  id?: number;
  chamber: string;
  source_type: string;
  filing_identifier: string;
  source_row_key: string;
  filing_type?: string | null;
  member_name?: string | null;
  member_first_name?: string | null;
  member_last_name?: string | null;
  member_state?: string | null;
  member_bioguide_id?: string | null;
  member_resolution_confidence?: string | null;
  member_resolution_score?: number | null;
  member_resolution_reason?: string | null;
  candidate_state?: string | null;
  document_url?: string | null;
  archive_url?: string | null;
  filed_date?: string | null;
  disclosure_date?: string | null;
  filing_status?: string;
  fetch_status?: string;
  parse_status?: string;
  checksum_sha256?: string | null;
  quarantine_reason?: string | null;
  raw_metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface DisclosureFilingTextRow {
  id: number;
  filing_id: number;
  parser_version: string;
  extraction_method: string | null;
  extraction_status: string;
  extracted_text: string | null;
  parse_diagnostics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface DisclosureFilingTextInsert {
  id?: number;
  filing_id: number;
  parser_version: string;
  extraction_method?: string | null;
  extraction_status?: string;
  extracted_text?: string | null;
  parse_diagnostics?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface DisclosureTradeRowsRow {
  id: number;
  filing_id: number;
  source_row_key: string;
  row_ordinal: number;
  owner_label: string | null;
  owner_type: string | null;
  asset_name: string | null;
  normalized_asset_name: string | null;
  asset_type: string | null;
  symbol_guess: string | null;
  transaction_type: string | null;
  transaction_date: string | null;
  notification_date: string | null;
  amount_range: string | null;
  is_public_equity: boolean;
  parse_confidence: string | null;
  organization_id: number | null;
  member_bioguide_id: string | null;
  member_resolution_confidence: string | null;
  member_resolution_score: number | null;
  member_resolution_reason: string | null;
  quarantine_reason: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface DisclosureTradeRowsInsert {
  id?: number;
  filing_id: number;
  source_row_key: string;
  row_ordinal: number;
  owner_label?: string | null;
  owner_type?: string | null;
  asset_name?: string | null;
  normalized_asset_name?: string | null;
  asset_type?: string | null;
  symbol_guess?: string | null;
  transaction_type?: string | null;
  transaction_date?: string | null;
  notification_date?: string | null;
  amount_range?: string | null;
  is_public_equity?: boolean;
  parse_confidence?: string | null;
  organization_id?: number | null;
  member_bioguide_id?: string | null;
  member_resolution_confidence?: string | null;
  member_resolution_score?: number | null;
  member_resolution_reason?: string | null;
  quarantine_reason?: string | null;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface DisclosureIngestFailuresRow {
  id: number;
  filing_id: number | null;
  source_type: string;
  stage: string;
  error_code: string | null;
  error_message: string;
  retryable: boolean;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

interface DisclosureIngestFailuresInsert {
  id?: number;
  filing_id?: number | null;
  source_type: string;
  stage: string;
  error_code?: string | null;
  error_message: string;
  retryable?: boolean;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
}

interface MemberStockTradesRow {
  id: number;
  bioguide_id: string;
  organization_id: number | null;
  disclosure_filing_id: number | null;
  source_type: string;
  source_row_key: string;
  symbol: string | null;
  asset_name: string | null;
  normalized_asset_name: string | null;
  transaction_date: string | null;
  disclosure_date: string | null;
  transaction_type: string | null;
  amount_range: string | null;
  share_count: number | null;
  owner_label: string | null;
  owner_type: string | null;
  asset_type: string | null;
  parse_confidence: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface MemberStockTradesInsert {
  id?: number;
  bioguide_id: string;
  organization_id?: number | null;
  disclosure_filing_id?: number | null;
  source_type: string;
  source_row_key: string;
  symbol?: string | null;
  asset_name?: string | null;
  normalized_asset_name?: string | null;
  transaction_date?: string | null;
  disclosure_date?: string | null;
  transaction_type?: string | null;
  amount_range?: string | null;
  share_count?: number | null;
  owner_label?: string | null;
  owner_type?: string | null;
  asset_type?: string | null;
  parse_confidence?: string | null;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface StockPriceHistoryCacheRow {
  symbol: string;
  price_date: string;
  close_price: number;
  source: string;
  fetched_at: string;
  created_at: string;
  updated_at: string;
}

interface StockPriceHistoryCacheInsert {
  symbol: string;
  price_date: string;
  close_price: number;
  source: string;
  fetched_at?: string;
  created_at?: string;
  updated_at?: string;
}

interface StockPriceQuoteCacheRow {
  symbol: string;
  current_price: number;
  source: string;
  fetched_at: string;
  created_at: string;
  updated_at: string;
}

interface StockPriceQuoteCacheInsert {
  symbol: string;
  current_price: number;
  source: string;
  fetched_at?: string;
  created_at?: string;
  updated_at?: string;
}

interface RelationshipFactsRow {
  id: number;
  member_bioguide_id: string | null;
  organization_id: number | null;
  fact_type: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  fact_date: string | null;
  source_table: string;
  source_row_id: string;
  evidence_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RelationshipFactsInsert {
  id?: number;
  member_bioguide_id?: string | null;
  organization_id?: number | null;
  fact_type: string;
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  fact_date?: string | null;
  source_table: string;
  source_row_id: string;
  evidence_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface CorrelationCasesRow {
  id: number;
  member_bioguide_id: string;
  organization_id: number | null;
  case_type: string;
  summary: string;
  event_date: string | null;
  time_window_days: number | null;
  evidence_payload: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CorrelationCasesInsert {
  id?: number;
  member_bioguide_id: string;
  organization_id?: number | null;
  case_type: string;
  summary: string;
  event_date?: string | null;
  time_window_days?: number | null;
  evidence_payload?: Record<string, unknown>;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface DonorSummaryRow {
  candidate_id: string;
  bioguide_id: string | null;
  contributor_employer: string;
  contribution_count: number;
  total_amount: number;
  first_contribution: string;
  last_contribution: string;
}

interface MemberVotingRecordRow {
  bioguide_id: string;
  member_name: string;
  party: string | null;
  state: string | null;
  vote_id: number;
  congress: number;
  chamber: string;
  roll_call_number: number;
  vote_date: string | null;
  question: string | null;
  vote_description: string | null;
  result: string | null;
  bill_congress: number | null;
  bill_type: string | null;
  bill_number: number | null;
  bill_title: string | null;
  policy_area: string | null;
  position: string;
  normalized_position: string;
}

interface MemberCorrelationCasesRow {
  id: number;
  member_bioguide_id: string;
  member_name: string;
  organization_id: number | null;
  organization_name: string | null;
  organization_ticker: string | null;
  case_type: string;
  summary: string;
  event_date: string | null;
  time_window_days: number | null;
  status: string;
  evidence_payload: Record<string, unknown>;
  updated_at: string;
}
