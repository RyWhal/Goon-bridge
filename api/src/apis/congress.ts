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

// ── GET /api/congress/members ────────────────────────────────────────────────
// List members — tries Supabase first, falls through to Congress.gov
congress.get("/members", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const currentCongress = c.req.query("congress") ?? "119";
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

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
        state?: string;
        district?: number;
        depiction?: { imageUrl?: string };
        [key: string]: unknown;
      }>;
    };

    // Cache members to Supabase in the background
    if (hasSupabase(c.env) && data.members?.length) {
      const sb = getSupabase(c.env);
      const rows = data.members
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

    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
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
        bioguideId?: string;
        district?: number;
        depiction?: { imageUrl?: string };
        [key: string]: unknown;
      }>;
    };
    const qLower = query.toLowerCase();
    const filtered = (data.members ?? []).filter((m) => {
      const name = (m.name ?? "").toLowerCase();
      const state = (m.state ?? "").toLowerCase();
      const party = (m.party ?? "").toLowerCase();
      return name.includes(qLower) || state.includes(qLower) || party.includes(qLower);
    });

    // Cache all fetched members to Supabase in the background
    if (hasSupabase(c.env) && data.members?.length) {
      const sb = getSupabase(c.env);
      const rows = data.members
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
    const data: unknown = await resp.json();
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
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

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
          { votes: data, count: count ?? data.length },
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

  let path = `/vote`;
  if (congress_num) {
    path = `/vote/${congress_num}`;
    if (chamber) {
      path = `/vote/${congress_num}/${chamber}`;
    }
  }

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return c.json(
        {
          error: `Congress API returned ${resp.status}`,
          detail: body.slice(0, 200) || undefined,
          hint: !hasSupabase(c.env)
            ? "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY Worker secrets to enable cached data."
            : undefined,
        },
        502
      );
    }
    const data = (await resp.json()) as {
      votes?: Array<{
        congress?: number;
        chamber?: string;
        number?: number;
        date?: string;
        question?: string;
        description?: string;
        result?: string;
        totalYea?: number;
        totalNay?: number;
        totalNotVoting?: number;
        bill?: { congress?: number; type?: string; number?: number };
        [key: string]: unknown;
      }>;
    };

    // Cache votes to Supabase in the background
    if (hasSupabase(c.env) && data.votes?.length) {
      const sb = getSupabase(c.env);
      const rows = data.votes
        .filter((v) => v.congress && v.chamber && v.number)
        .map((v) => ({
          congress: v.congress!,
          chamber: (v.chamber ?? "").toLowerCase(),
          roll_call_number: v.number!,
          date: v.date ?? null,
          question: v.question ?? null,
          description: v.description ?? null,
          result: v.result ?? null,
          total_yea: v.totalYea ?? null,
          total_nay: v.totalNay ?? null,
          total_not_voting: v.totalNotVoting ?? null,
          bill_congress: v.bill?.congress ?? null,
          bill_type: v.bill?.type ?? null,
          bill_number: v.bill?.number ?? null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(
          sb.from("votes").upsert(rows, { onConflict: "congress,chamber,roll_call_number" })
        )
      );
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
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
congress.get("/votes/:congress/:chamber/:rollCallNumber", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, chamber, rollCallNumber } = c.req.param();
  const path = `/vote/${cong}/${chamber}/${rollCallNumber}`;

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

// ── GET /api/congress/bills ──────────────────────────────────────────────────
congress.get("/bills", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const billType = c.req.query("type");
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

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
