'use strict';
// ── Live position-change detector (2026-08-20) ──────────────────────────────
// Anoop's request: "as soon as I close or open any trade it should be updated,
// and be part of the workflow." Before this, the ONLY live trade signal in the
// app was tv-broker-feed.js's fold, which:
//   - runs on the 10s pollTVBrokerAccount cadence, so an open or close could
//     sit unreported for up to 10 seconds, and
//   - only ever emits on a CLOSE (tradeCount incrementing). A position
//     OPENING produced no event at all — nothing in the app knew a trade had
//     started until it finished.
//
// This module is the pure half of the fast path: given the previous and
// current `trading_get_positions` reads, say what actually changed. server.js
// runs it on a light positions-only poll (TV_POSITION_WATCH_MS) and turns each
// event into an immediate broadcast plus a full account re-read, so the HUD,
// guardrail and Jessi see an open/close within one short tick instead of one
// long one.
//
// Pure and side-effect-free (same contract as tv-broker-feed.js's fold and
// amd-phase.js) so the transition logic is unit-testable with no live
// TradingView connection.
//
// SCOPE — this reports POSITION TRANSITIONS, nothing else. It deliberately
// does NOT compute P&L or count trades: the balance-delta fold in
// tv-broker-feed.js remains the single source of truth for both, and having a
// second thing that also counts trades is exactly how the 2026-08-20
// over-counting bug (orders vs round trips) happened. This tells you
// something changed and how; the fold tells you what it was worth.

// TradingView renders a position's Qty as a plain string ("2", "12"); Side as
// "Buy"/"Sell". Both are read defensively here — a malformed row must never
// throw inside a 5s timer running during a live session.
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const symbol = String(row.Symbol || '').trim();
  if (!symbol) return null;
  const qtyRaw = Number(String(row.Qty == null ? '' : row.Qty).replace(/[^0-9.\-]/g, ''));
  const qty = Number.isFinite(qtyRaw) ? Math.abs(qtyRaw) : 0;
  const side = String(row.Side || '').trim().toLowerCase();
  return { symbol, side, qty };
}

function indexBySymbol(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    const r = normalizeRow(raw);
    if (!r || r.qty === 0) continue; // a zero-qty row is not an open position
    // SAME SYMBOL TWICE IS THE NORMAL CASE, not an anomaly (fixed 2026-09-02).
    // Tradovate's grid carries a Position ID column and renders one row PER
    // POSITION, so scaling into 5 lots one at a time produces five rows of 1.
    // This used to keep the LARGER row, with the comment "never under-state
    // size" — true when comparing two readings of one position, false when the
    // rows ARE the position: five 1-lot rows reported `1`, and that is the
    // number that reached the session log, the fold and the oversize guard on
    // the day Anoop actually held 5.
    //
    // Summed per side. A symbol showing both directions is a hedge whose net
    // direction cannot be named from the rows alone, so the side is left blank
    // rather than guessed — callers describe it, they do not trade on it.
    const prev = out.get(r.symbol);
    if (!prev) { out.set(r.symbol, r); continue; }
    out.set(r.symbol, {
      symbol: r.symbol,
      side: prev.side === r.side ? prev.side : '',
      qty: prev.qty + r.qty,
    });
  }
  return out;
}

/**
 * Diff two positions reads.
 *
 * @param {Array|null} prevRows  previous trading_get_positions rows, or null
 *                               if this is the first read of the session
 * @param {Array} nextRows       current rows
 * @returns {Array} events, each { kind, symbol, side, qty, prevQty }
 *   kind is one of:
 *     'opened'   — no position in this symbol before, one now
 *     'closed'   — a position existed, now flat in that symbol
 *     'scaled'   — same side, quantity changed (scale-in or partial exit)
 *     'flipped'  — side reversed without passing through flat
 *
 * A null `prevRows` returns NO events: the first read of a session is a
 * baseline, not a change. Reporting an already-open position as freshly
 * "opened" on every server restart would fire a false alert (and, once this is
 * wired to the session log, write a phantom row) each time the app reconnects
 * mid-trade — a realistic case, since restarting mid-position is exactly what
 * the fold's own persistence exists to survive.
 */
function diffPositions(prevRows, nextRows) {
  if (prevRows === null || prevRows === undefined) return [];
  const prev = indexBySymbol(prevRows);
  const next = indexBySymbol(nextRows);
  const events = [];

  for (const [symbol, cur] of next) {
    const before = prev.get(symbol);
    if (!before) {
      events.push({ kind: 'opened', symbol, side: cur.side, qty: cur.qty, prevQty: 0 });
    } else if (before.side !== cur.side) {
      events.push({ kind: 'flipped', symbol, side: cur.side, qty: cur.qty, prevQty: before.qty });
    } else if (before.qty !== cur.qty) {
      events.push({ kind: 'scaled', symbol, side: cur.side, qty: cur.qty, prevQty: before.qty });
    }
  }

  for (const [symbol, before] of prev) {
    if (!next.has(symbol)) {
      events.push({ kind: 'closed', symbol, side: before.side, qty: 0, prevQty: before.qty });
    }
  }

  // Stable ordering so a caller rendering several events at once (a flip in
  // one symbol while another closes) gets the same sequence every time.
  const order = { closed: 0, flipped: 1, opened: 2, scaled: 3 };
  events.sort((a, b) => (order[a.kind] - order[b.kind]) || a.symbol.localeCompare(b.symbol));
  return events;
}

// Human-readable one-liner for the chat/HUD. Kept here beside the shapes it
// describes so a new event kind can't be added without a matching phrasing.
function describeEvent(e) {
  if (!e) return '';
  const side = e.side ? e.side.toUpperCase() : '?';
  switch (e.kind) {
    case 'opened':  return `OPENED ${side} ${e.qty} ${e.symbol}`;
    case 'closed':  return `CLOSED ${e.symbol} (was ${e.prevQty} lot${e.prevQty === 1 ? '' : 's'})`;
    case 'scaled':  return e.qty > e.prevQty
      ? `SCALED IN ${e.symbol} ${e.prevQty} → ${e.qty}`
      : `SCALED OUT ${e.symbol} ${e.prevQty} → ${e.qty}`;
    case 'flipped': return `FLIPPED ${e.symbol} to ${side} ${e.qty}`;
    default:        return '';
  }
}

module.exports = { diffPositions, describeEvent };
