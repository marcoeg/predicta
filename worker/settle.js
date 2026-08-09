// Predicta settlement worker (cron, hourly at :15).
// 1) Finds open questions past close_time, checks Kalshi for settlement.
// 2) Grades every forecast: Brier vs the market-at-lock baseline. edge = market_brier - brier.
// 3) Updates calibration buckets and skill_status (the Edge-protocol ledger).
// 4) On the 16:15 UTC run, computes yesterday's daily_metrics rollups.
// Self-contained: duplicates the small Kalshi client (Workers can't import from Pages functions).

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
    "SELECT id, ticker, domain FROM questions WHERE status = 'open' AND close_time <= datetime('now') LIMIT 40"
  ).all()).results || [];
  if (!due.length) return 0;

  // fetch markets in one call (<= 40 tickers)
  const tickers = [...new Set(due.map(q => q.ticker))];
  const r = await kalshiGet(env, "/trade-api/v2/markets", "tickers=" + tickers.join(","));
  if (!r.ok) return 0; // try again next hour
  const markets = {};
  for (const m of ((await r.json()).markets || [])) markets[m.ticker] = m;

  let settledCount = 0;
  for (const q of due) {
    const m = markets[q.ticker];
    if (!m) continue;
    const st = String(m.status || "").toLowerCase();
    const result = String(m.result || "").toLowerCase(); // 'yes' | 'no' | '' until determined
    if (!(result === "yes" || result === "no")) {
      if (st === "settled" || st === "finalized") {
        // settled without binary result (voided/scalar edge case) -> void the question
        await env.DB.prepare(
          "UPDATE questions SET status='void', result='void', settled_at=datetime('now') WHERE id=?"
        ).bind(q.id).run();
      }
      continue; // market past close but not yet settled: wait
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

    // calibration buckets: decade midpoint (7 -> 5, 34 -> 35, 91 -> 95)
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

  // Edge-protocol ledger: recompute per affected player for this domain.
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
  // THE TENET: qualified only with >=20 settled forecasts in-domain AND positive recent edge.
  const qualified = (nTotal.n >= 20 && avg != null && avg > 0) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO skill_status (player_id, domain, settled_n, edge_last20_avg, qualified, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(player_id, domain) DO UPDATE SET
       settled_n = excluded.settled_n, edge_last20_avg = excluded.edge_last20_avg,
       qualified = excluded.qualified, updated_at = excluded.updated_at`
  ).bind(playerId, domain, nTotal.n, avg, qualified).run();
}

// ---------- daily rollups (run once per day, at the 16:15 UTC tick) ----------
async function rollupYesterday(env) {
  const now = new Date();
  const yest = etDate(new Date(now.getTime() - 24 * 3600 * 1000));

  // North-star: settlement-morning return rate.
  // Denominator: players who had >=1 forecast settle on ET date `yest`.
  // Numerator: of those, players with a results_view or page_view event on `yest` (ET).
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

export default {
  async scheduled(event, env, ctx) {
    const settled = await settleDueQuestions(env);
    const hourUTC = new Date().getUTCHours();
    if (hourUTC === 16) await rollupYesterday(env); // 12:15 ET, after the settlement morning
    console.log(`predicta-settle: settled=${settled} rollup=${hourUTC === 16}`);
  }
};
