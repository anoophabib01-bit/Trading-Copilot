'use strict';
// ── TradingView-broker live-feed aggregator (2026-08-17) ────────────────────
// Turns raw pollTVBrokerAccount() snapshots into the guardrail's live state:
// per-trade size/pnl, running day P&L, trade count, max size, last-loss time.
//
// REALIZED P&L SOURCE: "balance delta at each flat moment" — trading.js's
// getAccountSummary() confirmed live that a Filled order's own row carries
// NO realized-P&L column (only Avg Fill Price), so a closed trade's $ P&L is
// computed here as (account balance right after the position returns to
// flat) minus (account balance the last time it was flat, i.e. right before
// this trade opened). This is the only realized-P&L source actually
// confirmed against the DOM (see trading.js header comment) — Positions'
// "Profit" column is floating/open P&L, not a per-trade realized figure.
//
// STILL UNVERIFIED: this fold has not yet been checked against a REAL closed
// trade with non-zero P&L — the account was flat/fresh when the DOM
// structure was confirmed. Re-verify balance-delta math against the next
// real fill before trusting these numbers beyond the guardrail's own use.
//
// Pure and side-effect-free (mirrors app/tradovate.js's fold()) so the
// flat-transition/day-reset logic is unit-testable without a live
// TradingView connection.

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+5:30

function istDayStartMs(nowMs) {
  const istMs = nowMs + IST_OFFSET_MS;
  const istMidnightShiftedMs = Math.floor(istMs / 86400000) * 86400000;
  return istMidnightShiftedMs - IST_OFFSET_MS;
}

function freshState() {
  return {
    dayKeyMs: null,
    balanceAtLastFlat: null, // account balance the last time we observed flat
    wasFlat: null,           // null = not yet known (no poll processed this day)
    sizeSeenThisTrade: 0,
    dayPnl: 0,
    tradeCount: 0,
    maxSize: 0,
    lastLossTs: 0,
    trades: [], // {size, pnl, at} for today, oldest first
  };
}

// TradingView renders "$50,123.45" (and negative balances with the
// U+2212 minus sign, see trading.js's normalizeMinus) — strip everything
// but digits/minus/decimal before parsing.
function parseBalance(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/−/g, '-').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} prevState  previous fold() result, or freshState()
 * @param {object} snap       { balance: number|null, isFlat: boolean, openSize: number, nowMs: number }
 * @returns {object} next state (new object — prevState is never mutated)
 */
