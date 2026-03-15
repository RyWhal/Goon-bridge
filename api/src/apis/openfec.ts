import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";
import { ensureOrganization, normalizeOrganizationName } from "../lib/relationships";

const openfec = new Hono<Env>();

const BASE = "https://api.open.fec.gov/v1";
const FEC_FETCH_TIMEOUT_MS = 12_000;
const FEC_BACKGROUND_FETCH_TIMEOUT_MS = 30_000;
const CONTRIBUTIONS_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const SUMMARY_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const SUMMARY_PENDING_CACHE_STALE_MS = 30 * 60 * 1000;
const SUMMARY_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const SUMMARY_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const summaryRefreshInFlight = new Set<string>();
const summaryRefreshCooldownUntil = new Map<string, number>();

class FecTimeoutError extends Error {
  constructor(message = "OpenFEC request timed out") {
    super(message);
    this.name = "FecTimeoutError";
  }
}

class FecUpstreamError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "FecUpstreamError";
    this.status = status;
    this.detail = detail;
  }
}

type SummaryTopN = 5 | 10 | 20;

interface FecContributionResult {
  [key: string]: unknown;
  candidate_id?: string;
  candidate_name?: string;
  committee_id?: string;
  committee?: { name?: string };
  recipient_name?: string;
  recipient_organization_id?: number;
  contributor_name?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contributor_state?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  two_year_transaction_period?: number;
  pdf_url?: string;
}

interface CachedContributionRow {
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
}

interface FecScheduleAPagination {
  count?: number;
  page?: number;
  pages?: number;
  last_indexes?: Record<string, string | number>;
}

interface CandidateSummaryDonationPoint {
  contribution_amount: number;
  contributor_name: string | null;
  contributor_employer: string | null;
  contribution_date: string | null;
  committee_name: string | null;
}

interface CandidateSummaryTopDonor {
  donor_name: string;
  donation_count: number;
  total_donation_amount: number;
  largest_single_donation: number;
}

interface CandidateSummaryTopEmployer {
  employer: string;
  donation_count: number;
  total_donation_amount: number;
  largest_single_donation: number | null;
}

interface CandidateSummaryPayload {
  candidate_id: string;
  two_year_period: number;
  summary_pending?: boolean;
  message?: string;
  summary: {
    donation_count: number;
    total_donation_amount: number;
    average_donation_amount: number | null;
    mean_donation_amount: number | null;
    median_donation_amount: number | null;
    largest_donation: CandidateSummaryDonationPoint | null;
    smallest_donation: CandidateSummaryDonationPoint | null;
    highest_donation_by_employer: {
      employer: string;
      contribution_amount: number;
      contributor_name: string | null;
      contribution_date: string | null;
      committee_name: string | null;
    } | null;
  };
  top_donors: {
    top_5: CandidateSummaryTopDonor[];
    top_10: CandidateSummaryTopDonor[];
    top_20: CandidateSummaryTopDonor[];
    selected_top_n: CandidateSummaryTopDonor[];
  };
  top_employers: {
    top_5: CandidateSummaryTopEmployer[];
    top_10: CandidateSummaryTopEmployer[];
    top_20: CandidateSummaryTopEmployer[];
    selected_top_n: CandidateSummaryTopEmployer[];
  };
}

type CandidateSummaryApiResponse = CandidateSummaryPayload & {
  query_context: Record<string, unknown>;
};

interface CandidateSummaryCacheRow {
  candidate_id: string;
  two_year_period: number;
  committee_id: string | null;
  payload: CandidateSummaryPayload | null;
  updated_at: string | null;
}

function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

