/**
 * Supabase database types — mirrors the schema in supabase/migrations/001_initial_schema.sql
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
      bills: {
        Row: BillsRow;
        Insert: BillsInsert;
        Update: Partial<BillsInsert>;
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
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// ── Members ──────────────────────────────────────────────────────────────────

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
  updated_at?: string;
}

// ── Votes ────────────────────────────────────────────────────────────────────

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

// ── Member Votes ─────────────────────────────────────────────────────────────

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

// ── Bills ────────────────────────────────────────────────────────────────────

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

// ── FEC Candidates ───────────────────────────────────────────────────────────

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

// ── Contributions ────────────────────────────────────────────────────────────

interface ContributionsRow {
  id: number;
  candidate_id: string | null;
  committee_id: string | null;
  committee_name: string | null;
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
  contributor_name?: string | null;
  contributor_employer?: string | null;
  contributor_occupation?: string | null;
  contributor_state?: string | null;
  contribution_amount?: number | null;
  contribution_date?: string | null;
  two_year_period?: number | null;
  updated_at?: string;
}

// ── Views ────────────────────────────────────────────────────────────────────

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
  congress: number;
  chamber: string;
  roll_call_number: number;
  vote_date: string | null;
  question: string | null;
  vote_description: string | null;
  result: string | null;
  position: string;
}
