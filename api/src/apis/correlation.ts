import { Hono, type Context } from "hono";
import type { Env } from "../types";
import type { MemberVoteStats } from "../lib/member-votes";
import { getSupabase } from "../lib/supabase";
import { requireAdminAuth } from "../middleware/admin-auth";
import {
  fetchOfficialCommitteeAssignments,
  materializeMemberRelationships,
  persistFinnhubActivity,
  refreshOrganizationsFromContributions,
  replaceMemberCommitteeAssignments,
} from "../lib/relationships";

const correlation = new Hono<Env>();

// All POST (mutation) routes require admin authentication
correlation.use("/refresh/*", requireAdminAuth);

function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

function parseLimit(value: string | undefined, fallback: number, max = 200) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function parseOffset(value: string | undefined, fallback = 0) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
}

function normalizeMemberChamber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (lower.includes("house")) return "House";
  if (lower.includes("senate")) return "Senate";
  return value.trim() || null;
}

async function fetchInternalJson<T>(c: Context<Env>, path: string): Promise<T> {
  const origin = new URL(c.req.url).origin;
  const response = await fetch(`${origin}${path}`, { headers: c.req.raw.headers });
  if (!response.ok) {
    throw new Error(`Internal request failed (${response.status}) for ${path}`);
  }
  return await response.json() as T;
}

// ── GET /api/correlation/member/:bioguideId ──────────────────────────────────
correlation.get("/member/:bioguideId", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const sb = getSupabase(c.env);

  const [memberRes, donorsRes, votesRes, fecRes, voteStatsRes] = await Promise.all([
    sb.from("members").select("*").eq("bioguide_id", bioguideId).single(),
    sb
      .from("donor_summary")
      .select("*")
      .eq("bioguide_id", bioguideId)
      .order("total_amount", { ascending: false })
      .limit(20),
    sb
      .from("member_voting_record")
      .select("*")
      .eq("bioguide_id", bioguideId)
      .order("vote_date", { ascending: false })
      .limit(50),
    sb
      .from("fec_candidates")
      .select("candidate_id, name, party, state, office, election_years")
      .eq("bioguide_id", bioguideId),
    sb.from("member_vote_stats").select("*").eq("bioguide_id", bioguideId).maybeSingle(),
  ]);

  if (memberRes.error) {
    return c.json({ error: "Member not found", detail: memberRes.error.message }, 404);
  }

  let recentVotes = votesRes.data ?? [];
  let voteStats = voteStatsRes.data as MemberVoteStats | null;
  if (recentVotes.length === 0 && c.env.CONGRESS_API_KEY) {
    try {
      const memberChamber = (memberRes.data?.chamber ?? "").toLowerCase();
      if (memberChamber === "house of representatives" || memberChamber === "house") {
        const mvData = await fetchInternalJson<{
          votes?: Array<{
            rollCallNumber: number;
            date: string | null;
            question: string | null;
            description: string | null;
            result: string | null;
            position: string;
            chamber: string;
          }>;
          stats?: MemberVoteStats;
        }>(c, `/api/congress/member-votes/${bioguideId}?congress=119&limit=20`);

        if (mvData.votes?.length) {
          recentVotes = mvData.votes.map((v) => ({
            bioguide_id: bioguideId,
            member_name: memberRes.data?.name ?? null,
            party: memberRes.data?.party ?? null,
            state: memberRes.data?.state ?? null,
            congress: 119,
            chamber: v.chamber,
            roll_call_number: v.rollCallNumber,
            vote_date: v.date,
            question: v.question,
            vote_description: v.description,
            result: v.result,
            position: v.position,
          }));
        }
        if (mvData.stats) {
          voteStats = mvData.stats;
        }
      }
    } catch {
      // best-effort fallback
    }
  }

  return c.json(
    {
      member: memberRes.data,
      fec_candidates: fecRes.data ?? [],
      top_donors: donorsRes.data ?? [],
      recent_votes: recentVotes,
      vote_stats: voteStats,
    },
    200,
    { "Cache-Control": "public, max-age=1800" }
  );
});

// ── GET /api/correlation/member/:bioguideId/donors ───────────────────────────
correlation.get("/member/:bioguideId/donors", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const limit = parseLimit(c.req.query("limit"), 50);
  const sb = getSupabase(c.env);

  const { data, error } = await sb
    .from("donor_summary")
    .select("*")
    .eq("bioguide_id", bioguideId)
    .order("total_amount", { ascending: false })
    .limit(limit);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(
    { bioguide_id: bioguideId, donors: data ?? [], count: data?.length ?? 0 },
    200,
    { "Cache-Control": "public, max-age=1800" }
  );
});

