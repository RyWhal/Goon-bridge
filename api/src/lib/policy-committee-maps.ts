import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db-types";
import { collapseCommitteeToTopLevel, normalizeCommitteeLabel } from "./committee-normalization.ts";

export type PolicyCommitteeOverrideAction = "promote" | "suppress" | "pin";

export interface PolicyCommitteeCandidateScoreInput {
  billCount: number;
  jurisdictionWeight: number;
  latestCongress: number | null;
  currentCongress: number | null;
}

export interface PolicyCommitteeOverrideInput {
  override_action: PolicyCommitteeOverrideAction;
  confidence_delta?: number | null;
}

export interface PolicyCommitteeMapRow {
  confidence?: number | null;
  is_manual_override?: boolean | null;
  is_suppressed?: boolean | null;
}

type DbClient = SupabaseClient;
type BillRow = Database["public"]["Tables"]["bills"]["Row"];
type CommitteeRow = Database["public"]["Tables"]["committees"]["Row"];
type PolicyCommitteeMapInsert = Database["public"]["Tables"]["policy_area_committee_map"]["Insert"];
type PolicyCommitteeEvidenceInsert = Database["public"]["Tables"]["policy_area_committee_evidence"]["Insert"];
type CommitteeMatchReviewQueueInsert = Database["public"]["Tables"]["committee_match_review_queue"]["Insert"];

export interface PolicyCommitteeBillInput {
  id: number;
  congress: number;
  policy_area: string | null;
  committee_names: string[] | null;
}

export interface PolicyCommitteeCommitteeInput {
  id: number;
  committee_key: string;
  committee_code: string | null;
  name: string;
  normalized_name: string;
  chamber: string | null;
}

export interface PolicyCommitteeMappingGroup {
  policy_area: string;
  committee_id: number;
  committee_key: string;
  bill_count: number;
  bill_ids: number[];
}

