import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";

const congress = new Hono<Env>();

const BASE = "https://api.congress.gov/v3";

async function congressFetch(
  path: string,
  apiKey: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return fetch(url.toString());
}

/**
 * Check if Supabase is configured. Gracefully degrade if not.
 */
function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}


function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}


type CongressPartyHistoryItem = {
  partyName?: string;
  partyAbbreviation?: string;
};

type CongressMemberLike = {
  party?: string;
  partyName?: string;
  partyHistory?: CongressPartyHistoryItem[];
};

function normalizePartyValue(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  if (cleaned.length === 1) {
    const c = cleaned.toUpperCase();
    if (c === "D" || c === "R" || c === "I") return c;
    return cleaned;
  }

  const lower = cleaned.toLowerCase();
  if (lower.includes("democrat")) return "D";
  if (lower.includes("republic")) return "R";
  if (lower.includes("independent")) return "I";

  return cleaned;
}

function extractMemberParty(member: CongressMemberLike): string | null {
  const candidates = [
    normalizePartyValue(member.party),
    normalizePartyValue(member.partyName),
    normalizePartyValue(member.partyHistory?.[0]?.partyAbbreviation),
    normalizePartyValue(member.partyHistory?.[0]?.partyName),
  ];
  return candidates.find((value): value is string => !!value) ?? null;
}

