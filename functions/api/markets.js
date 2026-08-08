// Cloudflare Pages Function: GET /api/markets?tickers=T1,T2,...
// Proxies Kalshi public market data (no auth) so the browser avoids CORS.
// Kalshi rate-limits shared egress IPs, so: retry once on 429 and edge-cache
// successful responses for 60s (one good fetch per minute serves everyone).
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
  const hit = () => fetch(upstream, {
    headers: { accept: "application/json" },
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 60, "400-499": 0, "500-599": 0 } }
  });
  let resp = await hit();
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 1300));
    resp = await hit();
  }
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      "content-type": "application/json",
      "cache-control": resp.ok ? "public, max-age=30" : "no-store",
      "access-control-allow-origin": "*"
    }
  });
}
