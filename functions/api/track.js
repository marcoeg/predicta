// POST /api/track — first-party analytics sink. Cookieless, no IP stored, no UA stored.
// Accepts sendBeacon payloads: { device_id?, session_id?, events: [{name, ts?, props?}] }
// Event names are allowlisted by pattern; payloads are size-capped. Nothing else is collected.

import { json } from "../_lib/kalshi.js";

const NAME_RE = /^[a-z0-9_]{2,40}$/;
const UUIDISH = /^[A-Za-z0-9\-]{8,64}$/;
const MAX_EVENTS = 25;
const MAX_PROPS = 2048;

export async function onRequestPost({ env, request }) {
  const b = await request.json().catch(() => null);
  if (!b || !Array.isArray(b.events) || b.events.length === 0) return json({ error: "no events" }, 400);
  if (b.events.length > MAX_EVENTS) return json({ error: "too many events" }, 413);

  const device = UUIDISH.test(String(b.device_id || "")) ? b.device_id : null;
  const session = UUIDISH.test(String(b.session_id || "")) ? b.session_id : null;
  const now = new Date().toISOString();

  const stmts = [];
  for (const ev of b.events) {
    const name = String(ev.name || "");
    if (!NAME_RE.test(name)) continue;
    let props = null;
    if (ev.props != null) {
      try {
        props = JSON.stringify(ev.props);
        if (props.length > MAX_PROPS) props = null;
      } catch (e) { props = null; }
    }
    // client ts accepted but bounded to ±1h of server time; else server time wins
    let ts = now;
    if (ev.ts) {
      const t = new Date(ev.ts);
      if (!isNaN(t) && Math.abs(t.getTime() - Date.now()) < 3600_000) ts = t.toISOString();
    }
    stmts.push(env.DB.prepare(
      "INSERT INTO events (ts, player_id, session_id, name, props) VALUES (?, ?, ?, ?, ?)"
    ).bind(ts, device, session, name, props));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return new Response(null, { status: 204 });
}

export async function onRequestGet() {
  return json({ error: "POST only" }, 405);
}
