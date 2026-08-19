'use strict';
// ── Live mistake-pattern detection (2026-08-19) ─────────────────────────────
// Anoop's ask: track his live moves while trading and feed it back so a
// REPEATED mistake gets caught by the current workflow, not just visible
// after the fact in a post-session review. Scoped deliberately narrow per
// his own explicit decision (2026-08-19, after Bugs 6-8 were found live):
// ONE pattern first (F1, trade-count escalation), advisory only — no
// enforcement action, promoting to a hard stop is a separate future decision.
//
// Pure, side-effect-free, unit-tested — mirrors size-freeze-guard.js's shape
// so this can be extended with F2-F6/M1-M6 later without re-deriving the
// pattern.
//
// SOURCE TEXT (cited verbatim, app/renderer/index.html:636 — his own
// documented account-blowup analysis, do not paraphrase this away from what
// he actually wrote for himself):
//   "F1 — Trade count escalation — profitable days: 6-12 trades. Blow-up
//    days: 65 trades, 20% win rate. More trades = more damage. Stop at 2
//    good trades. Done."
//
// The signal this checks is NOT the same as rules.json's tradesPerDay hard
// cap (5) — that's a count ceiling regardless of outcome. F1's own text is
// about WINNING trades specifically: the failure mode his own data shows is
// continuing to trade AFTER already winning, not merely trading a lot. So
// this fires on win count, which can (and should) warn well before the
// tradesPerDay cap is ever reached.

const F1_WIN_THRESHOLD = 2; // "Stop at 2 good trades. Done." — his own number, not invented here

/**
 * @param {Array} trades  today's trades (tv-broker-feed.js fold() shape) —
 *   {pnl, pnlUnknown, size, ...}. Backfilled trades with pnlUnknown:true are
 *   deliberately excluded from the win count — we don't know if they won.
 * @returns {{matched: boolean, winCount: number, totalCount: number, message: string|null}}
 */
function checkTradeCountEscalation(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const knownTrades = list.filter(t => t && !t.pnlUnknown);
  const winCount = knownTrades.filter(t => typeof t.pnl === 'number' && t.pnl > 0).length;
  const matched = winCount >= F1_WIN_THRESHOLD;
  return {
    matched,
    winCount,
    totalCount: list.length,
    message: matched
      ? `PATTERN F1 (your own data): "profitable days run 6-12 trades, blow-up days run into the 60s at a 20% win rate — stop at 2 good trades, done." You're at ${winCount} winning trade${winCount === 1 ? '' : 's'} today. This is exactly the point your own history says to stop.`
      : null,
  };
}

module.exports = { checkTradeCountEscalation, F1_WIN_THRESHOLD };