export interface PolicyCommitteeMappingDerivationResult {
  mappings: PolicyCommitteeMappingGroup[];
  reviewQueueRows: CommitteeMatchReviewQueueInsert[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToTwoDecimals(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeFiniteNumber(value: number | null | undefined, fallback: number): number {
  if (value == null || Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  return value;
}

function normalizeConfidence(value: number | null | undefined, fallback: number): number {
  const normalized = normalizeFiniteNumber(value, fallback);
  return Number.isFinite(normalized) ? clamp(normalized, 0, 1) : fallback;
}

export function scorePolicyCommitteeCandidate({
  billCount,
  jurisdictionWeight,
  latestCongress,
  currentCongress,
}: PolicyCommitteeCandidateScoreInput): number {
  const normalizedBillCount = normalizeFiniteNumber(billCount, 0);
  const normalizedJurisdictionWeight = normalizeFiniteNumber(jurisdictionWeight, 0);
  const billHistoryScore = clamp(Math.max(0, normalizedBillCount) * 0.15, 0, 0.6);
  const jurisdictionScore = clamp(Math.max(0, normalizedJurisdictionWeight), 0, 1) * 0.25;
  const freshnessScore =
    latestCongress != null && currentCongress != null && latestCongress === currentCongress ? 0.1 : 0;

  return roundToTwoDecimals(clamp(billHistoryScore + jurisdictionScore + freshnessScore, 0, 1));
}

export function applyPolicyCommitteeOverride<T extends PolicyCommitteeMapRow>(
  row: T,
  override: PolicyCommitteeOverrideInput
): T & Required<Pick<PolicyCommitteeMapRow, "confidence" | "is_manual_override" | "is_suppressed">> {
  const baseConfidence = normalizeConfidence(row.confidence, 0);

  if (override.override_action === "suppress") {
    return {
      ...row,
      confidence: 0,
      is_manual_override: true,
      is_suppressed: true,
    };
  }

  if (override.override_action === "pin") {
    const pinnedConfidence = override.confidence_delta;
    return {
      ...row,
      confidence: Number.isFinite(pinnedConfidence ?? Number.NaN)
        ? clamp(pinnedConfidence as number, 0, 1)
        : 0,
      is_manual_override: true,
      is_suppressed: !Number.isFinite(pinnedConfidence ?? Number.NaN),
    };
  }

  return {
    ...row,
    confidence: roundToTwoDecimals(clamp(baseConfidence + normalizeConfidence(override.confidence_delta, 0), 0, 1)),
    is_manual_override: true,
    is_suppressed: false,
  };
}

const POLICY_COMMITTEE_MAP_SOURCE = "bill_history";
const POLICY_COMMITTEE_REVIEW_SOURCE = "bill_committee_name";

function asCommitteeNameArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value)
    ? value.map((entry) => entry.trim()).filter((entry): entry is string => !!entry)
    : [];
}

function detectChamberHint(value: string): string | null {
  const upper = value.toUpperCase();
  if (/\bHOUSE\b/.test(upper)) return "House";
  if (/\bSENATE\b/.test(upper)) return "Senate";
  return null;
}

function normalizeReviewSourceValue(value: string, chamberHint: string | null): { normalizedSourceValue: string; chamber: string | null } {
  const collapsed = collapseCommitteeToTopLevel(value, { chamber: chamberHint });
  return {
    normalizedSourceValue: collapsed.normalizedName || normalizeCommitteeLabel(value),
    chamber: collapsed.chamber,
  };
}

function buildReviewQueueKey(
  row: Pick<CommitteeMatchReviewQueueInsert, "source_type" | "source_value" | "normalized_source_value" | "chamber">
): string {
  return [
    row.source_type,
    row.source_value,
    row.normalized_source_value,
    row.chamber ?? "",
  ].join("|");
}

function buildPolicyCommitteeMapKey(row: { policy_area: string; committee_id: number }): string {
  return `${row.policy_area}|${row.committee_id}`;
}

function buildPolicyCommitteeEvidenceKey(row: {
  map_id: number;
  evidence_type: string;
  source_table: string;
  source_row_id: string;
}): string {
  return `${row.map_id}|${row.evidence_type}|${row.source_table}|${row.source_row_id}`;
}

function sortRowsByIdAscending<T extends { id: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.id - right.id);
}

function buildCommitteeIndexes(committees: PolicyCommitteeCommitteeInput[]) {
  const byKey = new Map<string, PolicyCommitteeCommitteeInput>();
  const byNormalizedName = new Map<string, PolicyCommitteeCommitteeInput[]>();
  const byCommitteeCode = new Map<string, PolicyCommitteeCommitteeInput[]>();

  for (const committee of committees) {
    byKey.set(committee.committee_key, committee);

    const normalizedNames = new Set([
      committee.normalized_name,
      normalizeCommitteeLabel(committee.name),
    ]);
    for (const normalizedName of normalizedNames) {
      const bucket = byNormalizedName.get(normalizedName) ?? [];
      bucket.push(committee);
      byNormalizedName.set(normalizedName, bucket);
    }

    if (committee.committee_code) {
      const cleanedCode = committee.committee_code.trim();
      if (cleanedCode) {
        const bucket = byCommitteeCode.get(cleanedCode) ?? [];
        bucket.push(committee);
        byCommitteeCode.set(cleanedCode, bucket);
      }
    }
  }

  return { byKey, byNormalizedName, byCommitteeCode };
}

function resolveCommitteeFromSource(
  sourceValue: string,
  committees: ReturnType<typeof buildCommitteeIndexes>
): { committee: PolicyCommitteeCommitteeInput | null; reviewQueueRow: CommitteeMatchReviewQueueInsert | null } {
  const chamberHint = detectChamberHint(sourceValue);
  const normalizedSourceValue = normalizeCommitteeLabel(sourceValue);
  const reviewSourceValue = normalizeReviewSourceValue(sourceValue, chamberHint);
  const candidateNames = new Set<string>([normalizedSourceValue, reviewSourceValue.normalizedSourceValue].filter(Boolean));

  const candidates = new Map<number, PolicyCommitteeCommitteeInput>();
  const addCandidate = (committee: PolicyCommitteeCommitteeInput | undefined) => {
    if (committee) candidates.set(committee.id, committee);
  };

  addCandidate(committees.byKey.get(sourceValue.trim()));

  for (const candidateName of candidateNames) {
    addCandidate(committees.byKey.get(candidateName));
    for (const committee of committees.byNormalizedName.get(candidateName) ?? []) addCandidate(committee);
    for (const committee of committees.byCommitteeCode.get(candidateName) ?? []) addCandidate(committee);
  }

  const candidateList = [...candidates.values()];
  const narrowedCandidates = chamberHint
    ? candidateList.filter((committee) => committee.chamber === chamberHint)
    : candidateList;

  if (narrowedCandidates.length === 1) {
    return { committee: narrowedCandidates[0], reviewQueueRow: null };
  }

  return {
    committee: null,
    reviewQueueRow: {
      source_type: POLICY_COMMITTEE_REVIEW_SOURCE,
      source_value: sourceValue.trim(),
      normalized_source_value: reviewSourceValue.normalizedSourceValue,
      chamber: reviewSourceValue.chamber,
      review_status: "pending",
    },
  };
}

function collectPolicyCommitteeBillGroups({
  bills,
  committees,
}: {
  bills: PolicyCommitteeBillInput[];
  committees: PolicyCommitteeCommitteeInput[];
}): {
  groups: Array<PolicyCommitteeMappingGroup & { firstSeenCongress: number | null; lastSeenCongress: number | null }>;
  reviewQueueRows: CommitteeMatchReviewQueueInsert[];
} {
  const committeeIndexes = buildCommitteeIndexes(committees);
  const groups = new Map<
    string,
    PolicyCommitteeMappingGroup & { firstSeenCongress: number | null; lastSeenCongress: number | null }
  >();
  const reviewQueueRows = new Map<string, CommitteeMatchReviewQueueInsert>();

  for (const bill of bills) {
    if (!bill.policy_area) continue;

    const uniqueCommitteeIds = new Set<number>();
    for (const committeeName of asCommitteeNameArray(bill.committee_names)) {
      const resolution = resolveCommitteeFromSource(committeeName, committeeIndexes);
      if (!resolution.committee) {
        if (resolution.reviewQueueRow) {
          const key = buildReviewQueueKey(resolution.reviewQueueRow);
          reviewQueueRows.set(key, resolution.reviewQueueRow);
        }
        continue;
      }

      if (uniqueCommitteeIds.has(resolution.committee.id)) continue;
      uniqueCommitteeIds.add(resolution.committee.id);

      const groupKey = `${bill.policy_area}:${resolution.committee.id}`;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.bill_ids.push(bill.id);
        existing.bill_count += 1;
        existing.firstSeenCongress = existing.firstSeenCongress == null ? bill.congress : Math.min(existing.firstSeenCongress, bill.congress);
        existing.lastSeenCongress = existing.lastSeenCongress == null ? bill.congress : Math.max(existing.lastSeenCongress, bill.congress);
        continue;
      }

      groups.set(groupKey, {
        policy_area: bill.policy_area,
        committee_id: resolution.committee.id,
        committee_key: resolution.committee.committee_key,
        bill_count: 1,
        bill_ids: [bill.id],
        firstSeenCongress: bill.congress,
        lastSeenCongress: bill.congress,
      });
    }
  }

