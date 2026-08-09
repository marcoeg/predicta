# Predicta — TODO

## Leaderboards (designed 2026-08-09, deferred until more users & usage)

Everything below is fully retroactive: forecasts store player, probability, outcome, and the
market price at the moment of each lock (the one perishable datum), so scores and rankings
can be computed over complete history whenever this ships.

### The design problem
Proper scoring (Brier) makes honesty optimal for **expected score** — but not for **expected
rank**. A naive ordinal leaderboard incentivizes variance-seeking: a player in 8th place
maximizes their chance of 1st with extreme forecasts (1%/99% everywhere), wrecking their
expected score and the calibration data asset. Known failure mode of forecasting tournaments.
The design below exists to keep honesty optimal even for the competitive.

### Agreed shape
- **Two boards:**
  - **Sharpest** — ranked by shrunken mean edge: `rating = edge_sum / (n + 10)`.
    The `+10` prior pulls small samples toward zero so three lucky calls cannot top the table.
    Minimum **5 settled forecasts** to appear.
  - **Most Banked** — ranked by cumulative edge (`SUM(edge) × 100`, "edge points").
    Volume-friendly: honest daily play always climbs. This is the number displayed big
    in the player's own summary as their career score.
- **Percentile framing** for the player's own position ("top 14% of calibrated forecasters")
  in preference to obsessive ordinals; the boards themselves show top N.
- **Pseudonyms, zero-PII:** deterministic generated handles from a hash of device_id
  (adjective + bird/thinker + number, e.g. "Cautious Bayesian #47"). Real display names
  arrive only with the v0.2 identity/claim flow.
- **Domain boards later:** same two boards per domain (econ / climate / crypto / energy)
  once per-domain sample sizes justify them; reuses `skill_status`.

### Build checklist (~half a day)
- [ ] `GET /api/leaderboard` — Pages Function: top 20 per board + caller's rank & percentile
      (device_id param); reads `forecasts` aggregates; cache 5 min.
- [ ] Pseudonym generator (pure function of device_id hash; word lists in `_lib`).
- [ ] Client: leaderboard card on summary + results views; percentile line in share card.
- [ ] Show board only when population ≥ ~20 qualified players (avoid a sad 3-row board).
- [ ] Decide: opt-out flag? (Likely unnecessary while pseudonymous.)

### Related (unblocks "one unbroken record")
- [ ] v0.2 identity: email magic-link claim; merge multiple device_ids into one player;
      chosen display name replaces pseudonym on boards. (The Help tab already warns users
      that each browser/device is a separate ID.)

## Backlog (smaller)
- [ ] Jobless-claims series for the macro slot Thursdays (KXICLAIM doesn't exist — find the
      right Kalshi series ticker; CPI stays the fallback).
- [ ] Editorial voice pass: rewrite Kalshi's raw market titles into house style
      (LLM allowed here — text only; selection/prices stay deterministic).
- [ ] Automate Priced In: daily headline ↔ market pairing (needs judgment; LLM or manual).
- [ ] Alternative scoring exploration: log score re-grade over stored history (research only).
- [ ] Streak display (data already accumulating; editions-played based, per design doc).
- [ ] www.predicta.game certificate check (was still verifying at launch; confirm active).

— Copyright © 2026 Graziano Labs Corp.
