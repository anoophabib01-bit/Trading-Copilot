'use strict';
// ── Phase 2a: trade-confirm rule-check, SHADOW MODE ONLY (2026-08-17) ───────
// Part of the semi-autonomous trade confirm/execute flow spec
// (PHASE2_SEMI_AUTONOMOUS_SPEC.md). Decides whether a hypothetical trade of a
// given size would be ALLOWED right now, against the same rules the manual
// and live-feed guardrails already enforce. Per the CEO/Eng review split
// (2026-08-17): this module is wired into server.js for LOGGING ONLY —
// nothing calls placeMarketOrder() with this result yet. The point is to
// validate its behavior against real live-feed data before Phase 2b ever
// lets it gate a real order.
//
// Reuses size-freeze-guard.js's pure sizeUpAfterLossViolation() rather than
// re-implementing it, so this can never drift from what the manual/live-feed
// guardrail already enforces.

const { sizeUpAfterLossViolation } = require('./renderer/size-freeze-guard.js');

/**
 * @param {object} rules   result of server.js's getActiveRules() — reads
 *                         sizeCap, sizeFloor, tradesPerDay, and either
 *                         dailyLossCap or dayStop[stage]
 * @param {string} stage   'eval' | 'funded' — used only to resolve dayStop
 *                         when rules.dailyLossCap isn't set
 * @param {Array<{size:number,pnl:number}>} todayTrades  today's trades so
 *                         far, oldest first (tv-broker-feed.js's `trades`
 *                         shape — {size, pnl, at})
 * @param {number} requestedQty  size of the hypothetical trade being evaluated
 * @returns {{allowed:boolean, reason:string|null}}
 */
function checkTradeAllowed(rules, stage, todayTrades, requestedQty) {
  const r = rules || {};
  const trades = Array.isArray(todayTrades) ? todayTrades : [];
  const qty = Number(requestedQty);

  if (!Number.isFinite(qty) || qty <= 0) {
    return { allowed: false, reason: `invalid size: ${requestedQty}` };
  }

  const sizeCap = typeof r.sizeCap === 'number' ? r.sizeCap : Infinity;
  if (qty > sizeCap) {
    return { allowed: false, reason: `size ${qty} exceeds sizeCap ${sizeCap}` };
  }

  const sizeFloor = typeof r.sizeFloor === 'number' ? r.sizeFloor : 0;
  if (qty < sizeFloor) {
    return { allowed: false, reason: `size ${qty} is under sizeFloor ${sizeFloor}` };
  }

  const tradesPerDay = typeof r.tradesPerDay === 'number' ? r.tradesPerDay : Infinity;
  if (trades.length >= tradesPerDay) {
    return { allowed: false, reason: `already ${trades.length} trades today, cap is ${tradesPerDay}` };
  }

  const dayStopCap = typeof r.dailyLossCap === 'number'
    ? r.dailyLossCap
    : (r.dayStop && typeof r.dayStop[stage] === 'number' ? r.dayStop[stage] : Infinity);
  const dayPnl = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  if (dayPnl <= -dayStopCap) {
    return { allowed: false, reason: `day P&L ${dayPnl.toFixed(2)} already at/past day-stop -${dayStopCap}` };
  }

  if (sizeUpAfterLossViolation(trades, qty)) {
    const prev = trades[trades.length - 1];
    return { allowed: false, reason: `size-up after a loss: ${qty} after a ${prev.pnl.toFixed(2)} loss on size ${prev.size}` };
  }

  return { allowed: true, reason: null };
}

module.exports = { checkTradeAllowed };