  return {
    groups: [...groups.values()],
    reviewQueueRows: [...reviewQueueRows.values()],
  };
}

export function derivePolicyCommitteeMappings({
  bills,
  committees,
}: {
  bills: PolicyCommitteeBillInput[];
  committees: PolicyCommitteeCommitteeInput[];
}): PolicyCommitteeMappingDerivationResult {
  const { groups, reviewQueueRows } = collectPolicyCommitteeBillGroups({ bills, committees });
  return {
    mappings: groups.map(({ firstSeenCongress: _firstSeenCongress, lastSeenCongress: _lastSeenCongress, ...group }) => group),
    reviewQueueRows,
  };
}

async function loadPolicyCommitteeBills(sb: DbClient, congress: number): Promise<BillRow[]> {
  const { data, error } = await sb
    .from("bills")
    .select("id,congress,policy_area,committee_names")
    .eq("congress", congress)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load bills for policy committee refresh: ${error.message}`);
  }

  return (data ?? []) as BillRow[];
}

async function loadPolicyCommitteeCommittees(sb: DbClient): Promise<CommitteeRow[]> {
  const { data, error } = await sb
    .from("committees")
    .select("id,committee_key,committee_code,name,normalized_name,chamber")
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load committees for policy committee refresh: ${error.message}`);
  }

  return (data ?? []) as CommitteeRow[];
}

