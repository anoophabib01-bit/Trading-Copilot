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

  // 2026-08-21 (Anoop's D1/D2): the trade COUNT only hard-blocks when every
  // trade behind it was scored on verified evidence. A trade tagged
  // evidence:'degraded' was scored by the fill-edge fallback — the same rule
  // that produced the "9/3 TRADES — DONE" lockout against ~4 real round trips.
  // A count built partly on that must not silently end a live session, so it
  // degrades to advisory: allowed, but carrying a warning the UI surfaces.
  //
  // Note what is NOT downgraded. dayStop and the size rules below still hard-
  // block, because they read BALANCE and SIZE — both directly observed, and
  // neither depends on how many trades we think happened. Only the count is
  // uncertain, so only the count loses its teeth.
  const degradedCount = trades.filter(t => t && t.evidence === 'degraded').length;
  const tradesPerDay = typeof r.tradesPerDay === 'number' ? r.tradesPerDay : Infinity;
  if (trades.length >= tradesPerDay) {
    if (degradedCount > 0) {
      return {
        allowed: true, reason: null, advisory: true,
        warning: `trade count says ${trades.length}/${tradesPerDay}, but ${degradedCount} of those was scored on a degraded feed and may not be real. Not blocking on a number I cannot stand behind — check the broker's own order history before taking this.`,
      };
    }
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
