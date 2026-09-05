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
//      and always in the closing direction.
//      ⚠ AMENDED 2026-08-31 — as originally written this claim was FALSE, and
//      it cost a live position. "Smaller than the position" is arithmetic on
//      ONE reading. Six reductions of 1 against a read frozen at 5 walked a
//      real LONG 5 down to SHORT 1. Per-order arithmetic guarantees nothing
//      across a sequence of orders on a stale reading. The property now holds
//      because of (6): at most one unconfirmed reduction may be outstanding,
//      so the total ever sent for an episode cannot exceed (size - cap).
//   3. NEVER ACT ON UNREADABLE SIZE. size 0, null, NaN or a non-finite number
//      is "unknown", never "zero", and unknown does nothing.
//   4. DAILY INTERVENTION CAP. A runaway loop that sells three lots every five
//      seconds would be far worse than the problem. Bounded per day.
//   5. COOLDOWN PER POSITION. One reduction per detected oversize, not one per
//      poll while the order is still filling.
//   6. ONE OUTSTANDING REDUCTION. (2026-08-31) After sending, nothing further
//      is sent until the position is SEEN to have shrunk. A frozen read makes
//      the guard alarm forever instead of selling forever. This is the rule
//      that makes (2) actually true, and the one whose absence caused the
//      LONG 5 -> SHORT 1 incident. Do not weaken it to "retry after N seconds":
//      time passing is not evidence that an order filled.
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
  const st = Object.assign({
    confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null,
    sentQty: 0,            // contracts sent for the current episode, not yet confirmed by a size change
    sizeAtLastAction: null // the size observed when those contracts were sent
  }, state || {});
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cap = Number(c.sizeCap);

  const no = (reason, patch) => ({ act: false, reduceBy: 0, side: null, reason, state: Object.assign({}, st, patch || {}) });

  if (!c.enabled) return no('guard disabled');
  if (!Number.isFinite(cap) || cap <= 0) return no('no usable size cap configured');

  // Flat, or no position object at all → nothing to do, and reset the counter
  // so an old confirmation cannot carry into a future position.
  if (!pos) return no('no position', { confirmCount: 0, lastSeenSize: null, sentQty: 0, sizeAtLastAction: null });

  // UNKNOWN IS NOT ZERO. An unreadable quantity must never be treated as a
  // reading — the fold produced size:0 four times on 2026-08-28 while real
  // positions were open, and acting on that would have been acting blind.
  const size = Number(pos.size);
  if (!Number.isFinite(size) || size === 0) {
    return no('position size not readable — refusing to act on an unknown', { confirmCount: 0 });
  }

  const abs = Math.abs(size);
  if (abs <= cap) {
    // Position is back inside the cap — the episode is over. Clear the
    // outstanding-reduction bookkeeping so a future oversize starts clean.
    return no(`size ${abs} is within the cap of ${cap}`,
      { confirmCount: 0, lastSeenSize: abs, sentQty: 0, sizeAtLastAction: null });
  }

  // ── from here the position IS oversized ─────────────────────────────────

  // ── THE 2026-08-31 INCIDENT GUARD ────────────────────────────────────────
  // What happened: Anoop opened LONG 5. The guard fired six times in three
  // minutes, each time reading `size: 5`, each time selling 1, each order
  // submitted AND "verified". The reads were stale — the fills were real, so
  // the true position walked 5 -> 4 -> 3 -> 2 -> 1 -> FLAT -> SHORT 1. Only
  // maxPerDay=6 stopped it.
  //
  // Note what did NOT fail: two confirming reads, cooldown, reduce-not-flatten,
  // never-act-on-unreadable, the daily cap. Every one behaved as designed. The
  // hole was that "verified" meant "a matching ORDER appeared in the orders
  // table" — never "the POSITION actually changed". So the loop was:
  //     read 5 -> sell 1 -> (30s cooldown) -> read 5 again -> sell 1 -> ...
  //
  // And it falsifies safety property #2 in this file's header. "Reduce only,
  // never flip" is arithmetic on ONE reading; across repeated actions on a
  // STALE reading it is simply untrue. Six reductions of 1 reversed a 5-lot
  // long. The invariant has to hold over the whole episode, not per order.
  //
  // THE RULE: one outstanding reduction at a time. Having sent contracts for
  // this position, refuse to send more until the position is SEEN to have
  // shrunk. If the read never updates, the guard alarms forever instead of
  // selling forever — which is the correct failure direction, because an
  // un-actioned oversize costs what the market does, while a compounding one
  // costs the account.
  if (st.sentQty > 0) {
    const shrank = st.sizeAtLastAction != null && abs < st.sizeAtLastAction;
    if (!shrank) {
      return no(
        `already sent ${st.sentQty} to reduce a position that still reads ${abs}` +
        (st.sizeAtLastAction != null ? ` (was ${st.sizeAtLastAction} when we acted)` : '') +
        ' — refusing to send another. The position read is not updating; close the excess yourself.',
        { confirmCount: 0, lastSeenSize: abs, stale: true }
      );
    }
    // The position DID move, so the previous order landed and the reading is
    // live again. Clear the outstanding flag and re-confirm from scratch
    // before any further action.
    st.sentQty = 0;
    st.sizeAtLastAction = null;
  }

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
      // Outstanding reduction: what we just sent, and the size we sent it
      // against. Nothing further may be sent until the position is seen below
      // sizeAtLastAction. This is what bounds an episode to ONE order per
      // observed change, and what makes the never-flip promise true across a
      // sequence rather than only within a single order.
      sentQty: reduceBy,
      sizeAtLastAction: abs,
    }),
  };
}