async function loadExistingPolicyCommitteeMaps(sb: DbClient) {
  const { data, error } = await sb
    .from("policy_area_committee_map")
    .select("id,policy_area,committee_id,source")
    .eq("source", POLICY_COMMITTEE_MAP_SOURCE);

  if (error) {
    throw new Error(`Failed to load existing policy committee map rows: ${error.message}`);
  }

  return (data ?? []) as Array<{ id: number; policy_area: string; committee_id: number; source: string }>;
}

async function loadExistingPolicyCommitteeEvidence(sb: DbClient) {
  const { data, error } = await sb
    .from("policy_area_committee_evidence")
    .select("id,map_id,evidence_type,source_table,source_row_id")
    .eq("source_table", "bills");

  if (error) {
    throw new Error(`Failed to load existing policy committee evidence rows: ${error.message}`);
  }

  return (data ?? []) as Array<{
    id: number;
    map_id: number;
    evidence_type: string;
    source_table: string;
    source_row_id: string;
  }>;
}

async function loadExistingPolicyCommitteeReviewQueue(sb: DbClient) {
  const { data, error } = await sb
    .from("committee_match_review_queue")
    .select("id,source_type,source_value,normalized_source_value,chamber,review_status")
    .eq("source_type", POLICY_COMMITTEE_REVIEW_SOURCE);

  if (error) {
    throw new Error(`Failed to load existing committee review queue rows: ${error.message}`);
  }

  return (data ?? []) as Array<{
    id: number;
    source_type: string;
    source_value: string;
    normalized_source_value: string;
    chamber: string | null;
    review_status: string;
  }>;
}

async function replacePolicyCommitteeMappings(
  sb: DbClient,
  rows: PolicyCommitteeMapInsert[]
): Promise<Array<{ id: number; policy_area: string; committee_id: number }>> {
  const existingRows = await loadExistingPolicyCommitteeMaps(sb);
  const currentKeySet = new Set(rows.map((row) => buildPolicyCommitteeMapKey(row as { policy_area: string; committee_id: number })));

  if (!rows.length) {
    for (const row of existingRows) {
      const { error } = await sb.from("policy_area_committee_map").delete().eq("id", row.id);
      if (error) {
        throw new Error(`Failed to delete stale policy committee map row ${row.id}: ${error.message}`);
      }
    }
    return [];
  }

  const { data, error } = await sb.from("policy_area_committee_map").upsert(rows, {
    onConflict: "policy_area,committee_id",
  }).select("id,policy_area,committee_id");

  if (error) {
    throw new Error(`Failed to upsert policy committee map rows: ${error.message}`);
  }

  const currentRows = (data ?? []) as Array<{ id: number; policy_area: string; committee_id: number }>;
  const currentRowIds = new Set(currentRows.map((row) => row.id));

  for (const row of existingRows) {
    if (currentKeySet.has(buildPolicyCommitteeMapKey(row))) continue;
    if (currentRowIds.has(row.id)) continue;
    const { error: deleteError } = await sb.from("policy_area_committee_map").delete().eq("id", row.id);
    if (deleteError) {
      throw new Error(`Failed to delete stale policy committee map row ${row.id}: ${deleteError.message}`);
    }
  }

  return currentRows;
}

async function replacePolicyCommitteeEvidence(
  sb: DbClient,
  rows: PolicyCommitteeEvidenceInsert[]
): Promise<void> {
  const existingRows = await loadExistingPolicyCommitteeEvidence(sb);
  const currentKeySet = new Set(rows.map((row) =>
    buildPolicyCommitteeEvidenceKey({
      map_id: row.map_id,
      evidence_type: row.evidence_type,
      source_table: row.source_table,
      source_row_id: row.source_row_id,
    })
  ));

  if (rows.length) {
    const { error } = await sb.from("policy_area_committee_evidence").upsert(rows, {
      onConflict: "map_id,evidence_type,source_table,source_row_id",
    });
    if (error) {
      throw new Error(`Failed to upsert policy committee evidence rows: ${error.message}`);
    }
  }

  for (const row of existingRows) {
    if (currentKeySet.has(buildPolicyCommitteeEvidenceKey(row))) continue;
    const { error } = await sb.from("policy_area_committee_evidence").delete().eq("id", row.id);
    if (error) {
      throw new Error(`Failed to delete stale policy committee evidence row ${row.id}: ${error.message}`);
    }
  }
}

