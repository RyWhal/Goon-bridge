import { Hono } from "hono";
import type { Env } from "../types";

const weather = new Hono<Env>();

// ── GET /api/weather/historical ──────────────────────────────────────────────
// Fetch historical weather for a location and date range using Open-Meteo
weather.get("/historical", async (c) => {
  const lat = c.req.query("lat") ?? "38.89";   // DC default
  const lon = c.req.query("lon") ?? "-77.04";
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");

  if (!startDate || !endDate) {
    return c.json({ error: "Missing start_date or end_date (YYYY-MM-DD)" }, 400);
  }

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: startDate,
    end_date: endDate,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max",
    timezone: "America/New_York",
  });

  try {
    const resp = await fetch(
      `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`
    );
    if (!resp.ok) {
      return c.json({ error: `Open-Meteo: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=86400" });
  } catch {
    return c.json({ error: "Failed to fetch weather data" }, 502);
  }
});

// ── GET /api/weather/current ─────────────────────────────────────────────────
// Fetch current weather for DC (or specified location)
weather.get("/current", async (c) => {
  const lat = c.req.query("lat") ?? "38.89";
  const lon = c.req.query("lon") ?? "-77.04";

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,weathercode,windspeed_10m,relative_humidity_2m,cloud_cover",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode",
    timezone: "America/New_York",
    forecast_days: "1",
  });

  try {
    const resp = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params.toString()}`
    );
    if (!resp.ok) {
      return c.json({ error: `Open-Meteo: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=900" });
  } catch {
    return c.json({ error: "Failed to fetch weather data" }, 502);
  }
});

export { weather };