// Reset per trading day so the daily cap means "per day".
function rollDay(state, dayKey) {
  const st = Object.assign({}, state || {});
  if (st.dayKey !== dayKey) {
    return { dayKey, confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null, sentQty: 0, sizeAtLastAction: null };
  }
  return st;
}

module.exports = { evaluate, rollDay, DEFAULTS };

// ── READING THE POSITIONS TABLE ────────────────────────────────────────────
// Added 2026-09-02, after the guard sat silent through a real 5-lot.
//
// WHAT HAPPENED: Anoop opened 5 contracts against a cap of 2. The guard logged
// NOTHING — not a reduction, not an alarm, not a stuck read. Every store in the
// app recorded the position as size 1: tv_broker_feed_state maxSize 1, both
// session-log rows "size 1", the position watch "OPENED LONG 1 MNQU6".
//
// WHY: Tradovate's positions grid carries a Position ID column — it renders one
// row PER POSITION, not one net row per symbol. Three separate readers all took
// the MAX row instead of the SUM:
//     server.js largestPosition()     if (!prev || abs > prev.size)
//     server.js openSize              positions.reduce((m,p) => Math.max(...))
//     position-events.js              if (!prev || r.qty > prev.qty)
// Five 1-lot scale-ins therefore read as 1, which is inside the cap, so the
// guard correctly concluded there was nothing to do. Enter 5 in ONE order and
// you get one row of 5 — which is exactly why 2026-08-31 (size 5) and
// 2026-09-01 (size 8) fired correctly. The guard only ever worked for the
// single-order case, and nothing said so.
//
// Note the direction of the old bug: max UNDER-states a scaled-in position, so
// the guard failed OPEN. position-events.js even carried the comment "larger
// quantity is the safer one to report (never under-state size)" — true across
// symbols, false across rows of the same position.
//
// ── WHY SUMMING IS SAFE HERE ───────────────────────────────────────────────
// Summing is the change with teeth: it is the only one that can cause an order
// that would not have been sent before. Two things bound it.
//   1. PER (SYMBOL, SIDE), never across sides. Two 2-lot positions in different
//      instruments are two trades at the cap, not one 4-lot breach — that rule
//      is unchanged. And a symbol showing BOTH a long and a short row is a
//      hedge whose net direction we cannot name, so it is returned with a BLANK
//      side, which evaluate() already refuses ("side not readable"). Guessing
//      there would send an order in the wrong direction.
//   2. A row whose qty will not parse is SKIPPED, not assumed. That can only
//      under-count, which fails toward doing nothing — the safe direction.
// Everything downstream is untouched: two confirming reads, one outstanding
// reduction, the cooldown and the daily cap all still apply to the summed size.
//
// Rows are keyed by the RAW TABLE HEADER TEXT ('Symbol', 'Side', 'Qty') because
// readTable() builds each object with `key = headerCells[i]`. Matched
// case-insensitively so a header capitalisation change cannot disarm it.
function pickField(row, names) {
  if (!row) return undefined;
  const keys = Object.keys(row);
  for (const want of names) {
    const hit = keys.find((k) => k.trim().toLowerCase() === want);
    if (hit !== undefined && row[hit] !== '' && row[hit] != null) return row[hit];
  }
  return undefined;
}