// ── GET /api/correlation/member/:bioguideId/votes ────────────────────────────
correlation.get("/member/:bioguideId/votes", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const congress = c.req.query("congress");
  const limit = parseLimit(c.req.query("limit"), 50);
  const sb = getSupabase(c.env);

  let query = sb
    .from("member_voting_record")
    .select("*", { count: "exact" })
    .eq("bioguide_id", bioguideId)
    .order("vote_date", { ascending: false })
    .limit(limit);

  if (congress) {
    query = query.eq("congress", Number.parseInt(congress, 10));
  }

  const [{ data, error, count }, statsRes] = await Promise.all([
    query,
    sb.from("member_vote_stats").select("*").eq("bioguide_id", bioguideId).maybeSingle(),
  ]);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(
    {
      bioguide_id: bioguideId,
      votes: data ?? [],
      count: count ?? data?.length ?? 0,
      stats: statsRes.data ?? undefined,
    },
    200,
    { "Cache-Control": "public, max-age=1800" }
  );
});

// ── GET /api/correlation/member/:bioguideId/cases ────────────────────────────
correlation.get("/member/:bioguideId/cases", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const limit = parseLimit(c.req.query("limit"), 50);
  const status = c.req.query("status");
  const sb = getSupabase(c.env);

  let query = sb
    .from("member_correlation_cases")
    .select("*", { count: "exact" })
    .eq("member_bioguide_id", bioguideId)
    .order("event_date", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(
    {
      bioguide_id: bioguideId,
      count: count ?? data?.length ?? 0,
      cases: (data ?? []).map((row) => ({
        id: row.id,
        case_type: row.case_type,
        summary: row.summary,
        event_date: row.event_date,
        time_window_days: row.time_window_days,
        status: row.status,
        organization: row.organization_id != null
          ? {
              id: row.organization_id,
              name: row.organization_name,
              ticker: row.organization_ticker,
            }
          : null,
        evidence: Array.isArray(row.evidence_payload?.evidence)
          ? row.evidence_payload.evidence
          : [],
      })),
    },
    200,
    { "Cache-Control": "public, max-age=900" }
  );
});

// ── GET /api/correlation/cases/recent ────────────────────────────────────────
correlation.get("/cases/recent", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const limit = parseLimit(c.req.query("limit"), 25, 100);
  const status = c.req.query("status");
  const sb = getSupabase(c.env);

  let query = sb
    .from("member_correlation_cases")
    .select("*", { count: "exact" })
    .order("event_date", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(
    {
      count: count ?? data?.length ?? 0,
      cases: (data ?? []).map((row) => ({
        id: row.id,
        bioguide_id: row.member_bioguide_id,
        member_name: row.member_name,
        case_type: row.case_type,
        summary: row.summary,
        event_date: row.event_date,
        time_window_days: row.time_window_days,
        status: row.status,
        organization: row.organization_id != null
          ? {
              id: row.organization_id,
              name: row.organization_name,
              ticker: row.organization_ticker,
            }
          : null,
        evidence: Array.isArray(row.evidence_payload?.evidence)
          ? row.evidence_payload.evidence
          : [],
      })),
    },
    200,
    { "Cache-Control": "public, max-age=900" }
  );
});

