import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";

const openfec = new Hono<Env>();

const BASE = "https://api.open.fec.gov/v1";
const FEC_FETCH_TIMEOUT_MS = 12_000;
const FEC_BACKGROUND_FETCH_TIMEOUT_MS = 30_000;
const CONTRIBUTIONS_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_REFRESH_PER_PAGE = 25;
const CANDIDATE_REFRESH_MAX_PAGES = 100;
const SUMMARY_REFRESH_DEBOUNCE_MS = 2 * 60 * 1000;
const summaryRefreshLocks = new Map<string, number>();

class FecTimeoutError extends Error {
  constructor(message = "OpenFEC request timed out") {
    super(message);
    this.name = "FecTimeoutError";
  }
}

interface FecContributionResult {
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
}

interface CachedContributionRow {
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
}

interface FecScheduleAPagination {
  count?: number;
  page?: number;
  pages?: number;
  last_indexes?: Record<string, string | number>;
}

interface CachedContributionSummaryRow {
  contributor_name: string | null;
  contributor_employer: string | null;
  contribution_amount: number | null;
  contribution_date: string | null;
  committee_name: string | null;
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
  candidateId: string
): Promise<string | null> {
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
        candidate_status?: string;
        [key: string]: unknown;
      }>;
    };
    const candidate = candidateData.results?.[0];
    const firstAuthorized = candidate?.principal_committees?.find((committee) =>
      typeof committee.committee_id === "string" && committee.committee_id.length > 0
    );
    if (firstAuthorized?.committee_id) return firstAuthorized.committee_id;

    // Fallback for candidates missing principal committees in this endpoint.
    const committeesResp = await fecFetch(
      `/candidate/${candidateId}/committees/`,
      apiKey,
      {
        per_page: "20",
        sort: "-cycle",
      },
      FEC_BACKGROUND_FETCH_TIMEOUT_MS
    );
    if (!committeesResp.ok) return null;

    const committeesData = (await committeesResp.json()) as {
      results?: Array<{
        committee_id?: string;
        designation?: string;
      }>;
    };

    const preferredCommittee = committeesData.results?.find(
      (committee) =>
        typeof committee.committee_id === "string" &&
        committee.committee_id.length > 0 &&
        (committee.designation === "P" || committee.designation === "A")
    );

    if (preferredCommittee?.committee_id) return preferredCommittee.committee_id;

    const firstCommittee = committeesData.results?.find(
      (committee) => typeof committee.committee_id === "string" && committee.committee_id.length > 0
    );

    return firstCommittee?.committee_id ?? null;
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

function mapFecRowsToCacheRows(
  rows: FecContributionResult[],
  candidateId: string,
  fallbackCommitteeId: string | null,
  twoYearPeriod: string
): CachedContributionRow[] {
  return rows.map((r) => ({
    candidate_id: candidateId,
    committee_id: r.committee_id ?? fallbackCommitteeId ?? null,
    committee_name: r.committee?.name ?? null,
    contributor_name: r.contributor_name ?? null,
    contributor_employer: r.contributor_employer ?? null,
    contributor_occupation: r.contributor_occupation ?? null,
    contributor_state: r.contributor_state ?? null,
    contribution_amount: r.contribution_receipt_amount ?? null,
    contribution_date: r.contribution_receipt_date ?? null,
    two_year_period: r.two_year_transaction_period ?? Number(twoYearPeriod),
  }));
}

function mapScheduleALastIndexesToCursor(
  lastIndexes?: Record<string, string | number>
): Record<string, string> | null {
  if (!lastIndexes) return null;

  const cursor: Record<string, string> = {};
  if (lastIndexes.last_index != null) {
    cursor["last_index"] = String(lastIndexes.last_index);
  }
  if (lastIndexes.last_contribution_receipt_amount != null) {
    cursor["last_contribution_receipt_amount"] = String(lastIndexes.last_contribution_receipt_amount);
  }
  if (lastIndexes.last_contribution_receipt_date != null) {
    cursor["last_contribution_receipt_date"] = String(lastIndexes.last_contribution_receipt_date);
  }
  if (lastIndexes.sort_null_only != null) {
    cursor["sort_null_only"] = String(lastIndexes.sort_null_only);
  }

  return Object.keys(cursor).length ? cursor : null;
}

