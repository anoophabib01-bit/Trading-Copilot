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
const drawdownGuard = require('./drawdown-guard'); // T4.1 headroom gate (pure decision)

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
function checkTradeAllowed(rules, stage, todayTrades, requestedQty, account, risk) {
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

  // G9: stop-distance risk. This is the only path that places a real order, so it
  // must refuse a stop so far away that the loss at this size exceeds the
  // per-trade cap. `risk.riskCapUsd` is the tighter of {mode cap, perTradeMaxLoss}
  // (the caller computes it via autonomyModes.riskCapUsd) — never looser than the
  // account rule. A missing stopPrice/lastPrice/pointValue skips the check rather
  // than guessing (the caller must refuse a stopless ticket separately).
  if (risk) {
    const stop = risk.stopPrice != null ? Number(risk.stopPrice) : NaN;
    const last = risk.lastPrice != null ? Number(risk.lastPrice) : NaN;
    const pv = risk.pointValue != null ? Number(risk.pointValue) : NaN;
    const cap = risk.riskCapUsd != null ? Number(risk.riskCapUsd) : NaN;
    const side = risk.side || null;
    // A stopless ticket is refused — a naked market order on the only live-order
    // path is exactly what this check exists to prevent.
    if (!Number.isFinite(stop)) {
      return { allowed: false, reason: 'no stop supplied — a stopless ticket is refused on the live order path' };
    }
    if (!Number.isFinite(last) || !Number.isFinite(pv) || pv <= 0 || !Number.isFinite(cap)) {
      return { allowed: false, reason: 'cannot price stop risk (missing entry price / point value / cap) — refusing rather than guessing' };
    }
    if (side === 'buy' && stop >= last) {
      return { allowed: false, reason: `buy stop ${stop} is at or above entry ${last} — wrong side` };
    }
    if (side === 'sell' && stop <= last) {
      return { allowed: false, reason: `sell stop ${stop} is at or below entry ${last} — wrong side` };
    }
    const distance = Math.abs(last - stop);
    const riskUsd = distance * pv * qty;
    if (riskUsd > cap) {
      return { allowed: false, reason: `stop ${distance.toFixed(2)}pt away risks $${riskUsd.toFixed(0)} at ${qty} contract(s), over the $${cap} per-trade cap` };
    }
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
  // T4.2: the hard daily-loss tier ends the session in code, not just a banner.
  const hardTier = (r.dailyLossTiers && typeof r.dailyLossTiers.hard === 'number') ? Math.abs(r.dailyLossTiers.hard) : null;
  if (hardTier != null && dayPnl <= -hardTier) {
    return { allowed: false, reason: `day P&L ${dayPnl.toFixed(2)} past the hard daily-loss tier -${hardTier} — session ended` };
  }
  if (dayPnl <= -dayStopCap) {
    return { allowed: false, reason: `day P&L ${dayPnl.toFixed(2)} already at/past day-stop -${dayStopCap}` };
  }

  // T4.1: drawdown headroom gate — reduce size near the floor, stand down at it.
  if (account && account.balance != null && account.floor != null) {
    const hs = drawdownGuard.headroomState({ balance: account.balance, floor: account.floor, rules: r });
    if (hs.tradingAllowed === false) {
      return { allowed: false, reason: `drawdown headroom $${hs.headroom != null ? hs.headroom.toFixed(0) : '?'} is at stand-down — session ended` };
    }
    if (hs.effectiveCap != null && qty > hs.effectiveCap) {
      return { allowed: false, reason: `drawdown headroom reduces the size cap to ${hs.effectiveCap} — size ${qty} exceeds it` };
    }
  }

  if (sizeUpAfterLossViolation(trades, qty)) {
    const prev = trades[trades.length - 1];
    return { allowed: false, reason: `size-up after a loss: ${qty} after a ${prev.pnl.toFixed(2)} loss on size ${prev.size}` };
  }

  return { allowed: true, reason: null };
}

module.exports = { checkTradeAllowed };
