import { Hono } from "hono";
import type { Env } from "../types";

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

// ── GET /api/congress/members ────────────────────────────────────────────────
// Search/list members of Congress
congress.get("/members", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const params: Record<string, string> = {};
  const limit = c.req.query("limit") ?? "20";
  const offset = c.req.query("offset") ?? "0";
  params["limit"] = limit;
  params["offset"] = offset;

  // Congress.gov member list endpoint
  const currentCongress = c.req.query("congress") ?? "119";
  const path = `/member/congress/${currentCongress}`;

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/search ─────────────────────────────────────────
// Search members by name
congress.get("/members/search", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Missing search query 'q'" }, 400);

  const params: Record<string, string> = {
    limit: c.req.query("limit") ?? "20",
    offset: c.req.query("offset") ?? "0",
  };

  // Congress.gov doesn't have a direct name search — we fetch the full member
  // list for the congress and filter client-side. For a production app, we'd
  // ingest into Supabase and search there.
  const currentCongress = c.req.query("congress") ?? "119";
  const path = `/member/congress/${currentCongress}`;
  params["limit"] = "250";
  params["offset"] = "0";

  try {
    const resp = await congressFetch(path, apiKey, params);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      members?: Array<{ name?: string; state?: string; party?: string; bioguideId?: string; [key: string]: unknown }>;
    };
    const q = query.toLowerCase();
    const filtered = (data.members ?? []).filter((m) => {
      const name = (m.name ?? "").toLowerCase();
      const state = (m.state ?? "").toLowerCase();
      const party = (m.party ?? "").toLowerCase();
      return name.includes(q) || state.includes(q) || party.includes(q);
    });
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
// List recent votes
congress.get("/votes", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const chamber = c.req.query("chamber"); // house or senate
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
  const billType = c.req.query("type"); // hr, s, hjres, sjres, etc.
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
