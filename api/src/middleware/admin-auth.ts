import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Admin authentication middleware for mutation endpoints.
 *
 * Requires the `ADMIN_API_KEY` secret to be set. Requests must include
 * a matching `Authorization: Bearer <token>` header.
 *
 * In non-production environments without a configured key, requests are
 * allowed through to simplify local development.
 */
export async function requireAdminAuth(c: Context<Env>, next: Next) {
  const expectedKey = c.env.ADMIN_API_KEY;

  // In non-production without a key configured, allow requests through
  // so local development isn't blocked.
  if (!expectedKey && c.env.ENVIRONMENT !== "production") {
    await next();
    return;
  }

  if (!expectedKey) {
    return c.json({ error: "Admin API key not configured" }, 503);
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "Invalid Authorization header format (expected: Bearer <token>)" }, 401);
  }

  const providedKey = match[1].trim();

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(expectedKey, providedKey)) {
    return c.json({ error: "Invalid admin API key" }, 403);
  }

  await next();
}

/**
 * Constant-time string comparison to prevent timing-based attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
