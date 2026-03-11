/**
 * Cloudflare Pages Function – catch-all proxy for /api/*
 *
 * Forwards every request under /api/ to the Worker at
 * vibe-api.ryanjpwhalen.workers.dev, preserving path and query string.
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

  try {
    const resp = await fetch(target.toString(), {
      method: context.request.method,
      headers,
      body:
        context.request.method !== "GET" && context.request.method !== "HEAD"
          ? context.request.body
          : undefined,
    });

    // Return the Worker's response directly
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
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
};
