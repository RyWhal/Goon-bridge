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
  const params: Record<string, string> = {
    limit: c.req.query("limit") ?? "20",
    offset: c.req.query("offset") ?? "0",
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
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
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
  const params: Record<string, string> = {
    limit: c.req.query("limit") ?? "20",
    offset: c.req.query("offset") ?? "0",
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
    const data: unknown = await resp.json();
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
