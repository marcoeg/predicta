// Cloudflare Pages Function: GET /api/markets?tickers=T1,T2,...
// Proxies Kalshi public market data so the browser avoids CORS.
// If KALSHI_KEY_ID + KALSHI_PRIVATE_KEY are configured as Pages secrets,
// requests are RSA-PSS signed (per-account rate limits instead of the
// shared-IP budget that 429s Cloudflare egress). Otherwise falls back to
// unauthenticated proxying. The private key never leaves the server.

const API_HOST = "https://api.elections.kalshi.com";
const PATH = "/trade-api/v2/markets";

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derLen(tag, len) {
  if (len < 128) return new Uint8Array([tag, len]);
  const b = [];
  let l = len;
  while (l > 0) { b.unshift(l & 0xff); l >>= 8; }
  return new Uint8Array([tag, 0x80 | b.length, ...b]);
}

// Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo (WebCrypto needs PKCS#8).
function pkcs1ToPkcs8(der) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algId = new Uint8Array([0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00]);
  const octet = derLen(0x04, der.length);
  const inner = version.length + algId.length + octet.length + der.length;
  const seq = derLen(0x30, inner);
  const out = new Uint8Array(seq.length + inner);
  let o = 0;
  for (const part of [seq, version, algId, octet, der]) { out.set(part, o); o += part.length; }
  return out;
}

async function signedHeaders(env) {
  const pem = env.KALSHI_PRIVATE_KEY;
  let der = pemToDer(pem);
  if (pem.includes("RSA PRIVATE KEY")) der = pkcs1ToPkcs8(der); // PKCS#1 -> PKCS#8
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]
  );
  const ts = Date.now().toString();
  const msg = new TextEncoder().encode(ts + "GET" + PATH);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msg));
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return {
    "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": btoa(bin),
    "KALSHI-ACCESS-TIMESTAMP": ts,
    accept: "application/json"
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const tickers = (url.searchParams.get("tickers") || "").replace(/[^A-Za-z0-9.,\-]/g, "");
  if (!tickers) {
    return new Response(JSON.stringify({ error: "tickers required" }), {
      status: 400, headers: { "content-type": "application/json" }
    });
  }
  let headers = { accept: "application/json" };
  let mode = "public";
  if (env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY) {
    try { headers = await signedHeaders(env); mode = "key"; } catch (e) { mode = "keyerr"; }
  }
  const upstream = API_HOST + PATH + "?tickers=" + tickers;
  const hit = () => fetch(upstream, {
    headers,
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
      "access-control-allow-origin": "*",
      "x-predicta-auth": mode
    }
  });
}
