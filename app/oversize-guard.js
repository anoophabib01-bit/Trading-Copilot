'use strict';
// ── OVERSIZE GUARD — reduce an oversized position to the cap ───────────────
// Anoop, 2026-08-28, the day it cost him 72% of his account's drawdown:
//   "Auto-flatten on oversize ... it is the cure for me blowing accounts like
//    today. oversize killed me today and i need serious resolution."
//
// ── WHAT HAPPENED, IN HIS OWN NUMBERS ──────────────────────────────────────
//   day net                       -$1,436.20
//   2 trades OVER the 2-lot cap   -$1,147.70   (80% of the loss)
//   4 trades within cap             -$288.50
// The size-5 short alone was -$1,322 — 66% of the entire $2,000 drawdown a
// 50K Select evaluation gets, in one trade.
//
// ── WHY NOTHING ELSE WAS EVER GOING TO STOP IT ─────────────────────────────
// Confirmed from Tradeify's own documentation this session:
//   • Select Evaluation has NO daily loss limit. Nothing broker-side halts a
//     bad day until the $2,000 drawdown is gone.
//   • The broker's contract ceiling is 40 micros. His own cap is 2. The broker
//     was twenty times away from caring.
// So the only thing that can enforce his size rule is this app.
//
// ── THE DECISION HE MADE, AND WHY IT IS THE RIGHT SHAPE ────────────────────
// REDUCE TO THE CAP, not flatten. Entering 5 with a cap of 2 sells 3 and
// leaves 2. The thesis survives; only the excess risk is removed. On today's
// size-5 short that is -$528.80 instead of -$1,322.00. Flattening everything
// would also have killed the size-3 long that made +$174.30 — a guard that
// costs you your winners gets switched off, and a switched-off guard protects
// nothing.
//
// ── THE SAFETY MODEL ───────────────────────────────────────────────────────
// This is the first thing in this app that acts on the account without being
// asked, so the failure direction is inverted from every other guard: a wrong
// "size is fine" costs nothing, a wrong "too big" sells contracts that should
// have been held. Position size is also the LEAST reliable field available —
// the fold logged size:0 four times on 2026-08-28 while real positions of 1,
// 2, 3 and 5 lots were open.
//
// Hence, and every one of these is load-bearing:
//   1. TWO CONFIRMING READS. The same oversize must be seen on consecutive
//      polls before anything is sent. One misread positions table cannot act.
//      Same discipline that fixed the phantom-trade bug.
//   2. REDUCE ONLY, NEVER FLIP. The order is always smaller than the position
//      and always in the closing direction. It is arithmetically incapable of
//      opening a position or reversing one.
//   3. NEVER ACT ON UNREADABLE SIZE. size 0, null, NaN or a non-finite number
//      is "unknown", never "zero", and unknown does nothing.
//   4. DAILY INTERVENTION CAP. A runaway loop that sells three lots every five
//      seconds would be far worse than the problem. Bounded per day.
//   5. COOLDOWN PER POSITION. One reduction per detected oversize, not one per
//      poll while the order is still filling.
//
// PURE. Decides; never sends. server.js owns the order call.

const DEFAULTS = {
  enabled: false,          // opt-in, always
  confirmReads: 2,         // consecutive polls showing the same oversize
  maxPerDay: 6,            // interventions per trading day
  cooldownMs: 30000,       // after acting, ignore this position for a while
};

/**
 * Should we reduce, right now?
 *
 * @param {object} pos   { size, side, symbol }  — size is the OBSERVED open size
 * @param {object} state { confirmCount, lastActionAt, actionsToday, lastSeenSize }
 * @param {object} cfg   { sizeCap, ...DEFAULTS }
 * @param {number} nowMs
 * @returns {object} { act, reduceBy, side, reason, state }
 */
