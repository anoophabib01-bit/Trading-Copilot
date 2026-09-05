// ── The refusal primitive (T1.3, 2026-09-04) ─────────────────────────────────
//
// WHY
// Before this, three separate places called `trading_place_market_order` and
// each carried its own idea of what was allowed. The guards were real but they
// guarded whichever door they happened to sit next to. On 2026-09-03 the
// size-freeze HARD STOP fired correctly on a 15-lot and had no power to act.
//
// This module owns ONE decision — "may this order go out?" — so a new order
// path cannot be added without passing through it.
//
// THE DISTINCTION THAT MAKES IT SAFE
// Orders are not all the same kind of thing:
//
//   OPEN     takes on risk        → fully gated
//   REDUCE   lowers existing risk → NEVER blocked
//   FLATTEN  removes all risk     → NEVER blocked
//
// Blocking a reduce or a flatten because the day-stop tripped would leave a
// losing position open at exactly the moment the rules wanted it gone. The
// oversize guard and the per-trade stop both emit reduce/flatten orders, so
// getting this backwards would turn two safety features into hazards. That is
// why `kind` is required and why an unrecognised kind is treated as OPEN — the
// conservative default is to gate, not to wave through.
//
// WHAT THIS HONESTLY CANNOT DO
// It governs orders THIS APP places. It cannot prevent an order typed directly
// into TradingView, which is how every one of the five account-killing trades
// happened. `preventsManualOrders` is exported as `false` so no surface can
// imply otherwise — the app REACTS to those, it does not prevent them.

'use strict';

const RISK_REDUCING = new Set(['reduce', 'flatten', 'close']);

/**
 * @param {object} intent  {kind, side, qty, symbol}
 * @param {object} ctx     {liveOrdersEnabled, guard, brokerReady}
 *   guard: the result of trade-confirm-rules.checkTradeAllowed(), or null when
 *          the caller has no gate to apply (risk-reducing paths).
 * @returns {{allowed:boolean, reason:string, kind:string, riskReducing:boolean}}
 */
function decideOrder(intent, ctx) {
  const i = intent || {};
  const c = ctx || {};
  const kind = String(i.kind || 'open').toLowerCase();
  const riskReducing = RISK_REDUCING.has(kind);

  const qty = Number(i.qty);
  if (!Number.isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) {
    return { allowed: false, reason: `invalid size: ${i.qty}`, kind, riskReducing };
  }
  if (!i.symbol) {
    return { allowed: false, reason: 'no symbol on the order', kind, riskReducing };
  }
  if (!i.side) {
    return { allowed: false, reason: 'no side on the order', kind, riskReducing };
  }

  // The live-orders switch gates EVERY order, including risk-reducing ones —
  // not as a safety rule but as a fact: without it the broker tool is not
  // registered and the call would fail anyway. Saying so plainly beats a
  // confusing downstream error.
  if (!c.liveOrdersEnabled) {
    return {
      allowed: false,
      reason: 'live orders are not enabled in this session (launch with LIVE ORDERS to let the app act)',
      kind, riskReducing,
    };
  }
  if (c.brokerReady === false) {
    return { allowed: false, reason: 'broker connection is not ready', kind, riskReducing };
  }

  // Risk-reducing orders are never blocked by the trading rules. A day-stop
  // must not trap an open position.
  if (riskReducing) {
    return { allowed: true, reason: `${kind} — risk-reducing, not gated`, kind, riskReducing };
  }

  if (c.guard && c.guard.allowed === false) {
    return { allowed: false, reason: c.guard.reason || 'blocked by trading rules', kind, riskReducing };
  }

  return { allowed: true, reason: 'allowed', kind, riskReducing };
}

// Stated as data so a UI cannot quietly claim prevention this app does not have.
const preventsManualOrders = false;

module.exports = { decideOrder, RISK_REDUCING, preventsManualOrders };
