export const POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM = "known-good";

interface PolicyCommitteeSummary {
  id: number;
  committee_key: string;
  committee_code: string | null;
  name: string;
  normalized_name: string;
  chamber: string | null;
}

interface PolicyCommitteeMapResult {
  id: number;
  policy_area: string;
  committee_id: number;
  confidence: number;
  source: string;
  evidence_count: number;
  bill_count: number;
  first_seen_congress: number | null;
  last_seen_congress: number | null;
  last_seen_at: string | null;
  is_manual_override: boolean;
  is_suppressed: boolean;
  created_at: string;
  updated_at: string;
  committee: PolicyCommitteeSummary | null;
}

interface PolicyCommitteeSearchResponse {
  policy_area: string;
  count: number;
  rows: PolicyCommitteeMapResult[];
}

interface PolicyCommitteeEvidenceItem {
  id: number;
  map_id: number;
  evidence_type: string;
  source_table: string;
  source_row_id: string;
  source_url: string | null;
  weight: number | null;
  note: string | null;
  evidence_payload: Record<string, unknown>;
  created_at: string;
}

interface PolicyCommitteeEvidenceResponse {
  map_type: string;
  map_id: number;
  count: number;
  evidence: PolicyCommitteeEvidenceItem[];
}

export function getKnownGoodPolicyMapBrowserTestcase(): PolicyCommitteeSearchResponse {
  return {
    policy_area: "DEFENSE",
    count: 1,
    rows: [
      {
        id: 11,
        policy_area: "DEFENSE",
        committee_id: 32,
        confidence: 0.91,
        source: "bill_history",
        evidence_count: 2,
        bill_count: 2,
        first_seen_congress: 118,
        last_seen_congress: 119,
        last_seen_at: "2026-03-19T00:00:00.000Z",
        is_manual_override: false,
        is_suppressed: false,
        created_at: "2026-03-19T00:00:00.000Z",
        updated_at: "2026-03-19T00:00:00.000Z",
        committee: {
          id: 32,
          committee_key: "ARMED SERVICES:House",
          committee_code: "HSAS",
          name: "Armed Services",
          normalized_name: "Armed Services",
          chamber: "House",
        },
      },
    ],
  };
}

export function getKnownGoodPolicyMapBrowserEvidence(): PolicyCommitteeEvidenceResponse {
  return {
    map_type: "policy-committee",
    map_id: 11,
    count: 2,
    evidence: [
      {
        id: 201,
        map_id: 11,
        evidence_type: "bill_history",
        source_table: "bills",
        source_row_id: "9001",
        source_url: null,
        weight: 1,
        note: "Derived from bill committee referrals",
        evidence_payload: {
          bill_id: 9001,
          policy_area: "DEFENSE",
          committee_id: 32,
          committee_key: "ARMED SERVICES:House",
          congress: 119,
        },
        created_at: "2026-03-19T00:00:00.000Z",
      },
      {
        id: 202,
        map_id: 11,
        evidence_type: "bill_history",
        source_table: "bills",
        source_row_id: "9002",
        source_url: null,
        weight: 1,
        note: "Derived from bill committee referrals",
        evidence_payload: {
          bill_id: 9002,
          policy_area: "DEFENSE",
          committee_id: 32,
          committee_key: "ARMED SERVICES:House",
          congress: 119,
        },
        created_at: "2026-03-19T00:00:00.000Z",
      },
    ],
  };
}