// ── GET /api/congress/members ────────────────────────────────────────────────
// List members — tries Supabase first, falls through to Congress.gov
congress.get("/members", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const currentCongress = c.req.query("congress") ?? "119";
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  // Try Supabase first
  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, count, error } = await sb
        .from("members")
        .select("*", { count: "exact" })
        .eq("congress", parseInt(currentCongress, 10))
        .order("name")
        .range(offset, offset + limit - 1);

      if (!error && data && data.length > 0) {
        // If cache rows don't have party info, fall through to live API so we can rehydrate.
        const hasPartyCoverage = data.some((m) => !!m.party);
        if (hasPartyCoverage) {
          // Map Supabase rows to the same shape the frontend expects
          const members = data.map((m) => ({
            bioguideId: m.bioguide_id,
            name: m.name,
            party: m.party,
            state: m.state,
            district: m.district,
            depiction: m.image_url ? { imageUrl: m.image_url } : undefined,
          }));
          return c.json(
            { members, count: count ?? members.length },
            200,
            { "Cache-Control": "public, max-age=3600" }
          );
        }
      }
    } catch {
      // Supabase failed — fall through to live API
    }
  }

  // Fallthrough: live Congress.gov API
  const params: Record<string, string> = {
    limit: limit.toString(),
    offset: offset.toString(),
  };
  const path = `/member/congress/${currentCongress}`;

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      members?: Array<{
        bioguideId?: string;
        name?: string;
        party?: string;
        partyName?: string;
        partyHistory?: CongressPartyHistoryItem[];
        state?: string;
        district?: number;
        depiction?: { imageUrl?: string };
        [key: string]: unknown;
      }>;
    };

    const normalizedMembers = (data.members ?? []).map((m) => ({
      ...m,
      party: extractMemberParty(m),
    }));

    // Cache members to Supabase in the background
    if (hasSupabase(c.env) && normalizedMembers.length) {
      const sb = getSupabase(c.env);
      const rows = normalizedMembers
        .filter((m) => m.bioguideId)
        .map((m) => ({
          bioguide_id: m.bioguideId!,
          name: m.name ?? "",
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          image_url: m.depiction?.imageUrl ?? null,
          congress: parseInt(currentCongress, 10),
        }));
      // Fire and forget — don't block the response
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("members").upsert(rows, { onConflict: "bioguide_id" }))
      );
    }

    return c.json(
      { ...data, members: normalizedMembers },
      200,
      { "Cache-Control": "public, max-age=3600" }
    );
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/search ─────────────────────────────────────────
// Search members by name — uses Supabase trigram search when available
congress.get("/members/search", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Missing search query 'q'" }, 400);

  const currentCongress = c.req.query("congress") ?? "119";

  // Try Supabase first — much faster than fetching 250 members and filtering
  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const q = `%${query}%`;
      const { data, error } = await sb
        .from("members")
        .select("*")
        .eq("congress", parseInt(currentCongress, 10))
        .or(`name.ilike.${q},state.ilike.${q},party.ilike.${q}`)
        .order("name")
        .limit(50);

      if (!error && data && data.length > 0) {
        const hasPartyCoverage = data.some((m) => !!m.party);
        if (hasPartyCoverage) {
          const members = data.map((m) => ({
            bioguideId: m.bioguide_id,
            name: m.name,
            party: m.party,
            state: m.state,
            district: m.district,
            depiction: m.image_url ? { imageUrl: m.image_url } : undefined,
          }));
          return c.json(
            { members, count: members.length },
            200,
            { "Cache-Control": "public, max-age=3600" }
          );
        }
      }
    } catch {
      // Fall through to live API
    }
  }

  // Fallthrough: fetch all members from Congress.gov and filter
  const params: Record<string, string> = {
    limit: "250",
    offset: "0",
  };
  const path = `/member/congress/${currentCongress}`;

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      members?: Array<{
        name?: string;
        state?: string;
        party?: string;
        partyName?: string;
        partyHistory?: CongressPartyHistoryItem[];
        bioguideId?: string;
        district?: number;
        depiction?: { imageUrl?: string };
        [key: string]: unknown;
      }>;
    };

    const normalizedMembers = (data.members ?? []).map((m) => ({
      ...m,
      party: extractMemberParty(m),
    }));

    const qLower = query.toLowerCase();
    const filtered = normalizedMembers.filter((m) => {
      const name = (m.name ?? "").toLowerCase();
      const state = (m.state ?? "").toLowerCase();
      const party = (m.party ?? "").toLowerCase();
      return name.includes(qLower) || state.includes(qLower) || party.includes(qLower);
    });

    // Cache all fetched members to Supabase in the background
    if (hasSupabase(c.env) && normalizedMembers.length) {
      const sb = getSupabase(c.env);
      const rows = normalizedMembers
        .filter((m) => m.bioguideId)
        .map((m) => ({
          bioguide_id: m.bioguideId!,
          name: m.name ?? "",
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          image_url: m.depiction?.imageUrl ?? null,
          congress: parseInt(currentCongress, 10),
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("members").upsert(rows, { onConflict: "bioguide_id" }))
      );
    }

    return c.json(
      { members: filtered, count: filtered.length },
      200,
      { "Cache-Control": "public, max-age=3600" }
    );
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/:bioguideId ────────────────────────────────────
congress.get("/members/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const bioguideId = c.req.param("bioguideId");

  try {
    const resp = await congressFetch(`/member/${bioguideId}`, apiKey);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      member?: CongressMemberLike & Record<string, unknown>;
      [key: string]: unknown;
    };

    if (data.member) {
      data.member.party = extractMemberParty(data.member) ?? undefined;
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/votes ──────────────────────────────────────────────────
congress.get("/votes", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const chamber = c.req.query("chamber");
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  // Helper to normalize vote rows from Supabase (snake_case) to frontend (camelCase)
  function normalizeDbVote(row: Record<string, unknown>) {
    return {
      congress: row.congress,
      chamber: row.chamber,
      rollCallNumber: row.roll_call_number,
      date: row.date,
      question: row.question,
      description: row.description,
      result: row.result,
      totalYea: row.total_yea,
      totalNay: row.total_nay,
      totalNotVoting: row.total_not_voting,
      bill: row.bill_congress
        ? { congress: row.bill_congress, type: row.bill_type, number: row.bill_number }
        : undefined,
    };
  }

  // Try Supabase first
  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      let query = sb
        .from("votes")
        .select("*", { count: "exact" })
        .eq("congress", parseInt(congress_num, 10))
        .order("date", { ascending: false })
        .range(offset, offset + limit - 1);

      if (chamber) {
        query = query.eq("chamber", chamber.toLowerCase());
      }

      const { data, count, error } = await query;

      if (!error && data && data.length > 0) {
        return c.json(
          {
            votes: data.map((row) => normalizeDbVote(row as Record<string, unknown>)),
            count: count ?? data.length,
          },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch {
      // Fall through to live API
    }
  }

  // We merge votes from two sessions and then paginate locally.
  // To keep pagination correct, we may need up to offset+limit from each session.
  const requiredWindowSize = limit + offset;

  // Congress.gov API v3 uses `/house-vote/{congress}/{session}` for House
  // roll call votes. Senate votes do not have a dedicated endpoint yet.
  // Each congress has two sessions (1 and 2). We fetch both sessions and
  // merge so the user doesn't need to pick a session.
  const sessions = ["1", "2"];

  // Raw shape returned by the Congress.gov /house-vote list endpoint
  type CongressHouseVote = {
    congress?: number;
    sessionNumber?: number;
    rollCallNumber?: number;
    startDate?: string;
    voteQuestion?: string;
    result?: string;
    voteType?: string;
    legislationType?: string;
    legislationUrl?: string;
    url?: string;
    [key: string]: unknown;
  };

  // Only House votes are available in the API right now
  if (chamber === "senate") {
    return c.json(
      {
        votes: [],
        count: 0,
        notice: "Senate roll call votes are not yet available in the Congress.gov API. Only House votes are supported.",
      },
      200,
      { "Cache-Control": "public, max-age=1800" }
    );
  }

  try {
    const CONGRESS_MAX_LIMIT = 250;

    const fetchSessionVotes = async (session: string): Promise<{ votes: CongressHouseVote[]; totalCount?: number; errorStatus?: number; errorBody?: string }> => {
      const votes: CongressHouseVote[] = [];
      let pageOffset = 0;
      let totalCount: number | undefined;

      while (votes.length < requiredWindowSize) {
        const remaining = requiredWindowSize - votes.length;
        const pageLimit = Math.min(CONGRESS_MAX_LIMIT, remaining);
        const resp = await congressFetch(`/house-vote/${congress_num}/${session}`, apiKey, {
          limit: String(pageLimit),
          offset: String(pageOffset),
        });

        if (!resp.ok) {
          return {
            votes,
            totalCount,
            errorStatus: resp.status,
            errorBody: await resp.text().catch(() => ""),
          };
        }

        const data = (await resp.json()) as {
          houseRollCallVotes?: CongressHouseVote[];
          pagination?: { count?: number };
        };

        if (data.pagination?.count != null) {
          totalCount = data.pagination.count;
        }

        const pageVotes = data.houseRollCallVotes ?? [];
        if (pageVotes.length === 0) break;

        votes.push(...pageVotes);
        if (pageVotes.length < pageLimit) break;

        pageOffset += pageLimit;
      }

      return { votes, totalCount };
    };

    const sessionResults = await Promise.all(sessions.map((session) => fetchSessionVotes(session)));

    let allVotes: CongressHouseVote[] = [];
    let firstErrorStatus: number | null = null;
    let firstErrorBody = "";
    let totalCount = 0;

    for (const result of sessionResults) {
      if (result.errorStatus && firstErrorStatus === null) {
        firstErrorStatus = result.errorStatus;
        firstErrorBody = result.errorBody ?? "";
      }
      allVotes = allVotes.concat(result.votes);
      if (result.totalCount != null) {
        totalCount += result.totalCount;
      }
    }

    if (allVotes.length === 0) {
      if (firstErrorStatus !== null) {
        return c.json(
          {
            error: `Congress API returned ${firstErrorStatus}`,
            detail: firstErrorBody.slice(0, 200) || undefined,
            hint: !hasSupabase(c.env)
              ? "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY Worker secrets to enable cached data."
              : undefined,
          },
          502
        );
      }
      return c.json(
        { votes: [], count: 0 },
        200,
        { "Cache-Control": "public, max-age=300" }
      );
    }

    // Sort merged results by date descending and apply requested pagination
    allVotes.sort((a, b) => {
      const da = a.startDate ?? "";
      const db = b.startDate ?? "";
      return db.localeCompare(da);
    });
    allVotes = allVotes.slice(offset, offset + limit);

    // Normalize to the shape the frontend expects
    const normalized = allVotes.map((v) => ({
      congress: v.congress,
      chamber: "House",
      rollCallNumber: v.rollCallNumber,
      date: v.startDate,
      question: v.voteQuestion ?? v.voteType,
      description: v.legislationType
        ? `${v.legislationType} — ${v.voteType ?? ""}`
        : v.voteType,
      result: v.result,
      url: v.url,
    }));

    // Cache votes to Supabase in the background
    if (hasSupabase(c.env) && normalized.length) {
      const sb = getSupabase(c.env);
      const rows = normalized
        .filter((v) => v.congress && v.rollCallNumber)
        .map((v) => ({
          congress: v.congress!,
          chamber: "house",
          roll_call_number: v.rollCallNumber!,
          date: v.date ?? null,
          question: v.question ?? null,
          description: v.description ?? null,
          result: v.result ?? null,
          total_yea: null,
          total_nay: null,
          total_not_voting: null,
          bill_congress: null,
          bill_type: null,
          bill_number: null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(
          sb.from("votes").upsert(rows, { onConflict: "congress,chamber,roll_call_number" })
        )
      );
    }

    return c.json(
      { votes: normalized, count: totalCount || normalized.length, offset, limit },
      200,
      { "Cache-Control": "public, max-age=1800" }
    );
  } catch (e) {
    return c.json(
      {
        error: "Failed to fetch from Congress API",
        detail: e instanceof Error ? e.message : undefined,
        hint: !hasSupabase(c.env)
          ? "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY Worker secrets to enable cached data."
          : undefined,
      },
      502
    );
  }
});

// ── GET /api/congress/votes/:congress/:chamber/:rollCallNumber ───────────────
// The Congress.gov v3 item-level endpoint requires a session number:
//   /house-vote/{congress}/{session}/{rollCallNumber}
// Since the frontend doesn't track session, we try both sessions.
congress.get("/votes/:congress/:chamber/:rollCallNumber", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, chamber, rollCallNumber } = c.req.param();

  if (chamber.toLowerCase() === "senate") {
    return c.json({ error: "Senate vote details are not yet available in the Congress.gov API" }, 400);
  }

  // Try session 2 first (more recent), then session 1
  for (const session of ["2", "1"]) {
    try {
      const resp = await congressFetch(`/house-vote/${cong}/${session}/${rollCallNumber}`, apiKey);
      if (resp.ok) {
        const raw = (await resp.json()) as Record<string, unknown>;
        const v = raw.houseRollCallVote as Record<string, unknown> | undefined;
        if (v) {
          const partyTotals = v.votePartyTotal as Array<Record<string, unknown>> | undefined;
          let totalYea = 0, totalNay = 0, totalNotVoting = 0;
          if (partyTotals) {
            for (const p of partyTotals) {
              totalYea += (p.yea as number) ?? 0;
              totalNay += (p.nay as number) ?? 0;
              totalNotVoting += (p.notVoting as number) ?? 0;
            }
          }

          // Fetch member-level votes and cache to Supabase in the background
          if (hasSupabase(c.env)) {
            c.executionCtx.waitUntil(
              fetchAndCacheMemberVotes(c.env, apiKey, cong, session, rollCallNumber)
            );
          }

          return c.json({
            vote: {
              congress: v.congress,
              chamber: "House",
              date: v.startDate,
              question: v.voteQuestion,
              description: v.voteType,
              result: v.result,
              totalYea,
              totalNay,
              totalNotVoting,
            },
            raw: v,
          }, 200, { "Cache-Control": "public, max-age=1800" });
        }
        return c.json(raw, 200, { "Cache-Control": "public, max-age=1800" });
      }
      // 404 means wrong session — try the other one
      if (resp.status !== 404) {
        return c.json({ error: `Congress API: ${resp.status}` }, 502);
      }
    } catch {
      // Try next session
    }
  }

  return c.json({ error: `Vote not found: congress ${cong}, roll call ${rollCallNumber}` }, 404);
});

// ── GET /api/congress/member-votes/:bioguideId ──────────────────────────────
// Fetch a member's voting record from Congress.gov. This populates the
// member_votes table so the Follow the Money page can show voting data.
congress.get("/member-votes/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const bioguideId = c.req.param("bioguideId");
  const congressNum = c.req.query("congress") ?? "119";
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  // Fetch recent House votes and check member positions
  const sessions = ["2", "1"];
  type HouseVoteListItem = {
    congress?: number;
    sessionNumber?: number;
    rollCallNumber?: number;
    startDate?: string;
    voteQuestion?: string;
    result?: string;
    voteType?: string;
    url?: string;
  };

  let allVotes: HouseVoteListItem[] = [];
  for (const session of sessions) {
    try {
      const resp = await congressFetch(`/house-vote/${congressNum}/${session}`, apiKey, {
        limit: limit.toString(),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { houseRollCallVotes?: HouseVoteListItem[] };
        if (data.houseRollCallVotes) allVotes = allVotes.concat(data.houseRollCallVotes);
      }
    } catch {
      // skip
    }
  }

  allVotes.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  allVotes = allVotes.slice(0, limit);

  // For each vote, fetch member-level data to find this member's position
  const memberVotes: Array<{
    rollCallNumber: number;
    date: string | null;
    question: string | null;
    description: string | null;
    result: string | null;
    position: string;
    chamber: string;
  }> = [];

  // Fetch member votes in batches of 5 to avoid rate limits
  for (let i = 0; i < allVotes.length; i += 5) {
    const batch = allVotes.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (vote) => {
        if (!vote.rollCallNumber) return null;
        const session = String(vote.sessionNumber ?? 1);
        try {
          const resp = await congressFetch(
            `/house-vote/${congressNum}/${session}/${vote.rollCallNumber}/members`,
            apiKey,
            { limit: "500" }
          );
          if (!resp.ok) return null;
          const data = (await resp.json()) as {
            members?: Array<{
              bioguideId?: string;
              voteCast?: string;
            }>;
          };
          const memberVote = data.members?.find(
            (m) => m.bioguideId === bioguideId
          );
          if (!memberVote) return null;
          return {
            rollCallNumber: vote.rollCallNumber,
            date: vote.startDate ?? null,
            question: vote.voteQuestion ?? null,
            description: vote.voteType ?? null,
            result: vote.result ?? null,
            position: memberVote.voteCast ?? "Unknown",
            chamber: "House",
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) memberVotes.push(r);
    }
  }

  // Cache to Supabase in background
  if (hasSupabase(c.env) && memberVotes.length) {
    c.executionCtx.waitUntil(
      cacheMemberVotesToSupabase(c.env, bioguideId, parseInt(congressNum, 10), memberVotes)
    );
  }

  return c.json({
    bioguide_id: bioguideId,
    votes: memberVotes,
    count: memberVotes.length,
  }, 200, { "Cache-Control": "public, max-age=1800" });
});

/**
 * Fetch member-level votes for a single roll call and cache to member_votes table.
 */
async function fetchAndCacheMemberVotes(
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  session: string,
  rollCallNumber: string
) {
  try {
    const resp = await congressFetch(
      `/house-vote/${congressNum}/${session}/${rollCallNumber}/members`,
      apiKey,
      { limit: "500" }
    );
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      members?: Array<{
        bioguideId?: string;
        voteCast?: string;
      }>;
    };
    if (!data.members?.length) return;

    const sb = getSupabase(env);

    // Ensure the vote row exists
    const { data: voteRow } = await sb
      .from("votes")
      .select("id")
      .eq("congress", parseInt(congressNum, 10))
      .eq("chamber", "house")
      .eq("roll_call_number", parseInt(rollCallNumber, 10))
      .single();

    if (!voteRow) return;

    const rows = data.members
      .filter((m) => m.bioguideId && m.voteCast)
      .map((m) => ({
        vote_id: voteRow.id,
        bioguide_id: m.bioguideId!,
        position: m.voteCast!,
      }));

    if (rows.length > 0) {
      await sb.from("member_votes").upsert(rows, {
        onConflict: "vote_id,bioguide_id",
      });
    }
  } catch {
    // Best-effort caching
  }
}

/**
 * Cache a member's vote positions to Supabase.
 */
async function cacheMemberVotesToSupabase(
  env: Env["Bindings"],
  bioguideId: string,
  congressNum: number,
  memberVotes: Array<{
    rollCallNumber: number;
    date: string | null;
    question: string | null;
    description: string | null;
    result: string | null;
    position: string;
    chamber: string;
  }>
) {
  try {
    const sb = getSupabase(env);

    for (const mv of memberVotes) {
      // Ensure vote row exists
      const { data: existing } = await sb
        .from("votes")
        .select("id")
        .eq("congress", congressNum)
        .eq("chamber", "house")
        .eq("roll_call_number", mv.rollCallNumber)
        .single();

      let voteId: number;
      if (existing) {
        voteId = existing.id;
      } else {
        // Insert the vote
        const { data: inserted } = await sb
          .from("votes")
          .upsert({
            congress: congressNum,
            chamber: "house",
            roll_call_number: mv.rollCallNumber,
            date: mv.date,
            question: mv.question,
            description: mv.description,
            result: mv.result,
          }, { onConflict: "congress,chamber,roll_call_number" })
          .select("id")
          .single();
        if (!inserted) continue;
        voteId = inserted.id;
      }

      // Insert member vote
      await sb.from("member_votes").upsert({
        vote_id: voteId,
        bioguide_id: bioguideId,
        position: mv.position,
      }, { onConflict: "vote_id,bioguide_id" });
    }
  } catch {
    // Best-effort
  }
}

// ── GET /api/congress/bills ──────────────────────────────────────────────────
congress.get("/bills", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const billType = c.req.query("type");
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  // Try Supabase first
  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      let query = sb
        .from("bills")
        .select("*", { count: "exact" })
        .eq("congress", parseInt(congress_num, 10))
        .order("latest_action_date", { ascending: false })
        .range(offset, offset + limit - 1);

      if (billType) {
        query = query.eq("bill_type", billType.toLowerCase());
      }

      const { data, count, error } = await query;

      if (!error && data && data.length > 0) {
        return c.json(
          { bills: data, count: count ?? data.length },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch {
      // Fall through to live API
    }
  }

  const params: Record<string, string> = {
    limit: limit.toString(),
    offset: offset.toString(),
  };

  const sort = c.req.query("sort");
  if (sort) params["sort"] = sort;

  let path = `/bill/${congress_num}`;
  if (billType) path += `/${billType}`;

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      bills?: Array<{
        congress?: number;
        type?: string;
        number?: number;
        title?: string;
        policyArea?: { name?: string };
        latestAction?: { text?: string; actionDate?: string };
        [key: string]: unknown;
      }>;
    };

    // Cache bills to Supabase in the background
    if (hasSupabase(c.env) && data.bills?.length) {
      const sb = getSupabase(c.env);
      const rows = data.bills
        .filter((b) => b.congress && b.type && b.number)
        .map((b) => ({
          congress: b.congress!,
          bill_type: (b.type ?? "").toLowerCase(),
          bill_number: b.number!,
          title: b.title ?? null,
          policy_area: b.policyArea?.name ?? null,
          latest_action_text: b.latestAction?.text ?? null,
          latest_action_date: b.latestAction?.actionDate ?? null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(
          sb.from("bills").upsert(rows, { onConflict: "congress,bill_type,bill_number" })
        )
      );
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/bills/:congress/:type/:number ──────────────────────────
congress.get("/bills/:congress/:type/:number", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, type, number } = c.req.param();
  const path = `/bill/${cong}/${type}/${number}`;

  try {
    const resp = await congressFetch(path, apiKey);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

export { congress };