// ── POST /api/correlation/refresh/organizations ──────────────────────────────
correlation.post("/refresh/organizations", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const sb = getSupabase(c.env);
  try {
    const result = await refreshOrganizationsFromContributions(sb, {
      bioguideId: c.req.query("bioguide_id"),
      candidateId: c.req.query("candidate_id"),
      limit: parseLimit(c.req.query("limit"), 500, 2000),
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh organizations",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/correlation/refresh/organization/:symbol/activity ─────────────
correlation.post("/refresh/organization/:symbol/activity", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const symbol = c.req.param("symbol").trim().toUpperCase();
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ error: "Both 'from' and 'to' query parameters are required" }, 400);
  }

  try {
    const [lobbying, contracts] = await Promise.all([
      fetchInternalJson<{ data?: unknown[] }>(c, `/api/finnhub/lobbying?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      fetchInternalJson<{ data?: unknown[] }>(c, `/api/usaspending/awards?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);

    const sb = getSupabase(c.env);
    const result = await persistFinnhubActivity(sb, {
      symbol,
      lobbyingRecords: (lobbying.data ?? []) as Array<Record<string, unknown>>,
      contractRecords: (contracts.data ?? []) as Array<Record<string, unknown>>,
    });

    return c.json({ ok: true, symbol, from, to, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh organization activity",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/correlation/refresh/member/:bioguideId/committees ─────────────
correlation.post("/refresh/member/:bioguideId/committees", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");

  try {
    const sb = getSupabase(c.env);
    const { data: member, error: memberError } = await sb
      .from("members")
      .select("bioguide_id,name,direct_order_name,state,chamber,congress")
      .eq("bioguide_id", bioguideId)
      .maybeSingle();
    if (memberError) {
      return c.json({ error: `Failed to load member record: ${memberError.message}` }, 500);
    }
    if (!member) {
      return c.json({ error: "Member not found in local cache", bioguide_id: bioguideId }, 404);
    }

    let chamber = member.chamber;
    let state = member.state;
    let memberName = member.name;
    let directOrderName = member.direct_order_name;
    let congress = member.congress;

    if (!chamber || !state || !directOrderName) {
      const detail = await fetchInternalJson<{ member?: Record<string, unknown> }>(c, `/api/congress/members/${bioguideId}`);
      const detailMember = detail.member ?? {};
      chamber = chamber ?? normalizeMemberChamber(detailMember.currentMember ? String((detailMember.terms as Array<Record<string, unknown>> | undefined)?.[0]?.chamber ?? "") : null);
      state = state ?? (typeof detailMember.state === "string" ? detailMember.state : null);
      directOrderName = directOrderName ?? (typeof detailMember.directOrderName === "string" ? detailMember.directOrderName : null);
      memberName = memberName ?? (typeof detailMember.name === "string" ? detailMember.name : bioguideId);
      congress = congress ?? (
        Array.isArray(detailMember.terms)
          ? Number((detailMember.terms[detailMember.terms.length - 1] as Record<string, unknown>)?.congress ?? 0) || null
          : null
      );
    }

    const assignments = await fetchOfficialCommitteeAssignments({
      bioguideId,
      memberName,
      directOrderName,
      state,
      chamber,
      congress,
    });
    if (assignments.length === 0) {
      return c.json(
        {
          error: "No committee assignments were found in the official source",
          detail:
            "The official chamber source did not return any committee or subcommittee assignments for this member.",
          bioguide_id: bioguideId,
          source: "official_chamber_committee_source",
        },
        422
      );
    }
    const result = await replaceMemberCommitteeAssignments(sb, bioguideId, assignments);
    return c.json({ ok: true, bioguide_id: bioguideId, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh member committees",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/correlation/refresh/member/:bioguideId/cases ──────────────────
correlation.post("/refresh/member/:bioguideId/cases", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const sb = getSupabase(c.env);

  try {
    await refreshOrganizationsFromContributions(sb, { bioguideId, limit: 1000 });
    const result = await materializeMemberRelationships(sb, bioguideId);
    return c.json({ ok: true, bioguide_id: bioguideId, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh member cases",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/correlation/refresh/cases/all ─────────────────────────────────
correlation.post("/refresh/cases/all", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const limit = parseLimit(c.req.query("limit"), 50, 500);
  const offset = parseOffset(c.req.query("offset"));
  const sb = getSupabase(c.env);

  try {
    const { data: tradeRows, error: tradesError } = await sb
      .from("member_stock_trades")
      .select("bioguide_id")
      .not("bioguide_id", "is", null)
      .order("bioguide_id", { ascending: true })
      .limit(5000);

    if (tradesError) {
      throw new Error(`Failed to load member stock trades: ${tradesError.message}`);
    }

    const eligibleMembers = [...new Set(
      (tradeRows ?? [])
        .map((row) => row.bioguide_id)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    )];

    const targetMembers = eligibleMembers.slice(offset, offset + limit);
    const refreshed: Array<{ bioguide_id: string; factCount: number; caseCount: number }> = [];
    const failures: Array<{ bioguide_id: string; error: string }> = [];

    for (const bioguideId of targetMembers) {
      try {
        const result = await materializeMemberRelationships(sb, bioguideId);
        refreshed.push({ bioguide_id: bioguideId, ...result });
      } catch (error) {
        failures.push({
          bioguide_id: bioguideId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const nextOffset = offset + targetMembers.length;
    return c.json({
      ok: true,
      totalEligibleMembers: eligibleMembers.length,
      processedMembers: targetMembers.length,
      refreshedMembers: refreshed.length,
      failedMembers: failures.length,
      offset,
      limit,
      nextOffset: nextOffset < eligibleMembers.length ? nextOffset : null,
      members: refreshed,
      failures,
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh all member cases",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export { correlation };
