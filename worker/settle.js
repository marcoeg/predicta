// Predicta worker: settlement (hourly at :15) + daily editorial (10:00 UTC = 6 AM ET).
// Settlement: finds open questions past close_time, checks Kalshi, grades every forecast
// (Brier vs market-at-lock; edge = market_brier - brier), updates calibration buckets and
// the Edge-protocol ledger (skill_status), and computes prior-day rollups at 16:15 UTC.
// Editorial: composes and PUBLISHES the daily edition from live Kalshi candidates by rule:
// closest-to-even daily weather bracket, open CPI print, nearest Fed meeting leg, live WTI
// strike, long-fuse Fed hold. Skips tickers still open from prior editions. Auto-publish.
// Self-contained: duplicates the small Kalshi client (Workers cannot import Pages functions).

const API_HOST = "https://api.elections.kalshi.com";

// ---------- kalshi client (same scheme as functions/_lib/kalshi.js) ----------
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
async function kalshiGet(env, path, query) {
  let headers = { accept: "application/json" };
  if (env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY) {
    try {
      const pem = env.KALSHI_PRIVATE_KEY;
      let der = pemToDer(pem);
      if (pem.includes("RSA PRIVATE KEY")) der = pkcs1ToPkcs8(der);
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
      const ts = Date.now().toString();
      const msg = new TextEncoder().encode(ts + "GET" + path);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msg));
      let bin = "";
      for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
      headers = {
        "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID,
        "KALSHI-ACCESS-SIGNATURE": btoa(bin),
        "KALSHI-ACCESS-TIMESTAMP": ts,
        accept: "application/json"
      };
    } catch (e) { /* anonymous fallback */ }
  }
  const url = API_HOST + path + (query ? "?" + query : "");
  let resp = await fetch(url, { headers });
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await fetch(url, { headers });
  }
  return resp;
}
async function kalshiMarkets(env, query) {
  const r = await kalshiGet(env, "/trade-api/v2/markets", query);
  if (!r.ok) { console.log(`kalshi-fail status=${r.status} q=${String(query).slice(0, 60)}`); return []; }
  return (await r.json()).markets || [];
}
function midCents(m) {
  const b = parseFloat(m.yes_bid_dollars || "0");
  const a = parseFloat(m.yes_ask_dollars || "0");
  if (a <= 0 && b <= 0) return null;
  const mid = (a > 0 && b > 0) ? (a + b) / 2 : (a > 0 ? a : b);
  return Math.round(mid * 100);
}
function etDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

// ---------- settlement ----------
async function settleDueQuestions(env) {
  const due = (await env.DB.prepare(
    "SELECT id, ticker, domain FROM questions WHERE status = 'open' AND strftime('%s', replace(replace(close_time,'T',' '),'Z','')) <= strftime('%s','now') LIMIT 40"
  ).all()).results || [];
  if (!due.length) return 0;

  const tickers = [...new Set(due.map(q => q.ticker))];
  const markets = {};
  for (const m of await kalshiMarkets(env, "tickers=" + tickers.join(","))) markets[m.ticker] = m;

  let settledCount = 0;
  for (const q of due) {
    const m = markets[q.ticker];
    if (!m) continue;
    const st = String(m.status || "").toLowerCase();
    const result = String(m.result || "").toLowerCase();
    if (!(result === "yes" || result === "no")) {
      if (st === "settled" || st === "finalized") {
        await env.DB.prepare(
          "UPDATE questions SET status='void', result='void', settled_at=datetime('now') WHERE id=?"
        ).bind(q.id).run();
      }
      continue;
    }
    const outcome = result === "yes" ? 1 : 0;
    await gradeQuestion(env, q, outcome, midCents(m));
    settledCount++;
  }
  return settledCount;
}

