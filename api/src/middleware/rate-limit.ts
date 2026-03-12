import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Simple in-memory sliding-window rate limiter.
 *
 * This works per-isolate — Cloudflare Workers share nothing between isolates,
 * so this is "best effort" rate limiting. For strict enforcement, upgrade to
 * Cloudflare Rate Limiting rules or D1/KV-backed counters.
 *
 * Defaults: 60 requests per 60 seconds per IP.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PRODUCTION = 60;
const MAX_REQUESTS_NON_PRODUCTION = 600;

// Periodic cleanup to avoid unbounded memory growth
let lastCleanup = Date.now();
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < WINDOW_MS) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function getClientIp(c: Context<Env>): string {
  return c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

export async function rateLimitMiddleware(c: Context<Env>, next: Next) {
  cleanup();
  const maxRequests =
    c.env.ENVIRONMENT === "production"
      ? MAX_REQUESTS_PRODUCTION
      : MAX_REQUESTS_NON_PRODUCTION;

  const ip = getClientIp(c);
  const now = Date.now();
  let entry = store.get(ip);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  }

  entry.count++;

  // Always set rate limit headers
  c.header("X-RateLimit-Limit", maxRequests.toString());
  c.header("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count).toString());
  c.header("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000).toString());

  if (entry.count > maxRequests) {
    return c.json(
      { error: "Rate limit exceeded. Try again later." },
      429,
      { "Retry-After": Math.ceil((entry.resetAt - now) / 1000).toString() }
    );
  }

  await next();
}