function fold(prevState, snap) {
  const nowMs = snap.nowMs;
  const dayKeyMs = istDayStartMs(nowMs);
  const carrying = prevState && prevState.dayKeyMs === dayKeyMs ? prevState : freshState();
  const st = { ...carrying, dayKeyMs, trades: carrying.trades.slice() };

  const balance = typeof snap.balance === 'number' && Number.isFinite(snap.balance) ? snap.balance : null;
  const openSize = Number(snap.openSize) || 0;

  if (!snap.isFlat) st.sizeSeenThisTrade = Math.max(st.sizeSeenThisTrade, openSize);

  if (st.balanceAtLastFlat === null) {
    // First readable poll (this day) — establish the baseline. Can't score
    // whatever trade may already be mid-flight, only trades from here on.
    // wasFlat still tracks even if balance itself was unreadable this poll,
    // so an unreadable-balance poll never masks a real flat transition.
    if (balance !== null) st.balanceAtLastFlat = balance;
    st.wasFlat = snap.isFlat;
    return st;
  }

  if (st.wasFlat === false && snap.isFlat === true && balance !== null) {
    const pnl = balance - st.balanceAtLastFlat;
    const size = st.sizeSeenThisTrade;
    st.trades.push({ size, pnl, at: nowMs });
    st.dayPnl += pnl;
    st.tradeCount += 1;
    st.maxSize = Math.max(st.maxSize, size);
    if (pnl < 0) st.lastLossTs = nowMs;
    st.balanceAtLastFlat = balance;
    st.sizeSeenThisTrade = 0;
  } else if (st.wasFlat === true && snap.isFlat === true && balance !== null && balance !== st.balanceAtLastFlat && snap.hasNewFill) {
    // 2026-08-18: POLL-ALIASING BACKSTOP. The branch above only fires if a
    // poll actually LANDED while the position was open. pollTVBrokerAccount
    // samples every 10s, so a scalp opened and closed inside one interval is
    // never observed as not-flat — the transition never happens and the trade
    // vanishes, which is one of the ways a real trading day recorded zero
    // trades. A balance that moved while we believed we were flat the whole
    // time can only mean a round-trip completed between samples, so score it
    // rather than lose it. `size` is genuinely unknown here (never observed
    // open), so it is recorded as 0 and the trade is marked inferred:true —
    // callers that enforce size rules must not treat 0 as "small", it means
    // "not observed". P&L is still exact: it is the same balance delta.
    //
    // 2026-08-19 BUG FIX (found live, Anoop's own rapid-fire test session —
    // 20 fabricated "trades" in under 4 minutes, all fictitious): this
    // branch used to fire on ANY balance change while flat, full stop. Direct
    // live measurement (polled the account 4x, 3s apart, zero trading
    // activity) proved the assumption underneath the whole balance-delta
    // method wrong for this broker/account: `Balance` is NOT stable between
    // real trades — it visibly drifted on its own (49,876.75 -> 49,874.75 ->
    // 49,872.25 -> 49,871.75) while `Equity` stayed perfectly constant the
    // entire time, with zero position open. Whether that's a UI settle-
    // animation, a demo-account simulation quirk, or delayed bracket-order
    // cleanup, it made this backstop fire on every single poll indefinitely,
    // fabricating a "trade" out of pure balance noise. `hasNewFill` — true
    // only when the SAME poll's orders-table read found a genuinely new
    // Filled order (see server.js's newFills, already computed independent
    // of this fold) — ties this backstop to real evidence a round trip
    // actually happened, not just to a number that moved. A real poll-
    // aliased scalp still has a real new fill and is still caught; balance
    // drift with no matching fill is not.
    const pnl = balance - st.balanceAtLastFlat;
    st.trades.push({ size: 0, pnl, at: nowMs, inferred: true });
    st.dayPnl += pnl;
    st.tradeCount += 1;
    if (pnl < 0) st.lastLossTs = nowMs;
    st.balanceAtLastFlat = balance;
    st.sizeSeenThisTrade = 0;
  } else if (st.wasFlat === true && snap.isFlat === true && balance !== null && balance !== st.balanceAtLastFlat) {
    // Balance moved while flat but no new fill was seen this poll — per the
    // fix above, do NOT score a trade. But also do NOT silently keep the
    // stale baseline forever — re-anchor to the current balance so a later
    // GENUINE flat-to-flat trade (with a real new fill) computes its delta
    // from the settled/current number, not from a balance that was already
    // known-wrong minutes ago.
    st.balanceAtLastFlat = balance;
  }
  st.wasFlat = snap.isFlat;
  return st;
}

// 2026-08-19 BUG FIX (found live, immediately after the backfill above
// shipped — a second real bug in the same session): TradingView's orders
// table only renders a "Status" column value when the "All" sub-tab is the
// currently-active one in the Trading Panel UI. When a filtered sub-tab is
// active instead (e.g. "Filled", "Working", "Cancelled" — confirmed live:
// Anoop's UI was on the "Filled" tab), rows in that view carry NO Status
// value at all — `o.Status` is simply absent. Every place in this codebase
// that matched `Status === 'filled'` literally (this file's backfill, and
// server.js's live poll) therefore silently found ZERO fills whenever that
// tab happened to be active, exactly the "0 trades" symptom being chased
// today. A row is filled if it EXPLICITLY says so, OR if Status is blank but
// it carries the two fields that only a genuinely filled order has: a
// positive Filled Qty and a parseable Avg Fill Price (Working/Cancelled/
// Rejected rows never populate Avg Fill Price). Single shared helper so
// every caller — the live poll AND the backfill — agrees on what "filled"
// means, instead of three independent copies of the same fragile check.
function isFilledOrderRow(o) {
  if (!o || typeof o !== 'object') return false;
  const status = String(o.Status || '').toLowerCase();
  if (status === 'filled') return true;
  if (status) return false; // an explicit non-filled status (working/cancelled/rejected) is authoritative
  const filledQty = Number(o['Filled Qty']);
  return Number.isFinite(filledQty) && filledQty > 0 && parseBalance(o['Avg Fill Price']) != null;
}

