import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Security headers middleware — applied to all API responses.
 */
export async function securityHeaders(c: Context<Env>, next: Next) {
  await next();

  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Prevent API responses from being cached by shared caches with credentials
  c.header("X-XSS-Protection", "0"); // Modern browsers: CSP handles this, disable legacy filter
}