async function replacePolicyCommitteeReviewQueue(
  sb: DbClient,
  rows: CommitteeMatchReviewQueueInsert[]
): Promise<void> {
  const existingRows = sortRowsByIdAscending(await loadExistingPolicyCommitteeReviewQueue(sb));
  const existingRowsByKey = new Map<string, CommitteeMatchReviewQueueInsert[]>();

  for (const row of existingRows) {
    const key = buildReviewQueueKey(row);
    const bucket = existingRowsByKey.get(key) ?? [];
    bucket.push(row);
    existingRowsByKey.set(key, bucket);
  }

  const currentRowsByKey = new Map(rows.map((row) => [buildReviewQueueKey(row), row] as const));
  const processedKeys = new Set<string>();

  for (const [key, row] of currentRowsByKey) {
    const existingGroup = existingRowsByKey.get(key) ?? [];
    const [primaryExistingRow, ...duplicateExistingRows] = existingGroup;

    if (primaryExistingRow) {
      const { error } = await sb
        .from("committee_match_review_queue")
        .update({
          source_type: row.source_type,
          source_value: row.source_value,
          normalized_source_value: row.normalized_source_value,
          chamber: row.chamber,
          review_status: row.review_status,
          updated_at: row.updated_at,
        })
        .eq("id", primaryExistingRow.id);

      if (error) {
        throw new Error(`Failed to update committee review queue row ${primaryExistingRow.id}: ${error.message}`);
      }

      for (const duplicateRow of duplicateExistingRows) {
        const { error: deleteError } = await sb.from("committee_match_review_queue").delete().eq("id", duplicateRow.id);
        if (deleteError) {
          throw new Error(`Failed to delete duplicate committee review queue row ${duplicateRow.id}: ${deleteError.message}`);
        }
      }
    } else {
      const { error } = await sb.from("committee_match_review_queue").insert([row]);
      if (error) {
        throw new Error(`Failed to insert committee review queue rows: ${error.message}`);
      }
    }

    processedKeys.add(key);
  }

  for (const [key, existingGroup] of existingRowsByKey) {
    if (processedKeys.has(key)) continue;
    for (const row of existingGroup) {
      const { error } = await sb.from("committee_match_review_queue").delete().eq("id", row.id);
      if (error) {
        throw new Error(`Failed to delete stale committee review queue row ${row.id}: ${error.message}`);
      }
    }
  }
}

export async function refreshPolicyCommitteeMappings(sb: DbClient, congress: number) {
  const [bills, committees] = await Promise.all([
    loadPolicyCommitteeBills(sb, congress),
    loadPolicyCommitteeCommittees(sb),
  ]);

  const derived = collectPolicyCommitteeBillGroups({
    bills: bills.map((bill) => ({
      id: bill.id,
      congress: bill.congress,
      policy_area: bill.policy_area,
      committee_names: bill.committee_names,
    })),
    committees: committees.map((committee) => ({
      id: committee.id,
      committee_key: committee.committee_key,
      committee_code: committee.committee_code,
      name: committee.name,
      normalized_name: committee.normalized_name,
      chamber: committee.chamber,
    })),
  });

  const now = new Date().toISOString();
  const mapRows: PolicyCommitteeMapInsert[] = derived.groups.map((group) => ({
    policy_area: group.policy_area,
    committee_id: group.committee_id,
    confidence: scorePolicyCommitteeCandidate({
      billCount: group.bill_count,
      jurisdictionWeight: 0,
      latestCongress: group.lastSeenCongress,
      currentCongress: congress,
    }),
    source: POLICY_COMMITTEE_MAP_SOURCE,
    evidence_count: group.bill_count,
    bill_count: group.bill_count,
    first_seen_congress: group.firstSeenCongress,
    last_seen_congress: group.lastSeenCongress,
    last_seen_at: now,
    is_manual_override: false,
    is_suppressed: false,
    updated_at: now,
  }));

  const insertedMaps = await replacePolicyCommitteeMappings(sb, mapRows);

  const mapIdByKey = new Map(
    insertedMaps.map((row) => [`${row.policy_area}:${row.committee_id}`, row.id ?? null] as const)
  );
  const evidenceRows: PolicyCommitteeEvidenceInsert[] = [];
  for (const group of derived.groups) {
    const mapId = mapIdByKey.get(`${group.policy_area}:${group.committee_id}`);
    if (mapId == null) continue;
    for (const billId of group.bill_ids) {
      evidenceRows.push({
        map_id: mapId,
        evidence_type: POLICY_COMMITTEE_MAP_SOURCE,
        source_table: "bills",
        source_row_id: String(billId),
        source_url: null,
        weight: 1,
        note: "Derived from bill committee referrals",
        evidence_payload: {
          bill_id: billId,
          policy_area: group.policy_area,
          committee_id: group.committee_id,
          committee_key: group.committee_key,
          congress,
        },
      });
    }
  }

  await replacePolicyCommitteeEvidence(sb, evidenceRows);
  await replacePolicyCommitteeReviewQueue(sb, derived.reviewQueueRows.map((row) => ({ ...row, updated_at: now })));

  return {
    billsLoaded: bills.length,
    committeesLoaded: committees.length,
    mappingsWritten: insertedMaps.length,
    evidenceRowsWritten: evidenceRows.length,
    reviewQueueRowsWritten: derived.reviewQueueRows.length,
  };
}

