// POST /api/forecast — lock a probability. First write wins; re-locks are rejected.
// Server records the market mid at lock time (scoring baseline is server-authoritative).

import { marketsByTickers, midCents, json } from "../_lib/kalshi.js";

const UUIDISH = /^[A-Za-z0-9\-]{8,64}$/;

export async function onRequestPost({ env, request }) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: "bad json" }, 400);
  const { device_id, question_id, prob } = b;
  if (!UUIDISH.test(String(device_id || ""))) return json({ error: "bad device_id" }, 400);
  const qid = Number(question_id), p = Number(prob);
  if (!Number.isInteger(qid) || !Number.isInteger(p) || p < 1 || p > 99) {
    return json({ error: "bad question_id or prob" }, 400);
  }

  const q = await env.DB.prepare(
    "SELECT id, ticker, close_time, lock_price_cents, status FROM questions WHERE id = ?"
  ).bind(qid).first();
  if (!q || q.status !== "open") return json({ error: "question not open" }, 409);
  if (new Date(q.close_time) <= new Date()) return json({ error: "question closed" }, 409);

  let cents = null;
  try {
    const ms = await marketsByTickers(env, [q.ticker]);
    if (ms[0]) cents = midCents(ms[0]);
  } catch (e) { /* fallback below */ }
  if (cents == null) cents = q.lock_price_cents;

  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)"
  ).bind(device_id, now).run();

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO forecasts (player_id, question_id, prob, market_cents_at_lock, locked_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(device_id, qid, p, cents, now).run();

  if (!res.meta || res.meta.changes === 0) {
    const existing = await env.DB.prepare(
      "SELECT prob, market_cents_at_lock FROM forecasts WHERE player_id = ? AND question_id = ?"
    ).bind(device_id, qid).first();
    return json({ locked: false, already: true, existing });
  }

  // server-side event: locks are the one funnel step too important to lose to ad-blockers
  await env.DB.prepare(
    "INSERT INTO events (ts, player_id, name, props) VALUES (?, ?, 'q_lock_server', ?)"
  ).bind(now, device_id, JSON.stringify({ question_id: qid, prob: p, market_cents: cents })).run();

  return json({ locked: true, market_cents: cents });
}