async function gradeQuestion(env, q, outcome, settleCents) {
  const fs = (await env.DB.prepare(
    "SELECT player_id, prob, market_cents_at_lock FROM forecasts WHERE question_id = ? AND brier IS NULL"
  ).bind(q.id).all()).results || [];

  const stmts = [];
  for (const f of fs) {
    const p = f.prob / 100;
    const pm = (f.market_cents_at_lock ?? 50) / 100;
    const brier = (p - outcome) * (p - outcome);
    const marketBrier = (pm - outcome) * (pm - outcome);
    const edge = marketBrier - brier;
    stmts.push(env.DB.prepare(
      "UPDATE forecasts SET brier=?, market_brier=?, edge=? WHERE player_id=? AND question_id=?"
    ).bind(brier, marketBrier, edge, f.player_id, q.id));
    const bucket = Math.min(95, Math.max(5, Math.floor(f.prob / 10) * 10 + 5));
    for (const dom of [q.domain, "all"]) {
      stmts.push(env.DB.prepare(
        `INSERT INTO calibration (player_id, domain, bucket, n, hits) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(player_id, domain, bucket) DO UPDATE SET n = n + 1, hits = hits + ?`
      ).bind(f.player_id, dom, bucket, outcome, outcome));
    }
  }
  stmts.push(env.DB.prepare(
    "UPDATE questions SET status='settled', result=?, settle_price_cents=?, settled_at=datetime('now') WHERE id=?"
  ).bind(outcome ? "yes" : "no", settleCents, q.id));
  await env.DB.batch(stmts);
  for (const f of fs) await recomputeSkill(env, f.player_id, q.domain);
}

async function recomputeSkill(env, playerId, domain) {
  const rows = (await env.DB.prepare(
    `SELECT f.edge FROM forecasts f JOIN questions q ON q.id = f.question_id
     WHERE f.player_id = ? AND q.domain = ? AND f.edge IS NOT NULL
     ORDER BY q.settled_at DESC LIMIT 20`
  ).bind(playerId, domain).all()).results || [];
  const nTotal = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM forecasts f JOIN questions q ON q.id = f.question_id
     WHERE f.player_id = ? AND q.domain = ? AND f.edge IS NOT NULL`
  ).bind(playerId, domain).first();
  const avg = rows.length ? rows.reduce((s, r) => s + r.edge, 0) / rows.length : null;
  const qualified = (nTotal.n >= 20 && avg != null && avg > 0) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO skill_status (player_id, domain, settled_n, edge_last20_avg, qualified, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(player_id, domain) DO UPDATE SET
       settled_n = excluded.settled_n, edge_last20_avg = excluded.edge_last20_avg,
       qualified = excluded.qualified, updated_at = excluded.updated_at`
  ).bind(playerId, domain, nTotal.n, avg, qualified).run();
}

// ---------- daily rollups (16:15 UTC tick) ----------
async function rollupYesterday(env) {
  const now = new Date();
  const yest = etDate(new Date(now.getTime() - 24 * 3600 * 1000));
  const metrics = [
    ["settlement_return_rate", `
      WITH settled_players AS (
        SELECT DISTINCT f.player_id AS pid
        FROM forecasts f JOIN questions q ON q.id = f.question_id
        WHERE date(q.settled_at, '-4 hours') = ?1
      ),
      returned AS (
        SELECT DISTINCT e.player_id AS pid FROM events e
        WHERE e.player_id IS NOT NULL
          AND e.name IN ('results_view','page_view','edition_start')
          AND date(e.ts, '-4 hours') = ?1
      )
      SELECT CASE WHEN (SELECT COUNT(*) FROM settled_players) = 0 THEN 0
        ELSE 1.0 * (SELECT COUNT(*) FROM settled_players s JOIN returned r ON r.pid = s.pid)
             / (SELECT COUNT(*) FROM settled_players) END AS v`],
    ["editions_completed", `
      SELECT COUNT(*) AS v FROM (
        SELECT f.player_id, q.edition_id, COUNT(*) AS locks
        FROM forecasts f JOIN questions q ON q.id = f.question_id
        WHERE date(f.locked_at, '-4 hours') = ?1
        GROUP BY f.player_id, q.edition_id HAVING locks >= 5)`],
    ["players_locked", `
      SELECT COUNT(DISTINCT player_id) AS v FROM forecasts WHERE date(locked_at, '-4 hours') = ?1`],
    ["new_players", `
      SELECT COUNT(*) AS v FROM players WHERE date(created_at, '-4 hours') = ?1`],
    ["share_copies", `
      SELECT COUNT(*) AS v FROM events WHERE name = 'share_copy' AND date(ts, '-4 hours') = ?1`]
  ];
  for (const [name, sql] of metrics) {
    const row = await env.DB.prepare(sql).bind(yest).first();
    await env.DB.prepare(
      "INSERT INTO daily_metrics (date, metric, value) VALUES (?, ?, ?) ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value"
    ).bind(yest, name, row && row.v != null ? row.v : 0).run();
  }
}

