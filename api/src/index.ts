import { Hono } from "hono";
import type { Env } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { securityHeaders } from "./middleware/security";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { congress } from "./apis/congress";
import { openfec } from "./apis/openfec";
import { weather } from "./apis/weather";
import { earthquakes } from "./apis/earthquakes";
import { sunrise } from "./apis/sunrise";
import { lunar } from "./apis/lunar";

const app = new Hono<Env>();

// ── Global middleware ────────────────────────────────────────────────────────
app.use("/api/*", securityHeaders);
app.use("/api/*", corsMiddleware);
app.use("/api/*", rateLimitMiddleware);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    service: "congress-vibe-check-api",
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT ?? "unknown",
    apis: {
      congress: !!c.env.CONGRESS_API_KEY,
      openfec: !!c.env.OPENFEC_API_KEY,
      weather: true,
      earthquakes: true,
      sunrise: true,
      lunar: true,
    },
  });
});

// ── Mount API routes ─────────────────────────────────────────────────────────
app.route("/api/congress", congress);
app.route("/api/fec", openfec);
app.route("/api/weather", weather);
app.route("/api/earthquakes", earthquakes);
app.route("/api/sunrise", sunrise);
app.route("/api/lunar", lunar);

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