// TradingView's order rows render "2026-08-19 13:08:15" — no timezone
// marker, but every timestamp in this app is IST wall-clock (see
// istDayStartMs above). Parsed explicitly rather than trusting Date's
// locale-dependent string parsing, so this behaves identically in tests
// regardless of the machine's system timezone.
function parseISTTimestamp(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MS;
}

// 2026-08-19 BUG FIX (found live, Anoop pushed back on "permanently
// invisible" — correctly, since the data needed to reconstruct it was right
// there in the orders table). fold()'s balance-delta method can only score a
// trade it personally watched open and close — a round trip that fully
// closed before the current server instance's first poll is invisible to
// it, by design, forever. But the orders table itself persists that history
// independent of any restart. This reconstructs CLOSED round trips (a Filled
// entry immediately followed by a Filled opposite-side exit that returns the
// position to flat) directly from order rows, so the trade COUNT/side/size/
// prices can be recovered even after the live tracker missed it.
//
// DELIBERATE LIMITATION — $ P&L is NOT computed here. A Filled order row
// carries no realized-P&L column (see this file's header comment — that's
// exactly why the live path uses balance-delta instead), and there is no
// verified per-contract point/tick-value multiplier anywhere in this
// codebase to convert an entry/exit price difference into dollars. Inventing
// one here would replace one wrong number (0 trades) with a different wrong
// number (a guessed $ figure) — worse, because a guessed number LOOKS
// trustworthy. `pnl: 0, pnlUnknown: true` keeps every existing dayPnl/
// tradeCount/size-freeze-guard consumer numerically safe (0 is neutral —
// doesn't inflate or deflate real P&L) while flagging plainly that this
// specific trade's $ result is not known and must be read off the broker's
// own orders table, not trusted from this app's numbers.
//
// Only reconstructs single-position sequential round trips (matches every
// real case observed live) — does not attempt to untangle scale-in/
// partial-fill pyramiding into multiple entries before one exit.
function reconstructClosedTradesFromOrders(orders, dayKeyMs) {
  if (!Array.isArray(orders) || dayKeyMs == null) return [];
  const filled = orders
    .filter(isFilledOrderRow)
    .map(o => ({
      symbol: o.Symbol,
      side: String(o.Side || '').toLowerCase(),
      qty: Number(o['Filled Qty'] || o.Qty) || 0,
      price: parseBalance(o['Avg Fill Price']),
      at: parseISTTimestamp(o['Update Time']),
    }))
    .filter(o => o.at != null && o.qty > 0 && o.price != null)
    .filter(o => o.at >= dayKeyMs && o.at < dayKeyMs + 86400000)
    .sort((a, b) => a.at - b.at);

  const bySymbol = {};
  const closed = [];
  for (const o of filled) {
    const st = bySymbol[o.symbol] || (bySymbol[o.symbol] = { qty: 0, entry: null });
    const wasFlat = st.qty === 0;
    if (wasFlat) st.entry = o;
    st.qty += (o.side === 'buy' ? o.qty : -o.qty);
    if (!wasFlat && st.qty === 0 && st.entry) {
      closed.push({
        symbol: o.symbol,
        side: st.entry.side,
        size: st.entry.qty,
        entryPrice: st.entry.price,
        exitPrice: o.price,
        entryAt: st.entry.at,
        exitAt: o.at,
        pnl: 0,
        pnlUnknown: true,
        source: 'backfilled-from-orders',
      });
      st.entry = null;
    }
  }
  return closed;
}

module.exports = { fold, freshState, parseBalance, istDayStartMs, reconstructClosedTradesFromOrders, parseISTTimestamp, isFilledOrderRow };
