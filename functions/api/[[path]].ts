/**
 * Cloudflare Pages Function – catch-all proxy for /api/*
 *
 * Forwards every request under /api/ to the Worker at
 * vibe-api.ryanjpwhalen.workers.dev, preserving path and query string.
 *
 * IMPORTANT: Cloudflare's CDN replaces the body of any 502/503/504
 * response with its own HTML error page. To ensure the frontend always
 * receives parseable JSON errors, this proxy downgrades 5xx responses
 * to HTTP 200 with an `error` field in the JSON body.
 */

function jsonError(error: string, detail?: string, upstreamStatus?: number): Response {
  return new Response(
    JSON.stringify({ error, detail: detail || undefined, upstreamStatus }),
    {
      // Return 200 so Cloudflare's CDN does not replace the body with
      // an HTML error page. The frontend checks for the `error` field.
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const target = new URL(
    `${url.pathname}${url.search}`,
    "https://vibe-api.ryanjpwhalen.workers.dev"
  );

  const headers = new Headers(context.request.headers);
  // Remove host so the Worker sees its own host
  headers.delete("host");

  let resp: Response;
  try {
    resp = await fetch(target.toString(), {
      method: context.request.method,
      headers,
      body:
        context.request.method !== "GET" && context.request.method !== "HEAD"
          ? context.request.body
          : undefined,
    });
  } catch (e) {
    return jsonError(
      "Unable to reach API worker",
      e instanceof Error ? e.message : "Network error"
    );
  }

  // If the Worker returned a server error, read the body and wrap it so
  // Cloudflare can't replace it with an HTML error page.
  if (resp.status >= 500) {
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // Worker returned JSON — re-wrap it in a 200 so Cloudflare passes
      // it through, but preserve the original error payload.
      const body = await resp.text().catch(() => "{}");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Non-JSON (e.g. HTML error page from Cloudflare Workers)
    const body = await resp.text().catch(() => "");
    const snippet = body.replace(/<[^>]*>/g, " ").trim().slice(0, 300);
    return jsonError(
      `API worker returned ${resp.status}`,
      snippet || undefined,
      resp.status
    );
  }

  // 2xx / 3xx / 4xx — forward as-is (Cloudflare won't touch these)
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
};
