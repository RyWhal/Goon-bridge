import { Hono } from "hono";
import type { Env } from "../types.ts";
import { getSupabase } from "../lib/supabase.ts";
import { hasSupabase } from "../lib/validation.ts";
import {
  loadPolicyCommitteeEvidence,
  loadVisiblePolicyCommitteeMappings,
} from "../lib/policy-committee-maps.ts";

const maps = new Hono<Env>();

maps.get("/policy-committees", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const policyArea = c.req.query("policyArea")?.trim();
  if (!policyArea) {
    return c.json({ error: "Missing required query parameter 'policyArea'" }, 400);
  }

  try {
    const sb = getSupabase(c.env);
    const rows = await loadVisiblePolicyCommitteeMappings(sb, policyArea);
    return c.json(
      {
        policy_area: policyArea.trim().replace(/\s+/g, " ").toUpperCase(),
        count: rows.length,
        rows,
      },
      200,
      { "Cache-Control": "public, max-age=900" }
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to load policy committee mappings",
      },
      500
    );
  }
});

maps.get("/evidence/policy-committee/:mapId", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const mapId = Number.parseInt(c.req.param("mapId"), 10);
  if (!Number.isFinite(mapId) || mapId <= 0) {
    return c.json({ error: "Invalid policy committee map id" }, 400);
  }

  try {
    const sb = getSupabase(c.env);
    const evidence = await loadPolicyCommitteeEvidence(sb, mapId);
    return c.json(
      {
        map_type: "policy-committee",
        map_id: mapId,
        count: evidence.length,
        evidence,
      },
      200,
      { "Cache-Control": "public, max-age=900" }
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to load policy committee evidence",
      },
      500
    );
  }
});

export { maps };
