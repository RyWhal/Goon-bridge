import { Hono } from "hono";
import type { Env } from "../types";

const lunar = new Hono<Env>();

/**
 * Calculate lunar phase for a given date.
 *
 * Uses a known new moon reference (Jan 6, 2000 18:14 UTC) and the
 * synodic period (~29.53059 days) to determine the phase.
 */
function getLunarPhase(date: Date): {
  phase: string;
  illumination: number;
  days_into_cycle: number;
  emoji: string;
} {
  // Reference new moon: January 6, 2000 18:14 UTC
  const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0);
  const SYNODIC_PERIOD = 29.53059;

  const diffMs = date.getTime() - KNOWN_NEW_MOON;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const cyclePosition = ((diffDays % SYNODIC_PERIOD) + SYNODIC_PERIOD) % SYNODIC_PERIOD;
  const normalizedPosition = cyclePosition / SYNODIC_PERIOD;

  // Calculate illumination (0 at new moon, 1 at full moon)
  const illumination =
    Math.round((1 - Math.cos(normalizedPosition * 2 * Math.PI)) * 50) / 100;

  // Determine phase name and emoji
  let phase: string;
  let emoji: string;
  if (normalizedPosition < 0.0625) {
    phase = "New Moon";
    emoji = "\u{1F311}";
  } else if (normalizedPosition < 0.1875) {
    phase = "Waxing Crescent";
    emoji = "\u{1F312}";
  } else if (normalizedPosition < 0.3125) {
    phase = "First Quarter";
    emoji = "\u{1F313}";
  } else if (normalizedPosition < 0.4375) {
    phase = "Waxing Gibbous";
    emoji = "\u{1F314}";
  } else if (normalizedPosition < 0.5625) {
    phase = "Full Moon";
    emoji = "\u{1F315}";
  } else if (normalizedPosition < 0.6875) {
    phase = "Waning Gibbous";
    emoji = "\u{1F316}";
  } else if (normalizedPosition < 0.8125) {
    phase = "Last Quarter";
    emoji = "\u{1F317}";
  } else if (normalizedPosition < 0.9375) {
    phase = "Waning Crescent";
    emoji = "\u{1F318}";
  } else {
    phase = "New Moon";
    emoji = "\u{1F311}";
  }

  return {
    phase,
    illumination,
    days_into_cycle: Math.round(cyclePosition * 100) / 100,
    emoji,
  };
}

// ── GET /api/lunar ───────────────────────────────────────────────────────────
// Get lunar phase for a date (or today)
lunar.get("/", async (c) => {
  const dateStr = c.req.query("date");
  let date: Date;

  if (dateStr) {
    date = new Date(dateStr + "T12:00:00Z");
    if (isNaN(date.getTime())) {
      return c.json({ error: "Invalid date format (use YYYY-MM-DD)" }, 400);
    }
  } else {
    date = new Date();
  }

  const result = getLunarPhase(date);

  return c.json(
    {
      date: date.toISOString().split("T")[0],
      ...result,
    },
    200,
    { "Cache-Control": "public, max-age=86400" }
  );
});

// ── GET /api/lunar/range ─────────────────────────────────────────────────────
// Get lunar phases for a date range
lunar.get("/range", async (c) => {
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");

  if (!startDate || !endDate) {
    return c.json({ error: "Missing start_date or end_date (YYYY-MM-DD)" }, 400);
  }

  const start = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return c.json({ error: "Invalid date format" }, 400);
  }

  // Limit to 366 days
  const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 366) {
    return c.json({ error: "Date range cannot exceed 366 days" }, 400);
  }

  const phases: Array<{ date: string; phase: string; illumination: number; emoji: string }> = [];
  const current = new Date(start);
  while (current <= end) {
    const result = getLunarPhase(current);
    phases.push({
      date: current.toISOString().split("T")[0],
      phase: result.phase,
      illumination: result.illumination,
      emoji: result.emoji,
    });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return c.json(
    { phases },
    200,
    { "Cache-Control": "public, max-age=86400" }
  );
});

export { lunar, getLunarPhase };
