import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";

const correlation = new Hono<Env>();

// ── GET /api/correlation/member/:bioguideId ──────────────────────────────────
// Full member profile: info + top donors + recent votes
correlation.get("/member/:bioguideId", async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const sb = getSupabase(c.env);

  // Run all queries in parallel
  const [memberRes, donorsRes, votesRes, fecRes] = await Promise.all([
    // 1. Member info
    sb.from("members").select("*").eq("bioguide_id", bioguideId).single(),

    // 2. Top donors by employer (from the view)
    sb
      .from("donor_summary")
      .select("*")
      .eq("bioguide_id", bioguideId)
      .order("total_amount", { ascending: false })
      .limit(20),

    // 3. Recent voting record (from the view)
    sb
      .from("member_voting_record")
      .select("*")
      .eq("bioguide_id", bioguideId)
      .order("vote_date", { ascending: false })
      .limit(50),

    // 4. FEC candidate mappings
    sb
      .from("fec_candidates")
      .select("candidate_id, name, party, state, office, election_years")
      .eq("bioguide_id", bioguideId),
  ]);

  if (memberRes.error) {
    return c.json({ error: "Member not found", detail: memberRes.error.message }, 404);
  }

  // If the voting record cache is empty, trigger a live fetch from Congress.gov
  // so the Follow the Money page isn't perpetually blank.
  let recentVotes = votesRes.data ?? [];
  if (recentVotes.length === 0 && c.env.CONGRESS_API_KEY) {
    try {
      // Determine member's chamber from DB
      const memberChamber = (memberRes.data?.chamber ?? "").toLowerCase();
      if (memberChamber === "house of representatives" || memberChamber === "house") {
        // Fetch member votes via the internal endpoint
        const workerUrl = new URL(c.req.url);
        const apiUrl = `${workerUrl.origin}/api/congress/member-votes/${bioguideId}?congress=119&limit=20`;
        const mvResp = await fetch(apiUrl, { headers: c.req.raw.headers });
        if (mvResp.ok) {
          const mvData = (await mvResp.json()) as {
            votes?: Array<{
              rollCallNumber: number;
              date: string | null;
              question: string | null;
              description: string | null;
              result: string | null;
              position: string;
              chamber: string;
            }>;
          };
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
        }
      }
    } catch {
      // Fall through with empty votes — best effort
    }
  }

  return c.json(
    {
      member: memberRes.data,
      fec_candidates: fecRes.data ?? [],
      top_donors: donorsRes.data ?? [],
      recent_votes: recentVotes,
    },
    200,
    { "Cache-Control": "public, max-age=1800" }
  );
});

// ── GET /api/correlation/member/:bioguideId/donors ───────────────────────────
// Top donors aggregated by employer
correlation.get("/member/:bioguideId/donors", async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
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
// Full voting record for a member
correlation.get("/member/:bioguideId/votes", async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const bioguideId = c.req.param("bioguideId");
  const congress = c.req.query("congress");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const sb = getSupabase(c.env);

  let query = sb
    .from("member_voting_record")
    .select("*")
    .eq("bioguide_id", bioguideId)
    .order("vote_date", { ascending: false })
    .limit(limit);

  if (congress) {
    query = query.eq("congress", parseInt(congress, 10));
  }

  const { data, error } = await query;

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(
    { bioguide_id: bioguideId, votes: data ?? [], count: data?.length ?? 0 },
    200,
    { "Cache-Control": "public, max-age=1800" }
  );
});

export { correlation };
