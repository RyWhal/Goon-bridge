import { Hono } from "hono";
import type { Env } from "../types";

const sunrise = new Hono<Env>();

// ── GET /api/sunrise ─────────────────────────────────────────────────────────
// Get sunrise/sunset data for a location and date
sunrise.get("/", async (c) => {
  const lat = c.req.query("lat") ?? "38.8951";   // DC default
  const lon = c.req.query("lon") ?? "-77.0364";
  const date = c.req.query("date");

  if (!date) {
    return c.json({ error: "Missing date (YYYY-MM-DD)" }, 400);
  }

  try {
    const resp = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${date}&formatted=0`
    );
    if (!resp.ok) {
      return c.json({ error: `Sunrise API: ${resp.status}` }, 502);
    }

    const data = (await resp.json()) as {
      status?: string;
      results?: {
        sunrise?: string;
        sunset?: string;
        solar_noon?: string;
        day_length?: number;
        civil_twilight_begin?: string;
        civil_twilight_end?: string;
      };
    };

    if (data.status !== "OK") {
      return c.json({ error: "Sunrise API returned error status" }, 502);
    }

    const results = data.results;
    return c.json(
      {
        date,
        sunrise: results?.sunrise,
        sunset: results?.sunset,
        solar_noon: results?.solar_noon,
        day_length_seconds: results?.day_length,
        day_length_hours: results?.day_length
          ? Math.round((results.day_length / 3600) * 100) / 100
          : null,
        civil_twilight_begin: results?.civil_twilight_begin,
        civil_twilight_end: results?.civil_twilight_end,
      },
      200,
      { "Cache-Control": "public, max-age=86400" }
    );
  } catch {
    return c.json({ error: "Failed to fetch sunrise data" }, 502);
  }
});

export { sunrise };
