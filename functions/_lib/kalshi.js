// Shared Kalshi client for Pages Functions (same signing scheme as /api/markets).
// Signs with KALSHI_KEY_ID + KALSHI_PRIVATE_KEY when present; anonymous otherwise.

const API_HOST = "https://api.elections.kalshi.com";

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

async function signedHeaders(env, path) {
  const pem = env.KALSHI_PRIVATE_KEY;
  let der = pemToDer(pem);
  if (pem.includes("RSA PRIVATE KEY")) der = pkcs1ToPkcs8(der);
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]
  );
  const ts = Date.now().toString();
  const msg = new TextEncoder().encode(ts + "GET" + path);
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

export async function kalshiGet(env, path, query) {
  let headers = { accept: "application/json" };
  if (env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY) {
    try { headers = await signedHeaders(env, path); } catch (e) { /* fall back to anonymous */ }
  }
  const url = API_HOST + path + (query ? "?" + query : "");
  let resp = await fetch(url, { headers });
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 1300));
    resp = await fetch(url, { headers });
  }
  return resp;
}

export async function marketsByTickers(env, tickers) {
  const clean = tickers.map(t => String(t).replace(/[^A-Za-z0-9.\-]/g, "")).filter(Boolean);
  if (!clean.length) return [];
  const r = await kalshiGet(env, "/trade-api/v2/markets", "tickers=" + clean.join(","));
  if (!r.ok) throw new Error("kalshi " + r.status);
  const j = await r.json();
  return j.markets || [];
}

export function midCents(m) {
  const b = parseFloat(m.yes_bid_dollars || "0");
  const a = parseFloat(m.yes_ask_dollars || "0");
  if (a <= 0 && b <= 0) return null;
  const mid = (a > 0 && b > 0) ? (a + b) / 2 : (a > 0 ? a : b);
  return Math.round(mid * 100);
}

export function etDate(d) {
  // ET calendar date, e.g. "2026-08-08" — editions live on the market's clock.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d || new Date());
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