// ---------- daily editorial (10:00 UTC tick = 6 AM ET) ----------
// Template: 2 fast (rotating-city temperature + Bitcoin 5 PM ET) / 1 macro print (CPI)
// / 1 weeks-out event (sooner of WTI strike, Fed leg) / 1 long fuse (farthest Fed hold).
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const CITY_ROTATION = [
  ["KXHIGHDEN", "Denver"],        // Sun
  ["KXHIGHTPHX", "Phoenix"],      // Mon
  ["KXHIGHTBOS", "Boston"],       // Tue
  ["KXHIGHHOU", "Houston"],       // Wed
  ["KXHIGHPHIL", "Philadelphia"], // Thu
  ["KXHIGHTSATX", "San Antonio"], // Fri
  ["KXHIGHTOKC", "Oklahoma City"] // Sat
];

function pickClosest(markets, target, lo, hi, excluded) {
  let best = null, bestDist = 1e9;
  for (const m of markets) {
    if (String(m.status || "").toLowerCase() !== "active") continue;
    if (excluded.has(m.ticker)) continue;
    const c = midCents(m);
    if (c == null || c < lo || c > hi) continue;
    const d = Math.abs(c - target);
    if (d < bestDist) { best = { m: m, mid: c }; bestDist = d; }
  }
  return best;
}
function seriesUrl(ticker) {
  return "https://kalshi.com/markets/" + String(ticker).split("-")[0].toLowerCase();
}
function etDow(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

async function buildDailyEdition(env) {
  const today = etDate(new Date());
  const exists = await env.DB.prepare("SELECT id FROM editions WHERE date = ?").bind(today).first();
  if (exists) return 0;

  const openTickers = new Set(
    ((await env.DB.prepare("SELECT ticker FROM questions WHERE status = 'open'").all()).results || [])
      .map(r => r.ticker)
  );
  const [y, mo, dd] = today.split("-");
  const dstamp = y.slice(2) + MONTHS[parseInt(mo, 10) - 1] + dd;
  const picks = [];

  // Slot 1 - CLIMATE (fast): rotating city daily high, bracket closest to even odds
  try {
    const dow = etDow(today);
    for (let k = 0; k < 7; k++) {
      const [series, city] = CITY_ROTATION[(dow + k) % 7];
      const ms = await kalshiMarkets(env, "event_ticker=" + series + "-" + dstamp + "&limit=100");
      const p = pickClosest(ms, 50, 10, 90, openTickers);
      if (p) {
        picks.push({
          cat: "CLIMATE · TODAY", domain: "climate",
          text: city + " tops out at " + (p.m.yes_sub_title || p.m.subtitle || "the posted bracket") + " today?",
          ctx: "Settles on the National Weather Service report - tomorrow morning brings the verdict.",
          m: p
        });
        break;
      }
    }
  } catch (e) { /* skip slot */ }

  // Slot 2 - MARKETS (fast): Bitcoin at the 5 PM ET check, bracket closest to even odds
  try {
    const ms = await kalshiMarkets(env, "event_ticker=KXBTCD-" + dstamp + "17&limit=100");
    const p = pickClosest(ms, 50, 10, 90, openTickers);
    if (p) picks.push({
      cat: "MARKETS · TODAY", domain: "crypto",
      text: "Bitcoin at 5 PM ET today: " + (p.m.yes_sub_title || p.m.subtitle || "the posted band") + "?",
      ctx: "Pure market noise, settled tonight - a lesson in humility. Graded off the CF Benchmarks index.",
      m: p
    });
  } catch (e) { /* skip slot */ }

  // Slot 3 - MACRO PRINT: nearest open CPI event, strike closest to even odds
  try {
    const ms = await kalshiMarkets(env, "series_ticker=KXCPI&status=open&limit=100");
    ms.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    const nearest = ms.filter(m => m.event_ticker === (ms[0] && ms[0].event_ticker));
    const p = pickClosest(nearest, 50, 8, 92, openTickers);
    if (p) picks.push({
      cat: "ECONOMICS · INFLATION", domain: "econ",
      text: p.m.title, ctx: "The BLS print settles it - one number, one morning.", m: p
    });
  } catch (e) { /* skip slot */ }

  // Slot 4 - THE EVENT (weeks out): sooner of live WTI strike and nearest Fed leg
  try {
    let wti = null, fed = null;
    const wms = await kalshiMarkets(env, "series_ticker=KXWTIMAX&status=open&limit=100");
    wms.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    const wNear = wms.filter(m => m.event_ticker === (wms[0] && wms[0].event_ticker));
    wti = pickClosest(wNear, 20, 4, 60, openTickers);

    const fms = await kalshiMarkets(env, "series_ticker=KXFEDDECISION&status=open&limit=100");
    const future = fms.filter(m => new Date(m.close_time) > new Date(Date.now() + 86400000));
    future.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    const fNear = future.filter(m => m.event_ticker === (future[0] && future[0].event_ticker));
    fed = pickClosest(fNear, 50, 12, 88, openTickers);

    let p = null, cat = "", dom = "", ctx = "";
    if (wti && (!fed || new Date(wti.m.close_time) <= new Date(fed.m.close_time))) {
      p = wti; cat = "ENERGY"; dom = "energy"; ctx = "Any daily settle above the strike ends it early.";
    } else if (fed) {
      p = fed; cat = "ECONOMICS · THE FED"; dom = "econ"; ctx = "FOMC decision day settles it.";
    }
    if (p) picks.push({ cat: cat, domain: dom, text: p.m.title, ctx: ctx, m: p });
  } catch (e) { /* skip slot */ }

  // Slot 5 - THE LONG GAME: farthest Fed meeting, hold leg preferred
  try {
    const ms = await kalshiMarkets(env, "series_ticker=KXFEDDECISION&status=open&limit=100");
    ms.sort((a, b) => new Date(b.close_time) - new Date(a.close_time));
    const farthest = ms.filter(m => m.event_ticker === (ms[0] && ms[0].event_ticker));
    const hold = farthest.filter(m => /-H0$/.test(m.ticker));
    const p = pickClosest(hold.length ? hold : farthest, 50, 5, 95, openTickers);
    if (p && !picks.some(x => x.m.m.ticker === p.m.ticker)) picks.push({
      cat: "THE LONG GAME", domain: "econ",
      text: p.m.title, ctx: "Settles far out - the slow half of your calibration curve.", m: p
    });
  } catch (e) { /* skip slot */ }

  if (picks.length < 3) return -1; // not enough material; leave yesterday standing

  const prev = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM editions").first();
  const num = (prev.m || 0) + 1;
  const stmts = [env.DB.prepare(
    "INSERT INTO editions (id, date, status) VALUES (?, ?, 'published')"
  ).bind(num, today)];
  picks.forEach((p, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO questions (edition_id, slot, category, domain, text, context, ticker, market_url, lock_price_cents, close_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(num, i + 1, p.cat, p.domain, p.text, p.ctx, p.m.m.ticker, seriesUrl(p.m.m.ticker), p.m.mid, p.m.m.close_time));
  });
  await env.DB.batch(stmts);
  return num;
}

export default {
  // Diagnostics + manual self-heal. Plain GET = read-only health check (no writes,
  // no secrets exposed). GET ?run=1 = run the same idempotent work as the hourly cron:
  // settle due questions, then ensure today's edition exists (no-op when nothing is due).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("run") === "1") {
      const settled = await settleDueQuestions(env);
      const edition = await buildDailyEdition(env);
      console.log(`predicta(manual): settled=${settled} edition=${edition}`);
      return new Response(JSON.stringify({ ran: true, settled, edition }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" }
      });
    }
    const r = await kalshiGet(env, "/trade-api/v2/markets", "tickers=KXFEDDECISION-26SEP-H0");
    let n = null;
    try { if (r.ok) n = ((await r.json()).markets || []).length; } catch (e) { /* body unreadable */ }
    return new Response(JSON.stringify({
      keyed: !!(env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY),
      kalshi_status: r.status,
      markets_returned: n,
      db_bound: !!env.DB
    }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
  async scheduled(event, env, ctx) {
    // Settlement runs FIRST: grading players must never be blocked by editorial issues.
    const settled = await settleDueQuestions(env);
    // Self-healing editorial: from 10:00 UTC (6 AM EDT) onward, EVERY run ensures
    // today's edition exists (buildDailyEdition is idempotent via the date check).
    let edition = null;
    const hourUTC = new Date().getUTCHours();
    if (hourUTC >= 10) edition = await buildDailyEdition(env);
    if (hourUTC === 16) await rollupYesterday(env);
    console.log(`predicta: settled=${settled} edition=${edition} rollup=${hourUTC === 16}`);
  }
};