export interface PolicyCommitteeCommitteeSummary {
  id: number;
  committee_key: string;
  committee_code: string | null;
  name: string;
  normalized_name: string;
  chamber: string | null;
}

export interface PolicyCommitteeMapReadRow {
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
  committee: PolicyCommitteeCommitteeSummary | null;
}

export interface PolicyCommitteeEvidenceReadRow {
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

function normalizePolicyAreaLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

async function loadPolicyCommitteeCommitteeSummaries(
  sb: DbClient,
  committeeIds: number[]
): Promise<Map<number, PolicyCommitteeCommitteeSummary>> {
  if (!committeeIds.length) return new Map();

  const { data, error } = await sb
    .from("committees")
    .select("id,committee_key,committee_code,name,normalized_name,chamber")
    .in("id", committeeIds)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load policy committee summaries: ${error.message}`);
  }

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      {
        id: row.id,
        committee_key: row.committee_key,
        committee_code: row.committee_code,
        name: row.name,
        normalized_name: row.normalized_name,
        chamber: row.chamber,
      },
    ])
  );
}

export async function loadVisiblePolicyCommitteeMappings(
  sb: DbClient,
  policyArea: string
): Promise<PolicyCommitteeMapReadRow[]> {
  const normalizedPolicyArea = normalizePolicyAreaLabel(policyArea);
  const { data, error } = await sb
    .from("policy_area_committee_map")
    .select("id,policy_area,committee_id,confidence,source,evidence_count,bill_count,first_seen_congress,last_seen_congress,last_seen_at,is_manual_override,is_suppressed,created_at,updated_at")
    .eq("policy_area", normalizedPolicyArea)
    .eq("is_suppressed", false)
    .order("confidence", { ascending: false })
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load policy committee mappings: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
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
  }>;
  const committeeSummaries = await loadPolicyCommitteeCommitteeSummaries(
    sb,
    [...new Set(rows.map((row) => row.committee_id))]
  );

  return rows.map((row) => ({
    id: row.id,
    policy_area: row.policy_area,
    committee_id: row.committee_id,
    confidence: row.confidence,
    source: row.source,
    evidence_count: row.evidence_count,
    bill_count: row.bill_count,
    first_seen_congress: row.first_seen_congress,
    last_seen_congress: row.last_seen_congress,
    last_seen_at: row.last_seen_at,
    is_manual_override: row.is_manual_override,
    is_suppressed: row.is_suppressed,
    created_at: row.created_at,
    updated_at: row.updated_at,
    committee: committeeSummaries.get(row.committee_id) ?? null,
  }));
}

export async function loadPolicyCommitteeEvidence(
  sb: DbClient,
  mapId: number
): Promise<PolicyCommitteeEvidenceReadRow[]> {
  const { data, error } = await sb
    .from("policy_area_committee_evidence")
    .select("id,map_id,evidence_type,source_table,source_row_id,source_url,weight,note,evidence_payload,created_at")
    .eq("map_id", mapId)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load policy committee evidence: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    map_id: row.map_id,
    evidence_type: row.evidence_type,
    source_table: row.source_table,
    source_row_id: row.source_row_id,
    source_url: row.source_url ?? null,
    weight: row.weight ?? null,
    note: row.note ?? null,
    evidence_payload: (row.evidence_payload ?? {}) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}
