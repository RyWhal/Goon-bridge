import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";

const openfec = new Hono<Env>();

const BASE = "https://api.open.fec.gov/v1";

function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

async function fecFetch(
  path: string,
  apiKey: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return fetch(url.toString());
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
    const candidateResp = await fecFetch(`/candidate/${candidateId}/`, apiKey);
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
    const committeesResp = await fecFetch(`/candidate/${candidateId}/committees/`, apiKey, {
      per_page: "20",
      sort: "-cycle",
    });
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

  const params: Record<string, string> = {
    per_page: c.req.query("limit") ?? "20",
    page: c.req.query("page") ?? "1",
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
    const page = Math.max(1, Number(params.page) || 1);

    const { data: latestRow } = await sb
      .from("contributions")
      .select("updated_at")
      .eq("candidate_id", candidateId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestUpdatedAt = latestRow?.updated_at ? new Date(latestRow.updated_at) : null;
    const isStale = !latestUpdatedAt || (Date.now() - latestUpdatedAt.getTime()) > 24 * 60 * 60 * 1000;

    let resolvedCommitteeId: string | null = null;

    if (isStale) {
      const committeeId = await resolveCandidateCommitteeId(apiKey, candidateId);
      if (!committeeId) {
        return c.json({
          error: `No authorized committee found for candidate ${candidateId}`,
          query: { candidate_id: candidateId },
        }, 404);
      }
      resolvedCommitteeId = committeeId;

      const allRows: Array<{
        candidate_id: string;
        committee_id: string | null;
        committee_name: string | null;
        contributor_name: string | null;
        contributor_employer: string | null;
        contributor_occupation: string | null;
        contributor_state: string | null;
        contribution_amount: number | null;
        contribution_date: string | null;
        two_year_period: number | null;
      }> = [];

      const refreshPerPage = 100;
      const maxRefreshPages = 100;
      for (let refreshPage = 1; refreshPage <= maxRefreshPages; refreshPage += 1) {
        const refreshResp = await fecFetch("/schedules/schedule_a/", apiKey, {
          committee_id: committeeId,
          candidate_id: candidateId,
          per_page: String(refreshPerPage),
          page: String(refreshPage),
          sort: "-contribution_receipt_date",
          is_individual: "true",
          two_year_transaction_period: twoYearPeriod,
        });

        if (!refreshResp.ok) {
          const upstreamDetail = await readFecErrorDetails(refreshResp);
          return c.json({
            error: `FEC API ${refreshResp.status}${upstreamDetail ? `: ${upstreamDetail}` : ""}`,
            detail: upstreamDetail,
            query: {
              candidate_id: candidateId,
              committee_id: committeeId,
              page: refreshPage,
              per_page: refreshPerPage,
              two_year_transaction_period: twoYearPeriod,
            },
          }, 502);
        }

        const refreshData = (await refreshResp.json()) as {
          results?: Array<{
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
          pagination?: { pages?: number };
        };

        const rows = refreshData.results ?? [];
        if (rows.length === 0) break;

        allRows.push(
          ...rows.map((r) => ({
            candidate_id: candidateId,
            committee_id: r.committee_id ?? committeeId,
            committee_name: r.committee?.name ?? null,
            contributor_name: r.contributor_name ?? null,
            contributor_employer: r.contributor_employer ?? null,
            contributor_occupation: r.contributor_occupation ?? null,
            contributor_state: r.contributor_state ?? null,
            contribution_amount: r.contribution_receipt_amount ?? null,
            contribution_date: r.contribution_receipt_date ?? null,
            two_year_period: r.two_year_transaction_period ?? Number(twoYearPeriod),
          }))
        );

        const pages = refreshData.pagination?.pages ?? refreshPage;
        if (refreshPage >= pages) break;
      }

      const { error: deleteError } = await sb
        .from("contributions")
        .delete()
        .eq("candidate_id", candidateId);

      if (deleteError) {
        return c.json({ error: `Failed to clear cached contributions: ${deleteError.message}` }, 500);
      }

      if (allRows.length > 0) {
        const chunkSize = 1000;
        for (let i = 0; i < allRows.length; i += chunkSize) {
          const chunk = allRows.slice(i, i + chunkSize);
          const { error: insertError } = await sb.from("contributions").insert(chunk);
          if (insertError) {
            return c.json({ error: `Failed to cache contributions: ${insertError.message}` }, 500);
          }
        }
      }
    }

    const ascending = sort === "contribution_receipt_amount" || sort === "contribution_receipt_date";
    const sortColumn = sort.includes("amount") ? "contribution_amount" : "contribution_date";
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: cachedRows, count, error: queryError } = await sb
      .from("contributions")
      .select("candidate_id, committee_id, committee_name, contributor_name, contributor_employer, contributor_occupation, contributor_state, contribution_amount, contribution_date, two_year_period", { count: "exact" })
      .eq("candidate_id", candidateId)
      .order(sortColumn, { ascending, nullsFirst: false })
      .range(from, to);

    if (queryError) {
      return c.json({ error: `Failed to query cached contributions: ${queryError.message}` }, 500);
    }

    const totalCount = count ?? 0;
    const pages = limit > 0 ? Math.max(1, Math.ceil(totalCount / limit)) : 1;

    return c.json({
      results: (cachedRows ?? []).map((r) => ({
        candidate_id: r.candidate_id ?? candidateId,
        committee_id: r.committee_id ?? undefined,
        committee: { name: r.committee_name ?? undefined },
        contributor_name: r.contributor_name ?? undefined,
        contributor_employer: r.contributor_employer ?? undefined,
        contributor_occupation: r.contributor_occupation ?? undefined,
        contributor_state: r.contributor_state ?? undefined,
        contribution_receipt_amount: r.contribution_amount ?? undefined,
        contribution_receipt_date: r.contribution_date ?? undefined,
        two_year_transaction_period: r.two_year_period ?? undefined,
      })),
      pagination: {
        count: totalCount,
        page,
        pages,
      },
      query_context: {
        source: "supabase_cache",
        candidate_id: candidateId,
        resolved_committee_id: resolvedCommitteeId,
        page,
        per_page: limit,
        sort,
        refreshed: isStale,
      },
    }, 200, { "Cache-Control": "public, max-age=3600" });
  }

  const endpoint = "/schedules/schedule_a/";

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

  try {
    const resp = await fecFetch(endpoint, apiKey, params);
    if (!resp.ok) {
      const upstreamDetail = await readFecErrorDetails(resp);
      const debugParams = Object.fromEntries(
        Object.entries(params).filter(([key]) =>
          ["candidate_id", "committee_id", "page", "per_page", "sort", "two_year_transaction_period"].includes(key)
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

    return c.json(data, 200, { "Cache-Control": "no-store" });
  } catch {
    return c.json({ error: "Failed to fetch from FEC API" }, 502);
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
