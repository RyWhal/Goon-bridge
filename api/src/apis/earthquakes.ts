import { Hono } from "hono";
import type { Env } from "../types";

const earthquakes = new Hono<Env>();

// ── GET /api/earthquakes ─────────────────────────────────────────────────────
// Query USGS earthquake data for a date range
earthquakes.get("/", async (c) => {
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");

  if (!startDate || !endDate) {
    return c.json({ error: "Missing start_date or end_date (YYYY-MM-DD)" }, 400);
  }

  const minMagnitude = c.req.query("min_magnitude") ?? "2.5";
  const maxResults = c.req.query("limit") ?? "100";
  const lat = c.req.query("lat");
  const lon = c.req.query("lon");
  const maxRadius = c.req.query("max_radius_km");

  const params = new URLSearchParams({
    format: "geojson",
    starttime: startDate,
    endtime: endDate,
    minmagnitude: minMagnitude,
    limit: maxResults,
    orderby: "magnitude",
  });

  // Optional geographic filter
  if (lat && lon && maxRadius) {
    params.set("latitude", lat);
    params.set("longitude", lon);
    params.set("maxradiuskm", maxRadius);
  }

  try {
    const resp = await fetch(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`
    );
    if (!resp.ok) {
      return c.json({ error: `USGS: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch earthquake data" }, 502);
  }
});

// ── GET /api/earthquakes/summary ─────────────────────────────────────────────
// Get summary stats for a single date (for vote context)
earthquakes.get("/summary", async (c) => {
  const date = c.req.query("date");
  if (!date) {
    return c.json({ error: "Missing date (YYYY-MM-DD)" }, 400);
  }

  // Fetch next day to cover the full 24h
  const nextDay = new Date(date + "T00:00:00Z");
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endDate = nextDay.toISOString().split("T")[0];

  const params = new URLSearchParams({
    format: "geojson",
    starttime: date,
    endtime: endDate,
    minmagnitude: "2.5",
    limit: "500",
  });

  try {
    const resp = await fetch(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`
    );
    if (!resp.ok) {
      return c.json({ error: `USGS: ${resp.status}` }, 502);
    }

    const data = (await resp.json()) as {
      features?: Array<{
        properties?: { mag?: number; place?: string; time?: number };
        geometry?: { coordinates?: number[] };
      }>;
      metadata?: { count?: number };
    };

    const features = data.features ?? [];
    const count = features.length;
    const magnitudes = features
      .map((f) => f.properties?.mag ?? 0)
      .filter((m) => m > 0);

    const maxMag = magnitudes.length > 0 ? Math.max(...magnitudes) : 0;
    const avgMag =
      magnitudes.length > 0
        ? magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length
        : 0;

    // Find the largest quake
    const largest = features.reduce(
      (max, f) =>
        (f.properties?.mag ?? 0) > (max?.properties?.mag ?? 0) ? f : max,
      features[0]
    );

    return c.json(
      {
        date,
        count,
        max_magnitude: Math.round(maxMag * 10) / 10,
        avg_magnitude: Math.round(avgMag * 10) / 10,
        largest_location: largest?.properties?.place ?? null,
        largest_coordinates: largest?.geometry?.coordinates ?? null,
      },
      200,
      { "Cache-Control": "public, max-age=86400" }
    );
  } catch {
    return c.json({ error: "Failed to fetch earthquake data" }, 502);
  }
});

export { earthquakes };