function evaluate(pos, state, cfg, nowMs) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const st = Object.assign({ confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null }, state || {});
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cap = Number(c.sizeCap);

  const no = (reason, patch) => ({ act: false, reduceBy: 0, side: null, reason, state: Object.assign({}, st, patch || {}) });

  if (!c.enabled) return no('guard disabled');
  if (!Number.isFinite(cap) || cap <= 0) return no('no usable size cap configured');

  // Flat, or no position object at all → nothing to do, and reset the counter
  // so an old confirmation cannot carry into a future position.
  if (!pos) return no('no position', { confirmCount: 0, lastSeenSize: null });

  // UNKNOWN IS NOT ZERO. An unreadable quantity must never be treated as a
  // reading — the fold produced size:0 four times on 2026-08-28 while real
  // positions were open, and acting on that would have been acting blind.
  const size = Number(pos.size);
  if (!Number.isFinite(size) || size === 0) {
    return no('position size not readable — refusing to act on an unknown', { confirmCount: 0 });
  }

  const abs = Math.abs(size);
  if (abs <= cap) return no(`size ${abs} is within the cap of ${cap}`, { confirmCount: 0, lastSeenSize: abs });

  // ── from here the position IS oversized ─────────────────────────────────
  if (st.actionsToday >= c.maxPerDay) {
    return no(`daily intervention cap reached (${c.maxPerDay}) — reporting only`, { lastSeenSize: abs });
  }
  if (st.lastActionAt && (now - st.lastActionAt) < c.cooldownMs) {
    return no('within cooldown from the last reduction', { lastSeenSize: abs });
  }

  // Confirmation. The size must be seen at the SAME value on consecutive
  // polls: a position genuinely scaling up is a moving number, and acting
  // mid-scale would sell contracts the next poll would have justified.
  const sameAsLast = st.lastSeenSize === abs;
  const confirmCount = sameAsLast ? st.confirmCount + 1 : 1;
  if (confirmCount < c.confirmReads) {
    return no(`oversize seen ${confirmCount}/${c.confirmReads} — waiting for confirmation`,
      { confirmCount, lastSeenSize: abs });
  }

  // Direction: to REDUCE a long you sell; to reduce a short you buy. Derived
  // from the position's own side, and refused if that is not knowable —
  // guessing the side here would open a position rather than close one.
  // An EXPLICIT side only. My first draft fell back to the sign of `size`
  // when side was missing, and this repo's own data shows why that is
  // dangerous: stored rows carry `size: 5` with `side: 'SHORT'` — the sizes
  // are UNSIGNED and the direction lives in a separate field. A short with a
  // missing side would read as long, and "reduce" would send a SELL that
  // DOUBLES the short instead of closing it. Caught by this module's own
  // tests before it ever ran.
  const side = String(pos.side || '').toUpperCase();
  const isLong = side === 'LONG' || side === 'BUY';
  const isShort = side === 'SHORT' || side === 'SELL';
  if (!isLong && !isShort) {
    return no('position side not readable — refusing to guess a direction', { confirmCount, lastSeenSize: abs });
  }

  const reduceBy = abs - cap;
  // Belt and braces on the arithmetic that makes this incapable of flipping:
  // the order must be strictly smaller than the position and strictly
  // positive. If either fails, something upstream is wrong and we stop.
  if (!(reduceBy > 0 && reduceBy < abs)) {
    return no(`refusing an unsafe reduction (${reduceBy} of ${abs})`, { confirmCount, lastSeenSize: abs });
  }

  return {
    act: true,
    reduceBy,
    side: isLong ? 'sell' : 'buy',      // the CLOSING direction
    reason: `${abs} contracts is over the ${cap} cap — reducing by ${reduceBy}`,
    state: Object.assign({}, st, {
      confirmCount: 0,
      lastSeenSize: abs,
      lastActionAt: now,
      actionsToday: st.actionsToday + 1,
    }),
  };
}

// Reset per trading day so the daily cap means "per day".
function rollDay(state, dayKey) {
  const st = Object.assign({}, state || {});
  if (st.dayKey !== dayKey) {
    return { dayKey, confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null };
  }
  return st;
}

module.exports = { evaluate, rollDay, DEFAULTS };
