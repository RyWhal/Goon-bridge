/**
 * Cloudflare Pages Function – catch-all proxy for /api/*
 *
 * Forwards every request under /api/ to the Worker at
 * vibe-api.ryanjpwhalen.workers.dev, preserving path and query string.
 *
 * If the Worker returns a non-JSON error (e.g. an HTML 502 page from
 * Cloudflare) the proxy rewraps it as a JSON error so the frontend always
 * gets a parseable response.
 */
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
    return new Response(
      JSON.stringify({
        error: "Unable to reach API worker",
        detail: e instanceof Error ? e.message : "Network error",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // If the Worker returned an error with a non-JSON body (e.g. Cloudflare's
  // HTML 502/503 page), convert it to JSON so the frontend can parse it.
  if (!resp.ok) {
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const body = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: `API worker returned ${resp.status}`,
          detail: body.slice(0, 300) || undefined,
        }),
        {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // Happy path or JSON error — forward as-is
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
};