async function fecFetch(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
  timeoutMs = FEC_FETCH_TIMEOUT_MS
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url.toString(), { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new FecTimeoutError(`OpenFEC request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


async function readFecErrorDetails(resp: Response): Promise<string | null> {
  const raw = await resp.text().catch(() => "");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      message?: string;
      detail?: string;
      [key: string]: unknown;
    };

    const reason =
      parsed.error ?? parsed.message ?? parsed.detail ?? (typeof parsed === "object" ? JSON.stringify(parsed) : null);

    if (!reason) return null;
    return String(reason).slice(0, 300);
  } catch {
    const snippet = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return snippet ? snippet.slice(0, 300) : null;
  }
}

async function resolveCandidateCommitteeId(
  apiKey: string,
  candidateId: string,
  twoYearPeriod?: string
): Promise<string | null> {
  const targetCycle = Number(twoYearPeriod ?? defaultTwoYearPeriod());
  const targetCycleValid = Number.isFinite(targetCycle);

  const selectBestCommitteeId = (
    committees: Array<{
      committee_id?: string;
      designation?: string;
      cycles?: number[];
      last_file_date?: string | null;
    }>
  ): string | null => {
    const candidates = committees.filter(
      (committee): committee is {
        committee_id: string;
        designation?: string;
        cycles?: number[];
        last_file_date?: string | null;
      } => typeof committee.committee_id === "string" && committee.committee_id.length > 0
    );
    if (candidates.length === 0) return null;

    const rankDesignation = (designation?: string): number => {
      if (designation === "P") return 0;
      if (designation === "A") return 1;
      return 2;
    };

    const rankCycle = (cycles?: number[]): number => {
      if (!Array.isArray(cycles) || cycles.length === 0) return -1;
      return Math.max(...cycles);
    };

    const rankDate = (date?: string | null): number => {
      if (!date) return 0;
      const parsed = Date.parse(date);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    candidates.sort((a, b) => {
      const aTarget = targetCycleValid && Array.isArray(a.cycles) && a.cycles.includes(targetCycle) ? 1 : 0;
      const bTarget = targetCycleValid && Array.isArray(b.cycles) && b.cycles.includes(targetCycle) ? 1 : 0;
      if (bTarget !== aTarget) return bTarget - aTarget;

      const designationDelta = rankDesignation(a.designation) - rankDesignation(b.designation);
      if (designationDelta !== 0) return designationDelta;

      const cycleDelta = rankCycle(b.cycles) - rankCycle(a.cycles);
      if (cycleDelta !== 0) return cycleDelta;

      const dateDelta = rankDate(b.last_file_date) - rankDate(a.last_file_date);
      if (dateDelta !== 0) return dateDelta;

      return a.committee_id.localeCompare(b.committee_id);
    });

    return candidates[0]?.committee_id ?? null;
  };

  try {
    const candidateResp = await fecFetch(
      `/candidate/${candidateId}/`,
      apiKey,
      undefined,
      FEC_BACKGROUND_FETCH_TIMEOUT_MS
    );
    if (!candidateResp.ok) return null;

    const candidateData = (await candidateResp.json()) as {
      results?: Array<{
        principal_committees?: Array<{ committee_id?: string }>;
        [key: string]: unknown;
      }>;
    };
    const candidate = candidateData.results?.[0];
    const principalCommitteeId = candidate?.principal_committees?.find(
      (committee) =>
        typeof committee.committee_id === "string" && committee.committee_id.length > 0
    )?.committee_id;
    if (principalCommitteeId) return principalCommitteeId;

    const fallbackQueries: Array<{
      path: string;
      params: Record<string, string>;
    }> = [
      {
        path: `/candidate/${candidateId}/committees/`,
        params: { per_page: "100", sort: "-last_file_date" },
      },
      {
        path: `/candidate/${candidateId}/committees/`,
        params: { per_page: "100" },
      },
      {
        path: "/committees/",
        params: { candidate_id: candidateId, per_page: "100", sort: "-last_file_date" },
      },
      {
        path: "/committees/",
        params: { candidate_id: candidateId, per_page: "100" },
      },
    ];

    for (const query of fallbackQueries) {
      const resp = await fecFetch(
        query.path,
        apiKey,
        query.params,
        FEC_FETCH_TIMEOUT_MS
      );
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        results?: Array<{
          committee_id?: string;
          designation?: string;
          cycles?: number[];
          last_file_date?: string | null;
        }>;
      };

      const committeeId = selectBestCommitteeId(data.results ?? []);
      if (committeeId) return committeeId;
    }

    return null;
  } catch {
    return null;
  }
}

function defaultTwoYearPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const evenYear = year % 2 === 0 ? year : year + 1;
  return String(evenYear);
}

function deriveRecipientName(row: {
  recipient_name?: string | null;
  committee?: { name?: string } | null;
  committee_name?: string | null;
  candidate_name?: string | null;
}): string | null {
  const recipientName =
    row.recipient_name ??
    row.committee?.name ??
    row.committee_name ??
    row.candidate_name ??
    null;
  return recipientName?.replace(/\s+/g, " ").trim() || null;
}

function normalizeRecipientName(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const normalized = normalizeOrganizationName(cleaned);
  if (normalized) return normalized;
  return cleaned.toUpperCase();
}

const EXCLUDED_EMPLOYER_KEYS = new Set([
  "N A",
  "NA",
  "NONE",
  "NIL",
  "NOT APPLICABLE",
  "NOT EMPLOYED",
  "NOT PROVIDED",
  "NULL",
  "UNEMPLOYED",
  "UNKNOWN",
]);

const EXCLUDED_EMPLOYER_PATTERNS = [
  /^CONTRACTOR$/,
  /^INDEPENDENT CONTRACTOR$/,
  /^SELF ?EMPLOYED$/,
];

function normalizeEmployerKey(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeEmployer(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const key = normalizeEmployerKey(cleaned);
  if (!key) return null;
  if (EXCLUDED_EMPLOYER_KEYS.has(key)) return null;
  if (EXCLUDED_EMPLOYER_PATTERNS.some((pattern) => pattern.test(key))) return null;
  return cleaned;
}

function toFiniteNumber(value: unknown): number | null {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : null;
  if (numberValue == null || !Number.isFinite(numberValue)) return null;
  return numberValue;
}

function normalizeSummaryTopN(value: number): SummaryTopN {
  return value === 5 || value === 10 || value === 20 ? value : 10;
}

function createEmptyTopCollection<T>(): {
  top_5: T[];
  top_10: T[];
  top_20: T[];
  selected_top_n: T[];
} {
  return {
    top_5: [],
    top_10: [],
    top_20: [],
    selected_top_n: [],
  };
}

function createPendingCandidateSummaryPayload(
  candidateId: string,
  twoYearPeriod: number,
  message: string
): CandidateSummaryPayload {
  return {
    candidate_id: candidateId,
    two_year_period: twoYearPeriod,
    summary_pending: true,
    message,
    summary: {
      donation_count: 0,
      total_donation_amount: 0,
      average_donation_amount: null,
      mean_donation_amount: null,
      median_donation_amount: null,
      largest_donation: null,
      smallest_donation: null,
      highest_donation_by_employer: null,
    },
    top_donors: createEmptyTopCollection<CandidateSummaryTopDonor>(),
    top_employers: createEmptyTopCollection<CandidateSummaryTopEmployer>(),
  };
}

function applyTopNToSummaryPayload(
  payload: CandidateSummaryPayload,
  topN: SummaryTopN
): CandidateSummaryPayload {
  const selectTopN = <T>(collection: {
    top_5?: T[];
    top_10?: T[];
    top_20?: T[];
  }): T[] => {
    const top5 = Array.isArray(collection.top_5) ? collection.top_5 : [];
    const top10 = Array.isArray(collection.top_10) ? collection.top_10 : [];
    const top20 = Array.isArray(collection.top_20) ? collection.top_20 : [];

    if (topN === 5) return top5.slice(0, 5);
    if (topN === 10) return (top10.length ? top10 : top20).slice(0, 10);
    return (top20.length ? top20 : top10).slice(0, 20);
  };

  return {
    ...payload,
    top_donors: {
      top_5: [...(payload.top_donors?.top_5 ?? [])],
      top_10: [...(payload.top_donors?.top_10 ?? [])],
      top_20: [...(payload.top_donors?.top_20 ?? [])],
      selected_top_n: selectTopN(payload.top_donors),
    },
    top_employers: {
      top_5: [...(payload.top_employers?.top_5 ?? [])],
      top_10: [...(payload.top_employers?.top_10 ?? [])],
      top_20: [...(payload.top_employers?.top_20 ?? [])],
      selected_top_n: selectTopN(payload.top_employers),
    },
  };
}

function normalizeCachedCandidateSummaryPayload(
  payload: unknown,
  candidateId: string,
  twoYearPeriod: number
): CandidateSummaryPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Partial<CandidateSummaryPayload>;
  const topDonors = source.top_donors ?? createEmptyTopCollection<CandidateSummaryTopDonor>();
  const topEmployers =
    source.top_employers ?? createEmptyTopCollection<CandidateSummaryTopEmployer>();

  return {
    candidate_id:
      typeof source.candidate_id === "string" && source.candidate_id.length > 0
        ? source.candidate_id
        : candidateId,
    two_year_period:
      typeof source.two_year_period === "number"
        ? source.two_year_period
        : twoYearPeriod,
    summary_pending: source.summary_pending === true ? true : undefined,
    message: typeof source.message === "string" ? source.message : undefined,
    summary: source.summary ?? {
      donation_count: 0,
      total_donation_amount: 0,
      average_donation_amount: null,
      mean_donation_amount: null,
      median_donation_amount: null,
      largest_donation: null,
      smallest_donation: null,
      highest_donation_by_employer: null,
    },
    top_donors: {
      top_5: Array.isArray(topDonors.top_5) ? topDonors.top_5 : [],
      top_10: Array.isArray(topDonors.top_10) ? topDonors.top_10 : [],
      top_20: Array.isArray(topDonors.top_20) ? topDonors.top_20 : [],
      selected_top_n: Array.isArray(topDonors.selected_top_n)
        ? topDonors.selected_top_n
        : [],
    },
    top_employers: {
      top_5: Array.isArray(topEmployers.top_5) ? topEmployers.top_5 : [],
      top_10: Array.isArray(topEmployers.top_10) ? topEmployers.top_10 : [],
      top_20: Array.isArray(topEmployers.top_20) ? topEmployers.top_20 : [],
      selected_top_n: Array.isArray(topEmployers.selected_top_n)
        ? topEmployers.selected_top_n
        : [],
    },
  };
}

function isIncompleteCandidateSummaryPayload(payload: CandidateSummaryPayload): boolean {
  if (payload.summary_pending) return false;

  const donationCount = payload.summary?.donation_count ?? 0;
  if (donationCount <= 0) return false;

  const donorTopCount =
    (payload.top_donors?.top_5?.length ?? 0) +
    (payload.top_donors?.top_10?.length ?? 0) +
    (payload.top_donors?.top_20?.length ?? 0);
  const employerTopCount =
    (payload.top_employers?.top_5?.length ?? 0) +
    (payload.top_employers?.top_10?.length ?? 0) +
    (payload.top_employers?.top_20?.length ?? 0);

  if (donorTopCount === 0) return true;

  // If we have an employer aggregate winner, we should also have at least one ranked row.
  if (payload.summary?.highest_donation_by_employer && employerTopCount === 0) {
    return true;
  }

  // Old cached payloads may contain a bug where largest_single == total for multi-donation rows.
  const suspiciousEmployerRows = (payload.top_employers?.top_20 ?? []).filter(
    (row) =>
      row.donation_count > 1 &&
      row.largest_single_donation != null &&
      row.total_donation_amount > 0 &&
      row.largest_single_donation === row.total_donation_amount
  ).length;
  if (suspiciousEmployerRows > 0) return true;

  return false;
}

function getSummaryRefreshKey(candidateId: string, twoYearPeriod: number): string {
  return `${candidateId}:${twoYearPeriod}`;
}

async function buildCandidateContributionSummaryFromOpenFec(
  apiKey: string,
  candidateId: string,
  twoYearPeriod: string,
  topN: SummaryTopN
): Promise<{
  response: CandidateSummaryApiResponse;
  resolvedCommitteeId: string | null;
}> {
  const twoYearPeriodNumber = Number(twoYearPeriod);
  const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId, twoYearPeriod);

  if (!committeeId) {
    const payload = applyTopNToSummaryPayload(
      createPendingCandidateSummaryPayload(
        candidateId,
        twoYearPeriodNumber,
        "No committee could be resolved for this candidate yet."
      ),
      topN
    );
    return {
      response: {
        ...payload,
        query_context: {
          source: "openfec_live_summary",
          candidate_id: candidateId,
          resolved_committee_id: null,
          two_year_transaction_period: twoYearPeriodNumber,
          top_n: topN,
          sampled_top_donors: true,
        },
      },
      resolvedCommitteeId: null,
    };
  }

  const baseParams = {
    committee_id: committeeId,
    candidate_id: candidateId,
    is_individual: "true",
    two_year_transaction_period: twoYearPeriod,
  };

  const [largestResp, smallestResp, topRowsResp, sizeResp] = await Promise.all([
    fecFetch("/schedules/schedule_a/", apiKey, {
      ...baseParams,
      per_page: "1",
      sort: "-contribution_receipt_amount",
    }),
    fecFetch("/schedules/schedule_a/", apiKey, {
      ...baseParams,
      per_page: "1",
      sort: "contribution_receipt_amount",
    }),
    fecFetch("/schedules/schedule_a/", apiKey, {
      ...baseParams,
      per_page: "100",
      sort: "-contribution_receipt_amount",
    }),
    fecFetch("/schedules/schedule_a/by_size/", apiKey, {
      committee_id: committeeId,
      two_year_transaction_period: twoYearPeriod,
      is_individual: "true",
      per_page: "100",
    }),
  ]);

  const upstreamChecks: Array<{ label: string; resp: Response }> = [
    { label: "largest", resp: largestResp },
    { label: "smallest", resp: smallestResp },
    { label: "top_rows", resp: topRowsResp },
    { label: "by_size", resp: sizeResp },
  ];
  const upstreamFailure = upstreamChecks.find(({ resp }) => !resp.ok);

  if (upstreamFailure) {
    const upstreamDetail = await readFecErrorDetails(upstreamFailure.resp);
    throw new FecUpstreamError(
      `OpenFEC summary query failed (${upstreamFailure.label})`,
      upstreamFailure.resp.status,
      `status=${upstreamFailure.resp.status}${upstreamDetail ? ` | ${upstreamDetail}` : ""}`
    );
  }

  const largestData = (await largestResp.json()) as {
    results?: FecContributionResult[];
    pagination?: FecScheduleAPagination;
  };
  const smallestData = (await smallestResp.json()) as {
    results?: FecContributionResult[];
  };
  const topRowsData = (await topRowsResp.json()) as {
    results?: FecContributionResult[];
    pagination?: FecScheduleAPagination;
  };
  const sizeData = (await sizeResp.json()) as {
    results?: Array<{
      total?: number;
    }>;
  };

  const largestRow = largestData.results?.[0];
  const smallestRow = smallestData.results?.[0];
  const donationCount = largestData.pagination?.count ?? topRowsData.pagination?.count ?? 0;
  const totalDonationAmount = (sizeData.results ?? []).reduce(
    (sum, row) => sum + (row.total ?? 0),
    0
  );
  const meanDonationAmount =
    donationCount > 0 ? totalDonationAmount / donationCount : null;

  const topDonorMap = new Map<string, CandidateSummaryTopDonor>();

  for (const row of topRowsData.results ?? []) {
    const amount = row.contribution_receipt_amount ?? 0;
    if (!Number.isFinite(amount)) continue;
    const donorName = row.contributor_name?.trim() || "Unknown contributor";
    const donorKey = donorName.toUpperCase();
    const existing = topDonorMap.get(donorKey);
    if (!existing) {
      topDonorMap.set(donorKey, {
        donor_name: donorName,
        donation_count: 1,
        total_donation_amount: amount,
        largest_single_donation: amount,
      });
      continue;
    }
    existing.donation_count += 1;
    existing.total_donation_amount += amount;
    if (amount > existing.largest_single_donation) {
      existing.largest_single_donation = amount;
    }
  }

  const sortedTopDonors = Array.from(topDonorMap.values()).sort((a, b) => {
    if (b.total_donation_amount !== a.total_donation_amount) {
      return b.total_donation_amount - a.total_donation_amount;
    }
    if (b.largest_single_donation !== a.largest_single_donation) {
      return b.largest_single_donation - a.largest_single_donation;
    }
    return a.donor_name.localeCompare(b.donor_name);
  });

  let topEmployer:
    | {
        employer: string;
        total: number;
      }
    | null = null;
  let employerSource: "fec_by_employer" | "sampled_top_rows" | "none" = "none";
  let sortedTopEmployers: CandidateSummaryTopEmployer[] = [];
  const sampledLargestByEmployer = new Map<string, number>();

  for (const row of topRowsData.results ?? []) {
    const employer = sanitizeEmployer(row.contributor_employer);
    const amount = row.contribution_receipt_amount ?? 0;
    if (!employer || !Number.isFinite(amount)) continue;
    const key = normalizeEmployerKey(employer);
    const existing = sampledLargestByEmployer.get(key);
    if (existing == null || amount > existing) {
      sampledLargestByEmployer.set(key, amount);
    }
  }

  try {
    const employerResp = await fecFetch(
      "/schedules/schedule_a/by_employer/",
      apiKey,
      {
        committee_id: committeeId,
        candidate_id: candidateId,
        two_year_transaction_period: twoYearPeriod,
        is_individual: "true",
        per_page: "100",
        sort: "-total",
      },
      8_000
    );

    if (employerResp.ok) {
      const employerData = (await employerResp.json()) as {
        results?: Array<{
          employer?: string;
          total?: number | string | null;
          count?: number | string | null;
          max?: number | string | null;
        }>;
      };
      sortedTopEmployers = (employerData.results ?? [])
        .map((row) => {
          const employer = sanitizeEmployer(row.employer);
          const total = toFiniteNumber(row.total);
          if (!employer || total == null) return null;
          const employerKey = normalizeEmployerKey(employer);
          const donationCount = Math.max(0, Math.round(toFiniteNumber(row.count) ?? 0));
          const largestSingleDonation =
            toFiniteNumber(row.max) ??
            sampledLargestByEmployer.get(employerKey) ??
            null;
          return {
            employer,
            donation_count: donationCount,
            total_donation_amount: total,
            largest_single_donation: largestSingleDonation,
          };
        })
        .filter((row): row is CandidateSummaryTopEmployer => !!row);

      if (sortedTopEmployers.length > 0) {
        const row = sortedTopEmployers[0];
        topEmployer = {
          employer: row.employer,
          total: row.total_donation_amount,
        };
        employerSource = "fec_by_employer";
      }
    }
  } catch {
    // Best effort only; we will fall back to sampled top rows if available.
  }

  if (!topEmployer) {
    const employerMap = new Map<string, CandidateSummaryTopEmployer>();
    for (const row of topRowsData.results ?? []) {
      const employer = sanitizeEmployer(row.contributor_employer);
      const amount = row.contribution_receipt_amount ?? 0;
      if (!employer || !Number.isFinite(amount)) continue;
      const key = normalizeEmployerKey(employer);
      const existing = employerMap.get(key);
      if (!existing) {
        employerMap.set(key, {
          employer,
          donation_count: 1,
          total_donation_amount: amount,
          largest_single_donation: amount,
        });
        continue;
      }
      existing.donation_count += 1;
      existing.total_donation_amount += amount;
      const existingLargest = existing.largest_single_donation ?? 0;
      if (amount > existingLargest) {
        existing.largest_single_donation = amount;
      }
    }

    sortedTopEmployers = Array.from(employerMap.values()).sort((a, b) => {
      if (b.total_donation_amount !== a.total_donation_amount) {
        return b.total_donation_amount - a.total_donation_amount;
      }
      const bLargest = b.largest_single_donation ?? 0;
      const aLargest = a.largest_single_donation ?? 0;
      if (bLargest !== aLargest) {
        return bLargest - aLargest;
      }
      return a.employer.localeCompare(b.employer);
    });

    const sampledTopEmployer = sortedTopEmployers[0];
    if (sampledTopEmployer) {
      topEmployer = {
        employer: sampledTopEmployer.employer,
        total: sampledTopEmployer.total_donation_amount,
      };
      employerSource = "sampled_top_rows";
    }
  }

  const payload = applyTopNToSummaryPayload(
    {
      candidate_id: candidateId,
      two_year_period: twoYearPeriodNumber,
      summary: {
        donation_count: donationCount,
        total_donation_amount: totalDonationAmount,
        average_donation_amount: meanDonationAmount,
        mean_donation_amount: meanDonationAmount,
        median_donation_amount: null,
        largest_donation: largestRow
          ? {
              contribution_amount: largestRow.contribution_receipt_amount ?? 0,
              contributor_name: largestRow.contributor_name ?? null,
              contributor_employer: largestRow.contributor_employer ?? null,
              contribution_date: largestRow.contribution_receipt_date ?? null,
              committee_name: largestRow.committee?.name ?? null,
            }
          : null,
        smallest_donation: smallestRow
          ? {
              contribution_amount: smallestRow.contribution_receipt_amount ?? 0,
              contributor_name: smallestRow.contributor_name ?? null,
              contributor_employer: smallestRow.contributor_employer ?? null,
              contribution_date: smallestRow.contribution_receipt_date ?? null,
              committee_name: smallestRow.committee?.name ?? null,
            }
          : null,
        highest_donation_by_employer: topEmployer
          ? {
              employer: topEmployer.employer,
              contribution_amount: topEmployer.total,
              contributor_name: null,
              contribution_date: null,
              committee_name: null,
            }
          : null,
      },
      top_donors: {
        top_5: sortedTopDonors.slice(0, 5),
        top_10: sortedTopDonors.slice(0, 10),
        top_20: sortedTopDonors.slice(0, 20),
        selected_top_n: [],
      },
      top_employers: {
        top_5: sortedTopEmployers.slice(0, 5),
        top_10: sortedTopEmployers.slice(0, 10),
        top_20: sortedTopEmployers.slice(0, 20),
        selected_top_n: [],
      },
    },
    topN
  );

  return {
    response: {
      ...payload,
      query_context: {
        source: "openfec_live_summary",
        candidate_id: candidateId,
        resolved_committee_id: committeeId,
        two_year_transaction_period: twoYearPeriodNumber,
        top_n: topN,
        sampled_top_donors: true,
        sampled_top_donor_rows: (topRowsData.results ?? []).length,
        employer_source: employerSource,
      },
    },
    resolvedCommitteeId: committeeId,
  };
}

function queueCandidateSummaryRefresh(
  executionCtx: ExecutionContext,
  env: Env["Bindings"],
  apiKey: string,
  candidateId: string,
  twoYearPeriod: string
): boolean {
  if (!hasSupabase(env)) return false;

  const twoYearPeriodNumber = Number(twoYearPeriod);
  const key = getSummaryRefreshKey(candidateId, twoYearPeriodNumber);
  const now = Date.now();
  const cooldownUntil = summaryRefreshCooldownUntil.get(key) ?? 0;
  if (summaryRefreshInFlight.has(key) || now < cooldownUntil) {
    return false;
  }

  summaryRefreshInFlight.add(key);
  summaryRefreshCooldownUntil.set(key, now + SUMMARY_REFRESH_MIN_INTERVAL_MS);

  executionCtx.waitUntil(
    (async () => {
      try {
        const sb = getSupabase(env);
        const { response, resolvedCommitteeId } =
          await buildCandidateContributionSummaryFromOpenFec(
            apiKey,
            candidateId,
            twoYearPeriod,
            20
          );
        const { query_context: _queryContext, ...payloadForCache } = response;

        const { error } = await sb.from("candidate_contribution_summaries").upsert(
          {
            candidate_id: candidateId,
            two_year_period: twoYearPeriodNumber,
            committee_id: resolvedCommitteeId,
            payload: payloadForCache,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "candidate_id,two_year_period" }
        );

        if (error) {
          throw new Error(`Failed to cache summary: ${error.message}`);
        }

        summaryRefreshCooldownUntil.set(
          key,
          Date.now() + SUMMARY_REFRESH_MIN_INTERVAL_MS
        );
      } catch (error) {
        console.error(
          `Background summary refresh failed for ${candidateId}`,
          error
        );
        summaryRefreshCooldownUntil.set(
          key,
          Date.now() + SUMMARY_REFRESH_FAILURE_COOLDOWN_MS
        );
      } finally {
        summaryRefreshInFlight.delete(key);
      }
    })()
  );

  return true;
}

function mapFecRowsToCacheRows(
  rows: FecContributionResult[],
  candidateId: string | null,
  fallbackCommitteeId: string | null,
  twoYearPeriod: string
): CachedContributionRow[] {
  return rows.map((r) => ({
    candidate_id: r.candidate_id ?? candidateId,
    committee_id: r.committee_id ?? fallbackCommitteeId ?? null,
    committee_name: r.committee?.name ?? null,
    recipient_name: deriveRecipientName(r),
    normalized_recipient_name: normalizeRecipientName(deriveRecipientName(r)),
    pdf_url: r.pdf_url ?? null,
    contributor_name: r.contributor_name ?? null,
    contributor_employer: r.contributor_employer ?? null,
    contributor_occupation: r.contributor_occupation ?? null,
    contributor_state: r.contributor_state ?? null,
    contribution_amount: r.contribution_receipt_amount ?? null,
    contribution_date: r.contribution_receipt_date ?? null,
    two_year_period: r.two_year_transaction_period ?? Number(twoYearPeriod),
  }));
}

function mapCachedRowsToApiRows(rows: Array<{
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
}>): FecContributionResult[] {
  return rows.map((r) => ({
    candidate_id: r.candidate_id ?? undefined,
    committee_id: r.committee_id ?? undefined,
    committee: { name: r.committee_name ?? undefined },
    recipient_name: r.recipient_name ?? undefined,
    contributor_name: r.contributor_name ?? undefined,
    contributor_employer: r.contributor_employer ?? undefined,
    contributor_occupation: r.contributor_occupation ?? undefined,
    contributor_state: r.contributor_state ?? undefined,
    contribution_receipt_amount: r.contribution_amount ?? undefined,
    contribution_receipt_date: r.contribution_date ?? undefined,
    two_year_transaction_period: r.two_year_period ?? undefined,
    pdf_url: r.pdf_url ?? undefined,
  }));
}

async function persistRecipientOrganizations(
  sb: ReturnType<typeof getSupabase>,
  rows: FecContributionResult[]
) {
  const uniqueRecipients = new Map<string, { committeeId: string | null; recipientName: string }>();

  for (const row of rows) {
    const recipientName = deriveRecipientName(row);
    if (!recipientName) continue;
    const key = `${row.committee_id ?? "no-committee"}:${recipientName}`;
    if (uniqueRecipients.has(key)) continue;
    uniqueRecipients.set(key, {
      committeeId: row.committee_id ?? null,
      recipientName,
    });
  }

  for (const recipient of uniqueRecipients.values()) {
    await ensureOrganization(sb, {
      canonicalName: recipient.recipientName,
      aliasSourceType: "openfec_recipient",
      aliasSourceRowId: recipient.committeeId ?? recipient.recipientName,
      identifiers: recipient.committeeId
        ? [
            {
              sourceType: "openfec_committee",
              identifierType: "committee_id",
              identifierValue: recipient.committeeId,
            },
          ]
        : [],
      sourceCoverage: {
        campaign_recipients: true,
        openfec_committees: true,
      },
    });
  }
}

async function enrichContributionResults(
  sb: ReturnType<typeof getSupabase>,
  rows: FecContributionResult[]
): Promise<FecContributionResult[]> {
  const candidateIds = [...new Set(rows.map((row) => row.candidate_id).filter((value): value is string => !!value))];
  const committeeIds = [...new Set(rows.map((row) => row.committee_id).filter((value): value is string => !!value))];

  const [candidateRowsResult, identifierRowsResult] = await Promise.all([
    candidateIds.length
      ? sb.from("fec_candidates").select("candidate_id,name").in("candidate_id", candidateIds)
      : Promise.resolve({ data: [], error: null }),
    committeeIds.length
      ? sb
          .from("organization_identifiers")
          .select("organization_id,identifier_value")
          .eq("source_type", "openfec_committee")
          .eq("identifier_type", "committee_id")
          .in("identifier_value", committeeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (candidateRowsResult.error) {
    throw new Error(`Failed to enrich contribution candidate names: ${candidateRowsResult.error.message}`);
  }

  if (identifierRowsResult.error) {
    throw new Error(`Failed to enrich contribution recipient identities: ${identifierRowsResult.error.message}`);
  }

  const candidateNameById = new Map(
    (candidateRowsResult.data ?? [])
      .filter((row) => typeof row.candidate_id === "string")
      .map((row) => [row.candidate_id, row.name ?? undefined] as const)
  );
  const organizationIdByCommitteeId = new Map(
    (identifierRowsResult.data ?? [])
      .filter(
        (row): row is { organization_id: number; identifier_value: string } =>
          typeof row.organization_id === "number" && typeof row.identifier_value === "string"
      )
      .map((row) => [row.identifier_value, row.organization_id] as const)
  );

  return rows.map((row) => {
    const candidateName = row.candidate_name ?? (
      row.candidate_id ? candidateNameById.get(row.candidate_id) : undefined
    );
    const recipientName = deriveRecipientName({
      ...row,
      candidate_name: candidateName ?? null,
    });

    return {
      ...row,
      candidate_name: candidateName,
      recipient_name: recipientName ?? undefined,
      recipient_organization_id: row.committee_id
        ? organizationIdByCommitteeId.get(row.committee_id)
        : undefined,
    };
  });
}

async function resolveRecipientSearchTargets(
  sb: ReturnType<typeof getSupabase>,
  recipientQuery: string
) {
  const normalizedQuery = normalizeRecipientName(recipientQuery);

  const [candidateRowsResult, aliasRowsResult] = await Promise.all([
    sb
      .from("fec_candidates")
      .select("candidate_id")
      .ilike("name", `%${recipientQuery}%`)
      .limit(10),
    normalizedQuery
      ? sb
          .from("organization_aliases")
          .select("organization_id")
          .ilike("normalized_alias", `%${normalizedQuery}%`)
          .limit(10)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (candidateRowsResult.error) {
    throw new Error(`Failed to resolve candidate recipient targets: ${candidateRowsResult.error.message}`);
  }

  if (aliasRowsResult.error) {
    throw new Error(`Failed to resolve committee recipient targets: ${aliasRowsResult.error.message}`);
  }

  const organizationIds = [
    ...new Set(
      (aliasRowsResult.data ?? [])
        .map((row) => row.organization_id)
        .filter((value): value is number => typeof value === "number")
    ),
  ];

  const identifierRowsResult = organizationIds.length
    ? await sb
        .from("organization_identifiers")
        .select("identifier_value")
        .eq("source_type", "openfec_committee")
        .eq("identifier_type", "committee_id")
        .in("organization_id", organizationIds)
    : { data: [], error: null };

  if (identifierRowsResult.error) {
    throw new Error(`Failed to load committee recipient targets: ${identifierRowsResult.error.message}`);
  }

  return {
    normalizedQuery,
    candidateIds: [
      ...new Set(
        (candidateRowsResult.data ?? [])
          .map((row) => row.candidate_id)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      ),
    ],
    committeeIds: [
      ...new Set(
        (identifierRowsResult.data ?? [])
          .map((row) => row.identifier_value)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      ),
    ],
  };
}

// ── GET /api/fec/candidates ──────────────────────────────────────────────────
// Search for FEC candidates
openfec.get("/candidates", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const params: Record<string, string> = {
    per_page: c.req.query("limit") ?? "20",
    page: c.req.query("page") ?? "1",
    sort: "-election_years",
  };

  const q = c.req.query("q");
  if (q) params["q"] = q;

  const state = c.req.query("state");
  if (state) params["state"] = state;

  const party = c.req.query("party");
  if (party) params["party"] = party;

  const office = c.req.query("office");
  if (office) params["office"] = office;

  try {
    const resp = await fecFetch("/candidates/search/", apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `FEC API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      results?: Array<{
        candidate_id?: string;
        name?: string;
        party_full?: string;
        party?: string;
        state?: string;
        office_full?: string;
        office?: string;
        election_years?: number[];
        [key: string]: unknown;
      }>;
    };

    // Cache candidates to Supabase in the background
    if (hasSupabase(c.env) && data.results?.length) {
      const sb = getSupabase(c.env);
      const rows = data.results
        .filter((r) => r.candidate_id)
        .map((r) => ({
          candidate_id: r.candidate_id!,
          name: r.name ?? null,
          party: r.party_full ?? r.party ?? null,
          state: r.state ?? null,
          office: r.office ?? r.office_full?.charAt(0) ?? null,
          election_years: r.election_years ?? null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("fec_candidates").upsert(rows, { onConflict: "candidate_id" }))
      );
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
  }
});

// ── GET /api/fec/candidates/:candidateId ─────────────────────────────────────
openfec.get("/candidates/:candidateId", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const candidateId = c.req.param("candidateId");

  try {
    const resp = await fecFetch(`/candidate/${candidateId}/`, apiKey);
    if (!resp.ok) {
      return c.json({ error: `FEC API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
  }
});

// ── GET /api/fec/contributions ───────────────────────────────────────────────
// Search individual contributions (Schedule A)
openfec.get("/contributions", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const sortQuery = c.req.query("sort");
  const sort = sortQuery === "amount_asc"
    ? "contribution_receipt_amount"
    : sortQuery === "amount_desc"
      ? "-contribution_receipt_amount"
      : sortQuery === "date_asc"
        ? "contribution_receipt_date"
        : "-contribution_receipt_date";
  const includeRefunds = c.req.query("include_refunds") === "true";

  const requestedPage = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const requestedPerPage = Math.max(1, Math.min(Number(c.req.query("limit") ?? "20") || 20, 100));

  const params: Record<string, string> = {
    per_page: String(requestedPerPage),
    sort,
    is_individual: "true",
  };

  const candidateId = c.req.query("candidate_id");
  const recipientName = c.req.query("recipient_name")?.trim() ?? "";
  const twoYearPeriod = c.req.query("two_year_period") ?? defaultTwoYearPeriod();
  params["two_year_transaction_period"] = twoYearPeriod;

  // Candidate drill-down path: use Supabase cache with a max daily refresh.
  if (candidateId && hasSupabase(c.env)) {
    const sb = getSupabase(c.env);
    const limit = Math.max(1, Math.min(Number(params.per_page) || 20, 100));
    const page = requestedPage;
    const ascending = sort === "contribution_receipt_amount" || sort === "contribution_receipt_date";
    const sortColumn = sort.includes("amount") ? "contribution_amount" : "contribution_date";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let cacheQuery = sb
      .from("contributions")
      .select("candidate_id, committee_id, committee_name, recipient_name, normalized_recipient_name, pdf_url, contributor_name, contributor_employer, contributor_occupation, contributor_state, contribution_amount, contribution_date, two_year_period", { count: "exact" })
      .eq("candidate_id", candidateId);

    if (recipientName) {
      const normalizedRecipientName = normalizeRecipientName(recipientName);
      if (normalizedRecipientName) {
        cacheQuery = cacheQuery.ilike("normalized_recipient_name", `%${normalizedRecipientName}%`);
      } else {
        cacheQuery = cacheQuery.ilike("recipient_name", `%${recipientName}%`);
      }
    }

    if (!includeRefunds) {
      cacheQuery = cacheQuery.gt("contribution_amount", 0);
    }

    const [{ data: latestRow, error: latestError }, { data: cachedRows, count, error: queryError }] =
      await Promise.all([
        sb
          .from("contributions")
          .select("updated_at")
          .eq("candidate_id", candidateId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        cacheQuery
          .order(sortColumn, { ascending, nullsFirst: false })
          .range(from, to),
      ]);

    if (queryError) {
      return c.json({ error: `Failed to query cached contributions: ${queryError.message}` }, 500);
    }

    if (latestError) {
      console.warn(`Unable to read contribution freshness for ${candidateId}: ${latestError.message}`);
    }

    const latestUpdatedAt = latestRow?.updated_at ? new Date(latestRow.updated_at) : null;
    const isStale =
      !latestUpdatedAt ||
      Number.isNaN(latestUpdatedAt.getTime()) ||
      Date.now() - latestUpdatedAt.getTime() > CONTRIBUTIONS_CACHE_STALE_MS;
    const hasCachedRows = (cachedRows?.length ?? 0) > 0;
    const totalCount = count ?? 0;
    const pages = limit > 0 ? Math.max(1, Math.ceil(totalCount / limit)) : 1;

    if (hasCachedRows) {
      const results = await enrichContributionResults(
        sb,
        mapCachedRowsToApiRows(cachedRows ?? [])
      );
      return c.json({
        results,
        pagination: {
          count: totalCount,
          page,
          pages,
        },
        query_context: {
          source: "supabase_cache",
          pagination_mode: "offset",
          candidate_id: candidateId,
          recipient_name: recipientName || null,
          page,
          per_page: limit,
          sort,
          stale: isStale,
          refresh_queued: false,
        },
      }, 200, { "Cache-Control": "public, max-age=300" });
    }

    const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId, twoYearPeriod);

    try {
      const liveParams: Record<string, string> = {
        candidate_id: candidateId,
        per_page: String(limit),
        page: String(page),
        sort,
        is_individual: "true",
        two_year_transaction_period: twoYearPeriod,
      };
      if (committeeId) {
        liveParams["committee_id"] = committeeId;
      }

      const liveResp = await fecFetch("/schedules/schedule_a/", apiKey, liveParams);

      if (!liveResp.ok) {
        const upstreamDetail = await readFecErrorDetails(liveResp);
        return c.json({
          error: `FEC API ${liveResp.status}${upstreamDetail ? `: ${upstreamDetail}` : ""}`,
          detail: upstreamDetail,
          query: {
            candidate_id: candidateId,
            committee_id: committeeId,
            page,
            per_page: limit,
            sort,
            two_year_transaction_period: twoYearPeriod,
          },
        }, 502);
      }

      const liveData = (await liveResp.json()) as {
        results?: FecContributionResult[];
        pagination?: { count?: number; page?: number; pages?: number; last_indexes?: Record<string, string | number> };
      };

      const normalizedLivePagination = {
        ...(liveData.pagination ?? {}),
        page,
      };

      if (liveData.results?.length) {
        const rows = mapFecRowsToCacheRows(
          liveData.results,
          candidateId,
          committeeId,
          twoYearPeriod
        );
        const enrichedLiveResults = await enrichContributionResults(sb, liveData.results);
        c.executionCtx.waitUntil(
          Promise.all([
            Promise.resolve(sb.from("contributions").insert(rows)),
            persistRecipientOrganizations(sb, enrichedLiveResults),
          ])
        );
        liveData.results = enrichedLiveResults;
      }

      return c.json({
        ...liveData,
        pagination: normalizedLivePagination,
        query_context: {
          source: "openfec_live",
          pagination_mode: "offset",
          candidate_id: candidateId,
          resolved_committee_id: committeeId ?? null,
          recipient_name: recipientName || null,
          page,
          per_page: limit,
          sort,
          cache_refresh_queued: false,
        },
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof FecTimeoutError) {
        return c.json({
          error: "OpenFEC request timed out",
          detail: "Candidate contribution lookup took too long; try again shortly.",
        }, 504);
      }
      return c.json({ error: "Failed to fetch from FEC API" }, 502);
    }
  }

  const endpoint = "/schedules/schedule_a/";

  if (candidateId) {
    params["candidate_id"] = candidateId;
    const committeeIdForCandidate = await resolveCandidateCommitteeId(apiKey, candidateId, twoYearPeriod);
    if (committeeIdForCandidate) {
      params["committee_id"] = committeeIdForCandidate;
    }
  }

  const committeeId = c.req.query("committee_id");
  if (committeeId) params["committee_id"] = committeeId;

  const employer = c.req.query("employer");
  if (employer) params["contributor_employer"] = employer;

  const contributorName = c.req.query("contributor_name");
  if (contributorName) params["contributor_name"] = contributorName;

  const minAmount = c.req.query("min_amount");
  if (minAmount) {
    const parsedMinAmount = Number(minAmount);
    if (Number.isFinite(parsedMinAmount)) {
      params["min_amount"] = String(includeRefunds ? parsedMinAmount : Math.max(parsedMinAmount, 0.01));
    } else {
      params["min_amount"] = minAmount;
    }
  } else if (!includeRefunds) {
    params["min_amount"] = "0.01";
  }

  const maxAmount = c.req.query("max_amount");
  if (maxAmount) params["max_amount"] = maxAmount;

  const minDate = c.req.query("min_date");
  if (minDate) params["min_date"] = minDate;

  const maxDate = c.req.query("max_date");
  if (maxDate) params["max_date"] = maxDate;

  const state = c.req.query("state");
  if (state) params["contributor_state"] = state;

  let recipientSearchResolution:
    | { mode: "cache_only"; candidate_ids: string[]; committee_ids: string[] }
    | { mode: "live_candidate"; candidate_id: string }
    | { mode: "live_committee"; committee_id: string }
    | null = null;

  if (recipientName && hasSupabase(c.env)) {
    const sb = getSupabase(c.env);
    const limit = requestedPerPage;
    const page = requestedPage;
    const ascending = sort === "contribution_receipt_amount" || sort === "contribution_receipt_date";
    const sortColumn = sort.includes("amount") ? "contribution_amount" : "contribution_date";
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const resolvedTargets = await resolveRecipientSearchTargets(sb, recipientName);

    let cacheQuery = sb
      .from("contributions")
      .select("candidate_id, committee_id, committee_name, recipient_name, normalized_recipient_name, pdf_url, contributor_name, contributor_employer, contributor_occupation, contributor_state, contribution_amount, contribution_date, two_year_period", { count: "exact" });

    if (!includeRefunds) {
      cacheQuery = cacheQuery.gt("contribution_amount", 0);
    }
    if (employer) cacheQuery = cacheQuery.ilike("contributor_employer", `%${employer}%`);
    if (contributorName) cacheQuery = cacheQuery.ilike("contributor_name", `%${contributorName}%`);
    if (minAmount) {
      const parsedMinAmount = Number(minAmount);
      if (Number.isFinite(parsedMinAmount)) {
        cacheQuery = cacheQuery.gte("contribution_amount", includeRefunds ? parsedMinAmount : Math.max(parsedMinAmount, 0.01));
      }
    }
    if (maxAmount) {
      const parsedMaxAmount = Number(maxAmount);
      if (Number.isFinite(parsedMaxAmount)) cacheQuery = cacheQuery.lte("contribution_amount", parsedMaxAmount);
    }
    if (state) cacheQuery = cacheQuery.eq("contributor_state", state);

    const recipientClauses: string[] = [];
    if (resolvedTargets.normalizedQuery) {
      recipientClauses.push(`normalized_recipient_name.ilike.%${resolvedTargets.normalizedQuery}%`);
    }
    if (resolvedTargets.candidateIds.length) {
      recipientClauses.push(`candidate_id.in.(${resolvedTargets.candidateIds.join(",")})`);
    }
    if (resolvedTargets.committeeIds.length) {
      recipientClauses.push(`committee_id.in.(${resolvedTargets.committeeIds.join(",")})`);
    }

    if (recipientClauses.length) {
      cacheQuery = cacheQuery.or(recipientClauses.join(","));
    } else {
      cacheQuery = cacheQuery.ilike("recipient_name", `%${recipientName}%`);
    }

    const { data: cachedRows, count, error: cacheError } = await cacheQuery
      .order(sortColumn, { ascending, nullsFirst: false })
      .range(from, to);

    if (cacheError) {
      return c.json({ error: `Failed to query cached contributions: ${cacheError.message}` }, 500);
    }

    if ((cachedRows?.length ?? 0) > 0) {
      const totalCount = count ?? 0;
      const pages = limit > 0 ? Math.max(1, Math.ceil(totalCount / limit)) : 1;
      const results = await enrichContributionResults(
        sb,
        mapCachedRowsToApiRows(cachedRows ?? [])
      );
      return c.json({
        results,
        pagination: {
          count: totalCount,
          page,
          pages,
        },
        query_context: {
          source: "supabase_cache",
          pagination_mode: "offset",
          recipient_name: recipientName,
          page,
          per_page: limit,
          sort,
          resolved_candidate_ids: resolvedTargets.candidateIds,
          resolved_committee_ids: resolvedTargets.committeeIds,
        },
      }, 200, { "Cache-Control": "public, max-age=300" });
    }

    if (resolvedTargets.committeeIds.length === 1) {
      params["committee_id"] = resolvedTargets.committeeIds[0];
      recipientSearchResolution = {
        mode: "live_committee",
        committee_id: resolvedTargets.committeeIds[0],
      };
    } else if (resolvedTargets.candidateIds.length === 1) {
      params["candidate_id"] = resolvedTargets.candidateIds[0];
      recipientSearchResolution = {
        mode: "live_candidate",
        candidate_id: resolvedTargets.candidateIds[0],
      };
    } else {
      recipientSearchResolution = {
        mode: "cache_only",
        candidate_ids: resolvedTargets.candidateIds,
        committee_ids: resolvedTargets.committeeIds,
      };
      return c.json({
        results: [],
        pagination: {
          count: 0,
          page,
          pages: 1,
        },
        query_context: {
          source: "recipient_search_unresolved_live_filter",
          pagination_mode: "offset",
          recipient_name: recipientName,
          page,
          per_page: limit,
          sort,
          resolved_candidate_ids: resolvedTargets.candidateIds,
          resolved_committee_ids: resolvedTargets.committeeIds,
        },
      }, 200, { "Cache-Control": "no-store" });
    }
  }

  // OpenFEC schedule_a uses keyset pagination via `last_indexes`.
  const cursorKeys = [
    "last_index",
    "last_contribution_receipt_amount",
    "last_contribution_receipt_date",
    "sort_null_only",
  ] as const;
  for (const key of cursorKeys) {
    const value = c.req.query(key);
    if (value) params[key] = value;
  }

  try {
    let resp: Response;
    let sortApplied = params["sort"];
    let fallbackSortApplied = false;

    try {
      resp = await fecFetch(endpoint, apiKey, params);
    } catch (error) {
      const shouldRetryWithDateSort =
        error instanceof FecTimeoutError &&
        !candidateId &&
        !committeeId &&
        sortApplied.includes("contribution_receipt_amount");

      if (!shouldRetryWithDateSort) {
        throw error;
      }

      params["sort"] = "-contribution_receipt_date";
      sortApplied = params["sort"];
      fallbackSortApplied = true;
      resp = await fecFetch(endpoint, apiKey, params);
    }

    if (!resp.ok) {
      const upstreamDetail = await readFecErrorDetails(resp);
      const debugParams = Object.fromEntries(
        Object.entries(params).filter(([key]) =>
          [
            "candidate_id",
            "committee_id",
            "per_page",
            "sort",
            "two_year_transaction_period",
            "last_index",
            "last_contribution_receipt_amount",
            "last_contribution_receipt_date",
            "sort_null_only",
          ].includes(key)
        )
      );

      const detail = [
        `OpenFEC status ${resp.status}`,
        upstreamDetail ? `upstream: ${upstreamDetail}` : null,
        `query: ${JSON.stringify(debugParams)}`,
      ]
        .filter(Boolean)
        .join(" | ");

      return c.json(
        {
          error: `FEC API ${resp.status}${upstreamDetail ? `: ${upstreamDetail}` : ""}`,
          detail,
          upstream_status: resp.status,
          upstream_error: upstreamDetail,
          query: debugParams,
        },
        502
      );
    }
    const data = (await resp.json()) as {
      results?: Array<{
        candidate_id?: string;
        candidate_name?: string;
        committee_id?: string;
        committee?: { name?: string };
        recipient_name?: string;
        contributor_name?: string;
        contributor_employer?: string;
        contributor_occupation?: string;
        contributor_state?: string;
        contribution_receipt_amount?: number;
        contribution_receipt_date?: string;
        two_year_transaction_period?: number;
        pdf_url?: string;
        [key: string]: unknown;
      }>;
      pagination?: {
        count?: number;
        page?: number;
        pages?: number;
        last_indexes?: Record<string, string | number>;
      };
    };

    const normalizedPagination = {
      ...(data.pagination ?? {}),
      page: requestedPage,
      pages: data.pagination?.pages ?? (
        data.pagination?.count && requestedPerPage > 0
          ? Math.max(1, Math.ceil(data.pagination.count / requestedPerPage))
          : undefined
      ),
    };

    // Cache contributions to Supabase in the background
    if (hasSupabase(c.env) && data.results?.length) {
      const sb = getSupabase(c.env);
      const enrichedResults = await enrichContributionResults(sb, data.results);
      const rows = mapFecRowsToCacheRows(
        enrichedResults,
        candidateId ?? null,
        params["committee_id"] ?? null,
        twoYearPeriod
      );
      c.executionCtx.waitUntil(
        Promise.all([
          Promise.resolve(sb.from("contributions").insert(rows)),
          persistRecipientOrganizations(sb, enrichedResults),
        ])
      );
      data.results = enrichedResults;
    }

    return c.json({
      ...data,
      pagination: normalizedPagination,
      query_context: {
        source: "openfec_live",
        pagination_mode: "cursor",
        candidate_id: candidateId ?? null,
        committee_id: params["committee_id"] ?? null,
        recipient_name: recipientName || null,
        include_refunds: includeRefunds,
        page: requestedPage,
        per_page: requestedPerPage,
        sort_requested: sort,
        sort_applied: sortApplied,
        fallback_sort_applied: fallbackSortApplied,
        next_cursor: data.pagination?.last_indexes ?? null,
        recipient_search_resolution: recipientSearchResolution,
      },
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    if (error instanceof FecTimeoutError) {
      return c.json({
        error: "OpenFEC request timed out",
        detail: "The contribution search took too long. Try narrowing filters or retry shortly.",
      }, 504);
    }
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
  }
});

// ── GET /api/fec/candidates/:candidateId/summary ─────────────────────────────
// Fast candidate summary using OpenFEC aggregates + top/bottom donation probes.
openfec.get("/candidates/:candidateId/summary", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const candidateId = c.req.param("candidateId");
  const twoYearPeriod = c.req.query("two_year_period") ?? defaultTwoYearPeriod();
  const topN = normalizeSummaryTopN(Number(c.req.query("top_n") ?? "10"));
  const twoYearPeriodNumber = Number(twoYearPeriod);

  if (hasSupabase(c.env)) {
    const sb = getSupabase(c.env);
    const { data: cachedRow, error: cacheError } = await sb
      .from("candidate_contribution_summaries")
      .select("candidate_id, two_year_period, committee_id, payload, updated_at")
      .eq("candidate_id", candidateId)
      .eq("two_year_period", twoYearPeriodNumber)
      .maybeSingle<CandidateSummaryCacheRow>();

    if (!cacheError && cachedRow?.payload) {
      const normalizedPayload = normalizeCachedCandidateSummaryPayload(
        cachedRow.payload,
        candidateId,
        twoYearPeriodNumber
      );

      if (normalizedPayload) {
        const cacheIncomplete = isIncompleteCandidateSummaryPayload(normalizedPayload);
        const updatedAt = cachedRow.updated_at ? new Date(cachedRow.updated_at) : null;
        if (cacheIncomplete) {
          const refreshQueued = queueCandidateSummaryRefresh(
            c.executionCtx,
            c.env,
            apiKey,
            candidateId,
            twoYearPeriod
          );

          try {
            const { response, resolvedCommitteeId } =
              await buildCandidateContributionSummaryFromOpenFec(
                apiKey,
                candidateId,
                twoYearPeriod,
                topN
              );

            const { query_context: _queryContext, ...payloadForCache } = response;
            const { error: cacheWriteError } = await sb
              .from("candidate_contribution_summaries")
              .upsert(
                {
                  candidate_id: candidateId,
                  two_year_period: twoYearPeriodNumber,
                  committee_id: resolvedCommitteeId,
                  payload: payloadForCache,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "candidate_id,two_year_period" }
              );
            if (cacheWriteError) {
              console.warn(
                `Failed to repair summary cache for ${candidateId}: ${cacheWriteError.message}`
              );
            }

            return c.json(
              {
                ...response,
                query_context: {
                  ...response.query_context,
                  cache_hit: false,
                  cache_repaired: true,
                  cache_previous_updated_at: cachedRow.updated_at ?? null,
                  background_refresh_queued: refreshQueued,
                },
              },
              200,
              { "Cache-Control": "public, max-age=300" }
            );
          } catch (error) {
            const payloadWithTopN = applyTopNToSummaryPayload(normalizedPayload, topN);
            return c.json(
              {
                ...payloadWithTopN,
                query_context: {
                  source: "supabase_summary_cache",
                  candidate_id: candidateId,
                  resolved_committee_id: cachedRow.committee_id ?? null,
                  two_year_transaction_period: twoYearPeriodNumber,
                  top_n: topN,
                  cache_hit: true,
                  cache_incomplete: true,
                  stale: true,
                  refresh_queued: refreshQueued,
                  cache_updated_at: cachedRow.updated_at ?? null,
                  live_refresh_error:
                    error instanceof Error ? error.message : String(error),
                },
              },
              200,
              { "Cache-Control": "no-store" }
            );
          }
        }

        const staleThreshold = normalizedPayload.summary_pending
          ? SUMMARY_PENDING_CACHE_STALE_MS
          : SUMMARY_CACHE_STALE_MS;
        const isStale =
          !updatedAt ||
          Number.isNaN(updatedAt.getTime()) ||
          Date.now() - updatedAt.getTime() > staleThreshold;
        const refreshQueued = isStale
          ? queueCandidateSummaryRefresh(
              c.executionCtx,
              c.env,
              apiKey,
              candidateId,
              twoYearPeriod
            )
          : false;
        const payloadWithTopN = applyTopNToSummaryPayload(normalizedPayload, topN);

        return c.json(
          {
            ...payloadWithTopN,
            query_context: {
              source: "supabase_summary_cache",
              candidate_id: candidateId,
              resolved_committee_id: cachedRow.committee_id ?? null,
              two_year_transaction_period: twoYearPeriodNumber,
              top_n: topN,
              cache_hit: true,
              cache_incomplete: cacheIncomplete,
              stale: isStale,
              refresh_queued: refreshQueued,
              cache_updated_at: cachedRow.updated_at ?? null,
            },
          },
          200,
          { "Cache-Control": "public, max-age=300" }
        );
      }
    }

    if (cacheError) {
      console.warn(
        `Failed to read summary cache for ${candidateId}: ${cacheError.message}`
      );
    } else {
      try {
        const { response, resolvedCommitteeId } =
          await buildCandidateContributionSummaryFromOpenFec(
            apiKey,
            candidateId,
            twoYearPeriod,
            topN
          );
        const { query_context: _queryContext, ...payloadForCache } = response;
        const { error: cacheWriteError } = await sb
          .from("candidate_contribution_summaries")
          .upsert(
            {
              candidate_id: candidateId,
              two_year_period: twoYearPeriodNumber,
              committee_id: resolvedCommitteeId,
              payload: payloadForCache,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "candidate_id,two_year_period" }
          );
        if (cacheWriteError) {
          console.warn(
            `Failed to cache newly built summary for ${candidateId}: ${cacheWriteError.message}`
          );
        }

        return c.json(
          {
            ...response,
            query_context: {
              ...response.query_context,
              cache_hit: false,
              cache_warmup: true,
            },
          },
          200,
          { "Cache-Control": "public, max-age=300" }
        );
      } catch (error) {
        console.warn(
          `Inline summary build failed for ${candidateId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const refreshQueued = queueCandidateSummaryRefresh(
        c.executionCtx,
        c.env,
        apiKey,
        candidateId,
        twoYearPeriod
      );
      const pendingPayload = applyTopNToSummaryPayload(
        createPendingCandidateSummaryPayload(
          candidateId,
          twoYearPeriodNumber,
          "Summary is being prepared. Please refresh in a moment."
        ),
        topN
      );
      return c.json(
        {
          ...pendingPayload,
          query_context: {
            source: "supabase_summary_cache",
            candidate_id: candidateId,
            resolved_committee_id: null,
            two_year_transaction_period: twoYearPeriodNumber,
            top_n: topN,
            cache_hit: false,
            stale: true,
            refresh_queued: refreshQueued,
          },
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }
  }

  try {
    const { response } = await buildCandidateContributionSummaryFromOpenFec(
      apiKey,
      candidateId,
      twoYearPeriod,
      topN
    );
    return c.json(response, 200, { "Cache-Control": "public, max-age=300" });
  } catch (error) {
    if (error instanceof FecTimeoutError) {
      return c.json(
        {
          error: "OpenFEC request timed out",
          detail: "Summary query timed out upstream. Please retry shortly.",
        },
        504
      );
    }
    if (error instanceof FecUpstreamError) {
      return c.json(
        {
          error: error.message,
          detail: error.detail ?? `status=${error.status}`,
        },
        502
      );
    }
    return c.json({ error: "Failed to build candidate contribution summary" }, 502);
  }
});

// ── GET /api/fec/committees ──────────────────────────────────────────────────
openfec.get("/committees", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const params: Record<string, string> = {
    per_page: c.req.query("limit") ?? "20",
    page: c.req.query("page") ?? "1",
  };

  const q = c.req.query("q");
  if (q) params["q"] = q;

  const candidateId = c.req.query("candidate_id");
  if (candidateId) params["candidate_id"] = candidateId;

  try {
    const resp = await fecFetch("/committees/", apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `FEC API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
  }
});

// ── GET /api/fec/independent-expenditures ────────────────────────────────────
openfec.get("/independent-expenditures", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);

  const params: Record<string, string> = {
    per_page: c.req.query("limit") ?? "20",
    page: c.req.query("page") ?? "1",
    sort: "-expenditure_date",
  };

  const candidateId = c.req.query("candidate_id");
  if (candidateId) params["candidate_id"] = candidateId;

  const minDate = c.req.query("min_date");
  if (minDate) params["min_date"] = minDate;

  const maxDate = c.req.query("max_date");
  if (maxDate) params["max_date"] = maxDate;

  try {
    const resp = await fecFetch("/schedules/schedule_e/", apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `FEC API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
  }
});

// ── GET /api/fec/link/:bioguideId ─────────────────────────────────────────────
// Find FEC candidates matching a Congress member and link them in Supabase
openfec.get("/link/:bioguideId", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);
  if (!hasSupabase(c.env)) return c.json({ error: "Supabase not configured" }, 503);

  const bioguideId = c.req.param("bioguideId");
  const sb = getSupabase(c.env);

  // Check if already linked
  const { data: existing } = await sb
    .from("fec_candidates")
    .select("*")
    .eq("bioguide_id", bioguideId);

  if (existing && existing.length > 0) {
    return c.json({ bioguide_id: bioguideId, fec_candidates: existing, source: "cache" });
  }

  // Look up the member to get name/state for FEC search
  const { data: member } = await sb
    .from("members")
    .select("name, state, district")
    .eq("bioguide_id", bioguideId)
    .single();

  if (!member) {
    return c.json({ error: "Member not found in database" }, 404);
  }

  // Search FEC by name + state. Congress.gov stores names as "Last, First"
  // but FEC search works best with simpler queries, so try full name first
  // then fall back to last name only.
  const searchParams: Record<string, string> = {
    q: member.name,
    per_page: "5",
  };
  if (member.state) searchParams["state"] = member.state;
  if (member.district != null) {
    searchParams["office"] = "H";
  } else {
    // Senators don't have a district
    searchParams["office"] = "S";
  }

  let candidates: Array<{
    candidate_id?: string;
    name?: string;
    party_full?: string;
    party?: string;
    state?: string;
    office?: string;
    election_years?: number[];
  }> = [];

  try {
    const resp = await fecFetch("/candidates/search/", apiKey, searchParams);
    if (resp.ok) {
      const data = (await resp.json()) as { results?: typeof candidates };
      candidates = (data.results ?? []).filter((r) => r.candidate_id);
    }

    // If no results, try with just last name (before the comma)
    if (candidates.length === 0) {
      const lastName = member.name?.split(",")[0]?.trim();
      if (lastName && lastName !== member.name) {
        const retryParams = { ...searchParams, q: lastName };
        const resp2 = await fecFetch("/candidates/search/", apiKey, retryParams);
        if (resp2.ok) {
          const data2 = (await resp2.json()) as { results?: typeof candidates };
          candidates = (data2.results ?? []).filter((r) => r.candidate_id);
        }
      }
    }
  } catch {
    return c.json({ error: "Failed to search FEC API" }, 502);
  }

  try {

    // Link all matching candidates to this bioguide_id
    if (candidates.length > 0) {
      const rows = candidates.map((r) => ({
        candidate_id: r.candidate_id!,
        bioguide_id: bioguideId,
        name: r.name ?? null,
        party: r.party_full ?? r.party ?? null,
        state: r.state ?? null,
        office: r.office ?? null,
        election_years: r.election_years ?? null,
      }));
      await sb.from("fec_candidates").upsert(rows, { onConflict: "candidate_id" });
    }

    return c.json({
      bioguide_id: bioguideId,
      fec_candidates: candidates,
      source: "fec_api",
      count: candidates.length,
    });
  } catch {
    return c.json({ error: "Failed to search FEC API" }, 502);
  }
});

// ── GET /api/fec/member/:bioguideId/contributions ────────────────────────────
// Fetch and cache contributions for a Congress member (via their FEC candidate IDs)
openfec.get("/member/:bioguideId/contributions", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);
  if (!hasSupabase(c.env)) return c.json({ error: "Supabase not configured" }, 503);

  const bioguideId = c.req.param("bioguideId");
  const sb = getSupabase(c.env);

  // Get FEC candidate IDs for this member
  const { data: fecCandidates } = await sb
    .from("fec_candidates")
    .select("candidate_id")
    .eq("bioguide_id", bioguideId);

  if (!fecCandidates || fecCandidates.length === 0) {
    return c.json({
      error: "No FEC candidates linked. Call /api/fec/link/:bioguideId first.",
    }, 404);
  }

  const candidateIds = fecCandidates.map((r) => r.candidate_id);

  // Check Supabase cache first
  const { data: cached } = await sb
    .from("contributions")
    .select("*")
    .in("candidate_id", candidateIds)
    .order("contribution_amount", { ascending: false })
    .limit(100);

  if (cached && cached.length > 0) {
    return c.json({
      bioguide_id: bioguideId,
      contributions: cached,
      count: cached.length,
      source: "cache",
    }, 200, { "Cache-Control": "public, max-age=1800" });
  }

  // Fetch from FEC API for each candidate
  const allContributions: Array<Record<string, unknown>> = [];

  for (const candidateId of candidateIds.slice(0, 3)) {
    try {
      const committeeId = await resolveCandidateCommitteeId(
        apiKey,
        candidateId,
        defaultTwoYearPeriod()
      );
      if (!committeeId) continue;

      const resp = await fecFetch("/schedules/schedule_a/", apiKey, {
        committee_id: committeeId,
        per_page: "50",
        sort: "-contribution_receipt_amount",
        is_individual: "true",
        two_year_transaction_period: defaultTwoYearPeriod(),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{
            candidate_id?: string;
            committee_id?: string;
            committee?: { name?: string };
            contributor_name?: string;
            contributor_employer?: string;
            contributor_occupation?: string;
            contributor_state?: string;
            contribution_receipt_amount?: number;
            contribution_receipt_date?: string;
            two_year_transaction_period?: number;
          }>;
        };
        if (data.results) {
          allContributions.push(...data.results);
        }
      }
    } catch {
      // Skip failed fetches for individual candidates
    }
  }

  // Cache to Supabase
  if (allContributions.length > 0) {
    const rows = allContributions
      .filter((r) => r.candidate_id || r.committee_id)
      .map((r) => ({
        candidate_id: (r.candidate_id as string) ?? null,
        committee_id: (r.committee_id as string) ?? null,
        committee_name: (r.committee as { name?: string })?.name ?? null,
        contributor_name: (r.contributor_name as string) ?? null,
        contributor_employer: (r.contributor_employer as string) ?? null,
        contributor_occupation: (r.contributor_occupation as string) ?? null,
        contributor_state: (r.contributor_state as string) ?? null,
        contribution_amount: (r.contribution_receipt_amount as number) ?? null,
        contribution_date: (r.contribution_receipt_date as string) ?? null,
        two_year_period: (r.two_year_transaction_period as number) ?? null,
      }));
    c.executionCtx.waitUntil(
      Promise.resolve(sb.from("contributions").insert(rows))
    );
  }

  return c.json({
    bioguide_id: bioguideId,
    contributions: allContributions,
    count: allContributions.length,
    source: "fec_api",
  }, 200, { "Cache-Control": "public, max-age=1800" });
});

export { openfec };
