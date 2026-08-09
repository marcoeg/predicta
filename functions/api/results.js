// GET /api/results?device_id=... — the "while you slept" payload:
// settled forecasts (graded), pending forecasts, calibration curve, Edge-protocol status.

import { json } from "../_lib/kalshi.js";

const UUIDISH = /^[A-Za-z0-9\-]{8,64}$/;

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const device = url.searchParams.get("device_id") || "";
  if (!UUIDISH.test(device)) return json({ error: "bad device_id" }, 400);

  const settled = (await env.DB.prepare(
    `SELECT q.text, q.category, q.domain, q.result, q.settled_at,
            f.prob, f.market_cents_at_lock, f.brier, f.market_brier, f.edge
     FROM forecasts f JOIN questions q ON q.id = f.question_id
     WHERE f.player_id = ? AND q.status = 'settled'
     ORDER BY q.settled_at DESC LIMIT 50`
  ).bind(device).all()).results || [];

  const pending = (await env.DB.prepare(
    `SELECT q.text, q.category, q.close_time, f.prob, f.market_cents_at_lock, f.locked_at
     FROM forecasts f JOIN questions q ON q.id = f.question_id
     WHERE f.player_id = ? AND q.status = 'open'
     ORDER BY q.close_time ASC`
  ).bind(device).all()).results || [];

  const calibration = (await env.DB.prepare(
    `SELECT domain, bucket, n, hits FROM calibration WHERE player_id = ? ORDER BY domain, bucket`
  ).bind(device).all()).results || [];

  const skill = (await env.DB.prepare(
    `SELECT domain, settled_n, edge_last20_avg, qualified FROM skill_status WHERE player_id = ?`
  ).bind(device).all()).results || [];

  // banked edge: sum over graded forecasts (display currency of the game)
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(edge), 0) AS edge_sum, COALESCE(AVG(brier), 0) AS avg_brier
     FROM forecasts WHERE player_id = ? AND brier IS NOT NULL`
  ).bind(device).first();

  return json({ settled, pending, calibration, skill, totals });
}
