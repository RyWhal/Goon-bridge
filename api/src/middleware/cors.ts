import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Parse the ALLOWED_ORIGINS env var into a Set for fast lookup.
 * In development, falls back to allowing localhost origins.
 */
function getAllowedOrigins(env: Env["Bindings"]): Set<string> {
  const raw = env.ALLOWED_ORIGINS ?? "";
  const origins = new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );

  // In development, always allow localhost
  if (env.ENVIRONMENT !== "production") {
    origins.add("http://localhost:5175");
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5175");
    origins.add("http://127.0.0.1:5173");
  }

  return origins;
}

/**
 * CORS middleware — validates Origin against allowed list.
 * Returns 403 for disallowed cross-origin requests.
 */
export async function corsMiddleware(c: Context<Env>, next: Next) {
  const origin = c.req.header("Origin");
  const allowedOrigins = getAllowedOrigins(c.env);

  // Preflight
  if (c.req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin ?? "",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  await next();

  // Reflect allowed origin (not wildcard)
  if (origin && allowedOrigins.has(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
}