/**
 * Fold a raw positions table into the largest NET position on the account.
 *
 * @param {Array} rows  raw rows from trading_get_positions
 * @returns {object|null} { size, side, symbol, rowCount, unparseableRows, mixedSides }
 *   size is the SUM of same-side rows for that symbol. side is '' when the
 *   symbol shows both directions — evaluate() refuses to act on that.
 */
function netPosition(rows) {
  const bySymbol = new Map();
  let unparseableRows = 0;

  for (const p of Array.isArray(rows) ? rows : []) {
    if (!p) continue;
    const sym = pickField(p, ['symbol', 'instrument', 'contract']) || 'unknown';
    // Quantities arrive as display strings ("5", "-2", "1,000") — strip
    // anything that is not part of a number rather than trusting Number().
    const rawQty = pickField(p, ['qty', 'quantity', 'size', 'net pos', 'position']);
    const qty = Number(String(rawQty == null ? '' : rawQty).replace(/−/g, '-').replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(qty) || qty === 0) {
      // A row that EXISTS but will not parse is a hole in the reading. It can
      // only make the total too small, so it never causes an order — but it is
      // recorded so the evidence log shows the total was partial.
      if (rawQty != null && String(rawQty).trim() !== '') unparseableRows++;
      continue;
    }
    const side = String(pickField(p, ['side', 'direction', 'b/s']) || '').toUpperCase();
    // Sides are normalised so BUY/LONG and SELL/SHORT are not counted as two
    // different directions on the same symbol (which would read as a hedge and
    // disarm the guard on an ordinary position).
    const dir = (side === 'LONG' || side === 'BUY') ? 'LONG'
      : (side === 'SHORT' || side === 'SELL') ? 'SHORT'
      : (side || '?');
    const entry = bySymbol.get(sym) || { symbol: sym, sides: new Map(), rowCount: 0 };
    entry.sides.set(dir, (entry.sides.get(dir) || 0) + Math.abs(qty));
    entry.rowCount++;
    bySymbol.set(sym, entry);
  }

  let biggest = null;
  for (const e of bySymbol.values()) {
    // Total exposure on this symbol, whichever way it is pointing.
    let total = 0;
    for (const v of e.sides.values()) total += v;
    const dirs = Array.from(e.sides.keys());
    const mixedSides = dirs.length > 1;
    // A single readable direction is the only case we can name a side for.
    const side = mixedSides ? '' : (dirs[0] === 'LONG' || dirs[0] === 'SHORT' ? dirs[0] : '');
    const cand = { size: total, side, symbol: e.symbol, rowCount: e.rowCount, mixedSides, unparseableRows };
    if (!biggest || cand.size > biggest.size) biggest = cand;
  }
  return biggest;
}

module.exports.netPosition = netPosition;
