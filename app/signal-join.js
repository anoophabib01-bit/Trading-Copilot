'use strict';
// ── Signal join (LIVE_FEED_LOOP_PLAN.md task 5.1) ──────────────────────────
// On a close, match back to the nearest PRECEDING signal on the same
// instrument and direction within a configurable window (rules.json
// signalJoinWindowMinutes, default 15). This is what makes "signal-backed vs
// freestyle" measurable — the single question the whole system exists to
// answer. Pure; the signal rows come from the day's signal ledger (the
// server reads DATA_DIR/signals/<dayKey>.jsonl).
//
// A trade's time is its ENTRY (entryAt) when known, else the fold's close
// stamp (at) — minutesFromSignal is then measured, not reconstructed, because
// the app was running when both happened.
//
// Only ARMED-setup signal events can back a trade ('engulf-fire',
// 'fvg-fire', 'playbook-b-confirm'): rejections, raids-alone and phase
// changes never armed a setup, so they can never be what the entry was based
// on. Direction mapping: buy → BULLISH, sell → BEARISH (the ledger stores
// BULLISH/BEARISH; the joined record's side is buy/sell).

const ARMING_EVENTS = new Set(['engulf-fire', 'fvg-fire', 'playbook-b-confirm']);

function directionOfTrade(trade) {
  const side = String((trade && trade.side) || '').toLowerCase();
  if (side === 'buy') return 'BULLISH';
  if (side === 'sell') return 'BEARISH';
  return null; // unknown side → cannot direction-match; only time/symbol matching could apply, and that is not trustworthy
}

function joinTradeToSignal(trade, signals, opts) {
  const o = opts || {};
  const windowMs = ((typeof o.windowMinutes === 'number' && o.windowMinutes > 0) ? o.windowMinutes : 15) * 60000;
  if (!trade) return { signalBacked: false, playbook: null, minutesFromSignal: null, signalTs: null };
  const tAt = typeof trade.entryAt === 'number' ? trade.entryAt : (typeof trade.at === 'number' ? trade.at : null);
  if (tAt == null) return { signalBacked: false, playbook: null, minutesFromSignal: null, signalTs: null };
  const dir = directionOfTrade(trade);
  const list = Array.isArray(signals) ? signals : [];
  let best = null;
  let bestDelta = Infinity;
  for (const s of list) {
    if (!s || !ARMING_EVENTS.has(s.event)) continue;
    if (typeof s.ts !== 'number') continue;
    const delta = tAt - s.ts;
    if (delta < 0 || delta > windowMs) continue; // preceding only, inside the window
    if (dir && s.direction && s.direction !== dir) continue;
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  if (!best) return { signalBacked: false, playbook: null, minutesFromSignal: null, signalTs: null };
  return {
    signalBacked: true,
    playbook: best.playbook,
    minutesFromSignal: Math.round(bestDelta / 60000),
    signalTs: best.ts,
  };
}

module.exports = { joinTradeToSignal, directionOfTrade, ARMING_EVENTS };
