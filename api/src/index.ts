import { Hono } from "hono";
import type { Env } from "./types.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { securityHeaders } from "./middleware/security.ts";
import { rateLimitMiddleware } from "./middleware/rate-limit.ts";
import { correlation } from "./apis/correlation.ts";
import { maps } from "./apis/maps.ts";
import { getSupabase } from "./lib/supabase.ts";

const API_VERSION = "0.1.0";

const app = new Hono<Env>();

// ── Global error handler ────────────────────────────────────────────────────
// Catches any unhandled exception so every response is JSON, never an HTML
// error page that the frontend can't parse.
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: "Internal server error",
      detail: err instanceof Error ? err.message : String(err),
    },
    500
  );
});

// ── Global middleware ────────────────────────────────────────────────────────
app.use("/api/*", securityHeaders);
app.use("/api/*", corsMiddleware);
app.use("/api/*", rateLimitMiddleware);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", async (c) => {
  const hasSupabaseConfig = !!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY);
  let supabaseStatus: boolean | string = false;

  if (!hasSupabaseConfig) {
    supabaseStatus = false;
  } else {
    // Actually test the connection with a lightweight query
    try {
      const sb = getSupabase(c.env);
      const { error } = await sb.from("members").select("bioguide_id").limit(1);
      supabaseStatus = !error;
      if (error) {
        supabaseStatus = `error: ${error.message} (code: ${error.code})`;
      }
    } catch (e: unknown) {
      supabaseStatus = `exception: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return c.json({
    status: "ok",
    service: "vibe-api",
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT ?? "unknown",
      version: {
      version: API_VERSION,
      commit: c.env.CF_VERSION_METADATA?.tag ?? "unknown",
      deployed_at: c.env.CF_VERSION_METADATA?.timestamp ?? null,
      version_id: c.env.CF_VERSION_METADATA?.id ?? "unknown",
      version_tag: c.env.CF_VERSION_METADATA?.tag ?? null,
    },
    apis: {
      congress: !!c.env.CONGRESS_API_KEY,
      openfec: !!c.env.OPENFEC_API_KEY,
      finnhub: !!c.env.FINNHUB_API_KEY,
      usaspending: true,
      supabase: supabaseStatus,
      weather: true,
      earthquakes: true,
      sunrise: true,
      lunar: true,
    },
    supabase_configured: hasSupabaseConfig,
  });
});

// ── Mount API routes ─────────────────────────────────────────────────────────
const endpointTestMode = (
  globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  }
).process?.env?.GOON_BRIDGE_ENDPOINT_TEST === "1";

if (!endpointTestMode) {
  const [
    { congress },
    { openfec },
    { finnhub },
    { usaspending },
    { weather },
    { earthquakes },
    { sunrise },
    { lunar },
    { disclosures },
    { lda },
  ] = await Promise.all([
    import("./apis/congress.ts"),
    import("./apis/openfec.ts"),
    import("./apis/finnhub.ts"),
    import("./apis/usaspending.ts"),
    import("./apis/weather.ts"),
    import("./apis/earthquakes.ts"),
    import("./apis/sunrise.ts"),
    import("./apis/lunar.ts"),
    import("./apis/disclosures.ts"),
    import("./apis/lda.ts"),
  ]);

  app.route("/api/congress", congress);
  app.route("/api/fec", openfec);
  app.route("/api/finnhub", finnhub);
  app.route("/api/usaspending", usaspending);
  app.route("/api/weather", weather);
  app.route("/api/earthquakes", earthquakes);
  app.route("/api/sunrise", sunrise);
  app.route("/api/lunar", lunar);
  app.route("/api/disclosures", disclosures);
  app.route("/api/lda", lda);
}

app.route("/api/correlation", correlation);
app.route("/api/maps", maps);

// ── Vote context (aggregated) ────────────────────────────────────────────────
// Returns all correlation data for a given date in a single response
app.get("/api/context/:date", async (c) => {
  const date = c.req.param("date");

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format (use YYYY-MM-DD)" }, 400);
  }

  // Fetch all context data in parallel
  const baseUrl = new URL(c.req.url).origin;

  const [weatherRes, quakeRes, sunRes, lunarRes] = await Promise.allSettled([
    fetch(`${baseUrl}/api/weather/historical?start_date=${date}&end_date=${date}`).then(
      (r) => r.json()
    ),
    fetch(`${baseUrl}/api/earthquakes/summary?date=${date}`).then((r) => r.json()),
    fetch(`${baseUrl}/api/sunrise?date=${date}`).then((r) => r.json()),
    fetch(`${baseUrl}/api/lunar?date=${date}`).then((r) => r.json()),
  ]);

  return c.json(
    {
      date,
      weather: weatherRes.status === "fulfilled" ? weatherRes.value : null,
      earthquakes: quakeRes.status === "fulfilled" ? quakeRes.value : null,
      sunrise: sunRes.status === "fulfilled" ? sunRes.value : null,
      lunar: lunarRes.status === "fulfilled" ? lunarRes.value : null,
    },
    200,
    { "Cache-Control": "public, max-age=3600" }
  );
});

export default app;
