// GET /api/edition — today's published edition (ET), with best-effort live mids.
// The market price is NEVER required to render: client hides it until lock anyway.

import { marketsByTickers, midCents, etDate, json } from "../_lib/kalshi.js";

export async function onRequestGet({ env }) {
  const ed = await env.DB.prepare(
    "SELECT id, date FROM editions WHERE status = 'published' ORDER BY date DESC LIMIT 1"
  ).first();
  if (!ed) return json({ edition: null, questions: [] });

  const qs = (await env.DB.prepare(
    `SELECT id, slot, category, domain, text, context, ticker, market_url, close_time, lock_price_cents
     FROM questions WHERE edition_id = ? AND status = 'open' AND close_time > datetime('now') ORDER BY slot`
  ).bind(ed.id).all()).results || [];

  let mids = {};
  try {
    const ms = await marketsByTickers(env, qs.map(q => q.ticker));
    for (const m of ms) { const c = midCents(m); if (c != null) mids[m.ticker] = c; }
  } catch (e) { /* fall back to lock_price_cents */ }

  return json({
    edition: { number: ed.id, date: ed.date },
    questions: qs.map(q => ({
      id: q.id, slot: q.slot, category: q.category, domain: q.domain,
      text: q.text, context: q.context, market_url: q.market_url,
      close_time: q.close_time,
      market_cents: mids[q.ticker] ?? q.lock_price_cents ?? null
    }))
  });
}