function tryAcquireSummaryRefreshLock(candidateId: string): boolean {
  const now = Date.now();
  const existingUntil = summaryRefreshLocks.get(candidateId) ?? 0;
  if (existingUntil > now) return false;
  summaryRefreshLocks.set(candidateId, now + SUMMARY_REFRESH_DEBOUNCE_MS);
  return true;
}

function releaseSummaryRefreshLock(candidateId: string): void {
  summaryRefreshLocks.delete(candidateId);
}

function mapCachedRowsToApiRows(rows: Array<{
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
}>): FecContributionResult[] {
  return rows.map((r) => ({
    candidate_id: r.candidate_id ?? undefined,
    committee_id: r.committee_id ?? undefined,
    committee: { name: r.committee_name ?? undefined },
    contributor_name: r.contributor_name ?? undefined,
    contributor_employer: r.contributor_employer ?? undefined,
    contributor_occupation: r.contributor_occupation ?? undefined,
    contributor_state: r.contributor_state ?? undefined,
    contribution_receipt_amount: r.contribution_amount ?? undefined,
    contribution_receipt_date: r.contribution_date ?? undefined,
    two_year_transaction_period: r.two_year_period ?? undefined,
  }));
}

async function refreshCandidateContributionsCache(
  sb: ReturnType<typeof getSupabase>,
  apiKey: string,
  candidateId: string,
  committeeId: string | null,
  twoYearPeriod: string
): Promise<number> {
  const allRows: CachedContributionRow[] = [];
  let cursor: Record<string, string> | null = null;
  let lastCursorSignature: string | null = null;

  for (
    let refreshPage = 1;
    refreshPage <= CANDIDATE_REFRESH_MAX_PAGES;
    refreshPage += 1
  ) {
    const refreshParams: Record<string, string> = {
      per_page: String(CANDIDATE_REFRESH_PER_PAGE),
      is_individual: "true",
      two_year_transaction_period: twoYearPeriod,
    };

    if (committeeId) {
      refreshParams["committee_id"] = committeeId;
    } else {
      refreshParams["candidate_id"] = candidateId;
    }

    if (cursor) {
      for (const [key, value] of Object.entries(cursor)) {
        refreshParams[key] = value;
      }
    }

    let refreshResp: Response;
    try {
      refreshResp = await fecFetch(
        "/schedules/schedule_a/",
        apiKey,
        refreshParams,
        FEC_BACKGROUND_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      if (!(error instanceof FecTimeoutError)) {
        throw error;
      }

      const smallerPageParams = {
        ...refreshParams,
        per_page: "10",
      };
      refreshResp = await fecFetch(
        "/schedules/schedule_a/",
        apiKey,
        smallerPageParams,
        FEC_BACKGROUND_FETCH_TIMEOUT_MS
      );
    }

    if (!refreshResp.ok) {
      const upstreamDetail = await readFecErrorDetails(refreshResp);
      throw new Error(
        `OpenFEC refresh failed (${refreshResp.status})${upstreamDetail ? `: ${upstreamDetail}` : ""}`
      );
    }

    const refreshData = (await refreshResp.json()) as {
      results?: FecContributionResult[];
      pagination?: FecScheduleAPagination;
    };

    const rows = refreshData.results ?? [];
    if (rows.length === 0) break;

    allRows.push(...mapFecRowsToCacheRows(rows, candidateId, committeeId, twoYearPeriod));

    const nextCursor = mapScheduleALastIndexesToCursor(refreshData.pagination?.last_indexes);
    if (!nextCursor) break;

    const nextSignature = JSON.stringify(nextCursor);
    if (lastCursorSignature && lastCursorSignature === nextSignature) break;

    cursor = nextCursor;
    lastCursorSignature = nextSignature;
  }

  const { error: deleteError } = await sb
    .from("contributions")
    .delete()
    .eq("candidate_id", candidateId);

  if (deleteError) {
    throw new Error(`Failed to clear cached contributions: ${deleteError.message}`);
  }

  if (allRows.length > 0) {
    const chunkSize = 1000;
    for (let i = 0; i < allRows.length; i += chunkSize) {
      const chunk = allRows.slice(i, i + chunkSize);
      const { error: insertError } = await sb.from("contributions").insert(chunk);
      if (insertError) {
        throw new Error(`Failed to cache contributions: ${insertError.message}`);
      }
    }
  }

  return allRows.length;
}

async function fetchAllCachedCandidateContributionRows(
  sb: ReturnType<typeof getSupabase>,
  candidateId: string
): Promise<CachedContributionSummaryRow[]> {
  const pageSize = 1000;
  let from = 0;
  const allRows: CachedContributionSummaryRow[] = [];

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await sb
      .from("contributions")
      .select(
        "contributor_name, contributor_employer, contribution_amount, contribution_date, committee_name"
      )
      .eq("candidate_id", candidateId)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to query cached contributions: ${error.message}`);
    }

    const batch = (data ?? []) as CachedContributionSummaryRow[];
    allRows.push(...batch);

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
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

  const requestedPage = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const requestedPerPage = Math.max(1, Math.min(Number(c.req.query("limit") ?? "20") || 20, 100));

  const params: Record<string, string> = {
    per_page: String(requestedPerPage),
    sort,
    is_individual: "true",
  };

  const candidateId = c.req.query("candidate_id");
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

    const [{ data: latestRow, error: latestError }, { data: cachedRows, count, error: queryError }] =
      await Promise.all([
        sb
          .from("contributions")
          .select("updated_at")
          .eq("candidate_id", candidateId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        sb
          .from("contributions")
          .select("candidate_id, committee_id, committee_name, contributor_name, contributor_employer, contributor_occupation, contributor_state, contribution_amount, contribution_date, two_year_period", { count: "exact" })
          .eq("candidate_id", candidateId)
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
      if (isStale) {
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const refreshSb = getSupabase(c.env);
              const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId);

              await refreshCandidateContributionsCache(
                refreshSb,
                apiKey,
                candidateId,
                committeeId,
                twoYearPeriod
              );
            } catch (error) {
              console.error(`Background contribution refresh failed for ${candidateId}`, error);
            }
          })()
        );
      }

      return c.json({
        results: mapCachedRowsToApiRows(cachedRows ?? []),
        pagination: {
          count: totalCount,
          page,
          pages,
        },
        query_context: {
          source: "supabase_cache",
          candidate_id: candidateId,
          page,
          per_page: limit,
          sort,
          stale: isStale,
          refresh_queued: isStale,
        },
      }, 200, { "Cache-Control": "public, max-age=300" });
    }

    const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId);

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

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const refreshSb = getSupabase(c.env);
            await refreshCandidateContributionsCache(
              refreshSb,
              apiKey,
              candidateId,
              committeeId,
              twoYearPeriod
            );
          } catch (error) {
            console.error(`Failed to warm contribution cache for ${candidateId}`, error);
          }
        })()
      );

      return c.json({
        ...liveData,
        pagination: normalizedLivePagination,
        query_context: {
          source: "openfec_live",
          candidate_id: candidateId,
          resolved_committee_id: committeeId ?? null,
          page,
          per_page: limit,
          sort,
          cache_refresh_queued: true,
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
    const committeeIdForCandidate = await resolveCandidateCommitteeId(apiKey, candidateId);
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
  if (minAmount) params["min_amount"] = minAmount;

  const maxAmount = c.req.query("max_amount");
  if (maxAmount) params["max_amount"] = maxAmount;

  const minDate = c.req.query("min_date");
  if (minDate) params["min_date"] = minDate;

  const maxDate = c.req.query("max_date");
  if (maxDate) params["max_date"] = maxDate;

  const state = c.req.query("state");
  if (state) params["contributor_state"] = state;

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
        committee_id?: string;
        committee?: { name?: string };
        contributor_name?: string;
        contributor_employer?: string;
        contributor_occupation?: string;
        contributor_state?: string;
        contribution_receipt_amount?: number;
        contribution_receipt_date?: string;
        two_year_transaction_period?: number;
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
      const rows = data.results
        .filter((r) => r.candidate_id || r.committee_id)
        .map((r) => ({
          candidate_id: r.candidate_id ?? null,
          committee_id: r.committee_id ?? null,
          committee_name: r.committee?.name ?? null,
          contributor_name: r.contributor_name ?? null,
          contributor_employer: r.contributor_employer ?? null,
          contributor_occupation: r.contributor_occupation ?? null,
          contributor_state: r.contributor_state ?? null,
          contribution_amount: r.contribution_receipt_amount ?? null,
          contribution_date: r.contribution_receipt_date ?? null,
          two_year_period: r.two_year_transaction_period ?? null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("contributions").insert(rows))
      );
    }

    return c.json({
      ...data,
      pagination: normalizedPagination,
      query_context: {
        source: "openfec_live",
        candidate_id: candidateId ?? null,
        committee_id: params["committee_id"] ?? null,
        page: requestedPage,
        per_page: requestedPerPage,
        sort_requested: sort,
        sort_applied: sortApplied,
        fallback_sort_applied: fallbackSortApplied,
        next_cursor: data.pagination?.last_indexes ?? null,
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
// Candidate contribution summary (aggregates + top donors) from cached rows.
openfec.get("/candidates/:candidateId/summary", async (c) => {
  const apiKey = c.env.OPENFEC_API_KEY;
  if (!apiKey) return c.json({ error: "OpenFEC API key not configured" }, 500);
  if (!hasSupabase(c.env)) {
    return c.json(
      { error: "Supabase is required for candidate contribution summaries." },
      500
    );
  }

  const candidateId = c.req.param("candidateId");
  const twoYearPeriod = c.req.query("two_year_period") ?? defaultTwoYearPeriod();
  const topNQuery = Number(c.req.query("top_n") ?? "10");
  const topN = topNQuery === 5 || topNQuery === 10 || topNQuery === 20 ? topNQuery : 10;
  const sb = getSupabase(c.env);

  try {
    const { data: latestRow, error: latestError } = await sb
      .from("contributions")
      .select("updated_at")
      .eq("candidate_id", candidateId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      console.warn(`Unable to read contribution freshness for ${candidateId}: ${latestError.message}`);
    }

    const latestUpdatedAt = latestRow?.updated_at ? new Date(latestRow.updated_at) : null;
    const isStale =
      !latestUpdatedAt ||
      Number.isNaN(latestUpdatedAt.getTime()) ||
      Date.now() - latestUpdatedAt.getTime() > CONTRIBUTIONS_CACHE_STALE_MS;

    const { count: cachedCount, error: countError } = await sb
      .from("contributions")
      .select("id", { count: "exact", head: true })
      .eq("candidate_id", candidateId);

    if (countError) {
      return c.json(
        { error: `Failed to query cached contribution count: ${countError.message}` },
        500
      );
    }

    const hasCache = (cachedCount ?? 0) > 0;
    const refreshQueued = isStale || !hasCache;
    const refreshStarted = refreshQueued && tryAcquireSummaryRefreshLock(candidateId);

    if (refreshStarted) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const refreshSb = getSupabase(c.env);
            const resolvedCommitteeId = await resolveCandidateCommitteeId(apiKey, candidateId);
            await refreshCandidateContributionsCache(
              refreshSb,
              apiKey,
              candidateId,
              resolvedCommitteeId,
              twoYearPeriod
            );
          } catch (error) {
            console.error(`Background summary refresh failed for ${candidateId}`, error);
          } finally {
            releaseSummaryRefreshLock(candidateId);
          }
        })()
      );
    }

    if (!hasCache) {
      return c.json(
        {
          candidate_id: candidateId,
          two_year_period: Number(twoYearPeriod),
          summary_pending: true,
          message: "Contribution summary is being prepared. Try again shortly.",
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
          top_donors: {
            top_5: [],
            top_10: [],
            top_20: [],
            selected_top_n: [],
          },
          query_context: {
            source: "supabase_cache",
            candidate_id: candidateId,
            two_year_transaction_period: Number(twoYearPeriod),
            top_n: topN,
            stale: isStale,
            refreshed: false,
            refresh_queued: refreshStarted,
            refresh_in_flight: refreshQueued && !refreshStarted,
            resolved_committee_id: null,
            cached_row_count: 0,
          },
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }

    const cachedRows = await fetchAllCachedCandidateContributionRows(sb, candidateId);

    const rowsWithAmount = cachedRows.filter(
      (row): row is CachedContributionSummaryRow & { contribution_amount: number } =>
        typeof row.contribution_amount === "number" && Number.isFinite(row.contribution_amount)
    );

    const donationCount = rowsWithAmount.length;
    const totalDonationAmount = rowsWithAmount.reduce(
      (sum, row) => sum + row.contribution_amount,
      0
    );
    const meanDonationAmount = donationCount > 0 ? totalDonationAmount / donationCount : null;
    const sortedAmounts = rowsWithAmount
      .map((row) => row.contribution_amount)
      .sort((a, b) => a - b);
    const medianDonationAmount =
      donationCount === 0
        ? null
        : donationCount % 2 === 1
          ? sortedAmounts[(donationCount - 1) / 2]
          : (sortedAmounts[donationCount / 2 - 1] + sortedAmounts[donationCount / 2]) / 2;

    const largestDonationRow = rowsWithAmount.reduce<
      (CachedContributionSummaryRow & { contribution_amount: number }) | null
    >((max, row) => (!max || row.contribution_amount > max.contribution_amount ? row : max), null);

    const smallestDonationRow = rowsWithAmount.reduce<
      (CachedContributionSummaryRow & { contribution_amount: number }) | null
    >((min, row) => (!min || row.contribution_amount < min.contribution_amount ? row : min), null);

    const donorMap = new Map<
      string,
      {
        donor_name: string;
        donation_count: number;
        total_donation_amount: number;
        largest_single_donation: number;
      }
    >();

    for (const row of rowsWithAmount) {
      const donorName = row.contributor_name?.trim() || "Unknown contributor";
      const donorKey = donorName.toUpperCase();
      const existing = donorMap.get(donorKey);

      if (!existing) {
        donorMap.set(donorKey, {
          donor_name: donorName,
          donation_count: 1,
          total_donation_amount: row.contribution_amount,
          largest_single_donation: row.contribution_amount,
        });
        continue;
      }

      existing.donation_count += 1;
      existing.total_donation_amount += row.contribution_amount;
      if (row.contribution_amount > existing.largest_single_donation) {
        existing.largest_single_donation = row.contribution_amount;
      }
    }

    const sortedDonors = Array.from(donorMap.values()).sort((a, b) => {
      if (b.total_donation_amount !== a.total_donation_amount) {
        return b.total_donation_amount - a.total_donation_amount;
      }
      if (b.largest_single_donation !== a.largest_single_donation) {
        return b.largest_single_donation - a.largest_single_donation;
      }
      if (b.donation_count !== a.donation_count) {
        return b.donation_count - a.donation_count;
      }
      return a.donor_name.localeCompare(b.donor_name);
    });

    const highestDonationByEmployer = rowsWithAmount.reduce<{
      employer: string;
      contribution_amount: number;
      contributor_name: string | null;
      contribution_date: string | null;
      committee_name: string | null;
    } | null>((max, row) => {
      const employer = row.contributor_employer?.trim();
      if (!employer) return max;

      if (!max || row.contribution_amount > max.contribution_amount) {
        return {
          employer,
          contribution_amount: row.contribution_amount,
          contributor_name: row.contributor_name ?? null,
          contribution_date: row.contribution_date ?? null,
          committee_name: row.committee_name ?? null,
        };
      }

      return max;
    }, null);

    return c.json(
      {
        candidate_id: candidateId,
        two_year_period: Number(twoYearPeriod),
        summary: {
          donation_count: donationCount,
          total_donation_amount: totalDonationAmount,
          average_donation_amount: meanDonationAmount,
          mean_donation_amount: meanDonationAmount,
          median_donation_amount: medianDonationAmount,
          largest_donation: largestDonationRow
            ? {
                contribution_amount: largestDonationRow.contribution_amount,
                contributor_name: largestDonationRow.contributor_name ?? null,
                contributor_employer: largestDonationRow.contributor_employer ?? null,
                contribution_date: largestDonationRow.contribution_date ?? null,
                committee_name: largestDonationRow.committee_name ?? null,
              }
            : null,
          smallest_donation: smallestDonationRow
            ? {
                contribution_amount: smallestDonationRow.contribution_amount,
                contributor_name: smallestDonationRow.contributor_name ?? null,
                contributor_employer: smallestDonationRow.contributor_employer ?? null,
                contribution_date: smallestDonationRow.contribution_date ?? null,
                committee_name: smallestDonationRow.committee_name ?? null,
              }
            : null,
          highest_donation_by_employer: highestDonationByEmployer,
        },
        top_donors: {
          top_5: sortedDonors.slice(0, 5),
          top_10: sortedDonors.slice(0, 10),
          top_20: sortedDonors.slice(0, 20),
          selected_top_n: sortedDonors.slice(0, topN),
        },
        query_context: {
          source: "supabase_cache",
          candidate_id: candidateId,
          two_year_transaction_period: Number(twoYearPeriod),
          top_n: topN,
          stale: isStale,
          refreshed: false,
          refresh_queued: refreshStarted,
          refresh_in_flight: refreshQueued && !refreshStarted,
          resolved_committee_id: null,
          cached_row_count: cachedRows.length,
        },
      },
      200,
      { "Cache-Control": refreshQueued ? "no-store" : "public, max-age=300" }
    );
  } catch (error) {
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
      const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId);
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
