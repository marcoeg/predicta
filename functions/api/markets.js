// Cloudflare Pages Function: GET /api/markets?tickers=T1,T2,...
// Proxies Kalshi's public market-data API (no auth required) so the
// browser avoids CORS. Read-only, GET-only, ticker charset allowlisted.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const tickers = (url.searchParams.get("tickers") || "").replace(/[^A-Za-z0-9.,\-]/g, "");
  if (!tickers) {
    return new Response(JSON.stringify({ error: "tickers required" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  const upstream = "https://api.elections.kalshi.com/trade-api/v2/markets?tickers=" + tickers;
  const resp = await fetch(upstream, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 30, cacheEverything: true }
  });
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*"
    }
  });
}
