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
// VERIFICATION STATUS (2026-08-20/21 — was the longest-standing open blocker
// in TODOS.md; see test/replay-2026-08-20.test.js for the full replay):
//   CONFIRMED  the point value. 117/117 realized P&L values across 9 days of
//              CSV-confirmed history, PLUS all 11 raw fills from a Tradeify-
//              exported day, are exact multiples of $0.50, zero violations.
//              MNQ is $2.00/point. This is what makes the price-derived
//              cross-check below legitimate rather than invented.
//   CONFIRMED  the day total, against real outside ground truth. Replayed
//              2026-08-20's actual fills (Tradeify's own P&L calendar:
//              -$264.10; the raw Tradovate export) through this fold at
//              realistic poll cadence, landing mid-scale-in and mid-split-
//              exit — the fixed code reconstructs -$264.10 exactly, and
//              every individual round trip's P&L matches too.
//   RETRACTED  an earlier claim here that the PRE-FIX fold's balance-delta
//              endpoint and day total for this same day were "confirmed" /
//              "plausible" (balanceAtLastFlat 49,953.80, dayPnl -44.65). That
//              was checked only against a number typed in at the time, not
//              against real outside ground truth. The real total is -264.10
//              — a $219 gap, far beyond commission or the "baseline at first
//              poll" blind spot cited then. The entry-fill mis-scoring bug
//              corrupted the running balance anchor, not just the count.
//              Lesson: self-consistency (a number matching what was on
//              screen at the time) is not the same as correctness.
//   CONFIRMED  per-trade attribution, for the shapes exercised by that real
//              day (scale-in, split exit, poll-aliased scalp). Also caught,
//              by this same replay: analyzeOrderWalk's `size` field was
//              wrong for any multi-fill entry or exit — see its "PEAK
//              absolute position size" comment below for the three attempts
//              it took to get right. That bug fed both the backfill and
//              expectedPnlFromFills() before being caught here.
//   NOT YET    a real reversal (long-flips-to-short without passing flat) —
//              covered by unit tests, not yet by a real trading day.
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

// 2026-08-20: bumped whenever a change to fold() makes a PERSISTED state
// written by older code untrustworthy, so loadTVBrokerFeedState() can discard
// it instead of restoring numbers produced by a known-buggy fold.
//
// v2: the entry-fill over-counting fix. A v1 state's tradeCount was inflated
// by one per FILL rather than per round trip (see the backstop's 2026-08-20
// comment). That count is not a cosmetic number — it feeds tradesPerDay,
// trade-confirm-rules and size-freeze-guard, so restoring it after the fix
// would keep enforcing yesterday's bug. Observed live: a state holding
// tradeCount 9 for ~4 real round trips kept the session locked at "9/3 —
// DONE" and would have survived the fix on disk until IST rollover.
const STATE_SCHEMA_VERSION = 2;

function freshState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    dayKeyMs: null,
    balanceAtLastFlat: null, // account balance the last time we observed flat
    wasFlat: null,           // null = not yet known (no poll processed this day)
    sizeSeenThisTrade: 0,
    dayPnl: 0,
    tradeCount: 0,
    maxSize: 0,
    lastLossTs: 0,
    trades: [], // {size, pnl, at} for today, oldest first
    // 2026-08-20: how many CLOSED ROUND TRIPS (per the broker's own order
    // history, via reconstructClosedTradesFromOrders) had completed as of the
    // last trade this fold scored. The poll-aliasing backstop below fires only
    // when this number has actually moved — see its comment for the live
    // incident that made "a new fill exists" an insufficient guard.
    closedRoundTripsScored: 0,
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
 * @param {object} snap       { balance: number|null, isFlat: boolean, openSize: number, nowMs: number,
 *                              hasNewFill?: boolean, closedRoundTrips?: number }
 *   closedRoundTrips — how many closed round trips today's order history shows
 *   RIGHT NOW (reconstructClosedTradesFromOrders(orders, dayKey).length). Omit
 *   (or pass null) only when the orders table could not be read this poll; see
 *   the backstop branch for what that degrades to.
 * @returns {object} next state (new object — prevState is never mutated)
 */
function fold(prevState, snap) {
  const nowMs = snap.nowMs;
  const dayKeyMs = istDayStartMs(nowMs);
  const carrying = prevState && prevState.dayKeyMs === dayKeyMs ? prevState : freshState();
  const st = { ...carrying, dayKeyMs, trades: carrying.trades.slice() };

  const balance = typeof snap.balance === 'number' && Number.isFinite(snap.balance) ? snap.balance : null;
  const openSize = Number(snap.openSize) || 0;
  const closedRoundTrips = Number.isFinite(snap.closedRoundTrips) ? snap.closedRoundTrips : null;
  // A state persisted before this field existed (or restored mid-day) has no
  // baseline. Adopt the CURRENT round-trip count rather than 0 — adopting 0
  // would make every round trip already completed today look "new" and fire
  // the backstop for each one. This can only ever under-count, never
  // fabricate, which is the correct direction to fail on a live-money account.
  if (!Number.isFinite(st.closedRoundTripsScored)) {
    st.closedRoundTripsScored = closedRoundTrips === null ? 0 : closedRoundTrips;
  }

  if (!snap.isFlat) st.sizeSeenThisTrade = Math.max(st.sizeSeenThisTrade, openSize);

  if (st.balanceAtLastFlat === null) {
    // First readable poll (this day) — establish the baseline. Can't score
    // whatever trade may already be mid-flight, only trades from here on.
    // wasFlat still tracks even if balance itself was unreadable this poll,
    // so an unreadable-balance poll never masks a real flat transition.
    if (balance !== null) st.balanceAtLastFlat = balance;
    st.wasFlat = snap.isFlat;
    // Anchor the round-trip baseline to whatever the order history already
    // shows at this first poll. Round trips that closed before we started
    // watching are the backfill's business (server.js), not the backstop's —
    // without this anchor the backstop would re-score every one of them.
    if (closedRoundTrips !== null) st.closedRoundTripsScored = closedRoundTrips;
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
    // This round trip is now accounted for — advance the baseline so the
    // backstop below cannot score the SAME close a second time.
    if (closedRoundTrips !== null) st.closedRoundTripsScored = closedRoundTrips;
  } else if (closedRoundTrips !== null && closedRoundTrips > st.closedRoundTripsScored && balance !== null) {
    // 2026-08-20 (review, two CRITICALs that collapse into one branch):
    //
    // (a) A FLIP was never counted. Both the observed branch above and the
    //     old backstop required isFlat === true. Going long 2 → short 2
    //     never passes through flat, so neither could fire: the broker booked
    //     a completed round trip, the fold recorded nothing, and the eventual
    //     flat close folded BOTH round trips into one trade with one combined
    //     P&L. Permanently -1 on the count per flip. position-events.js names
    //     `flipped` as a first-class event, so the app could see the thing it
    //     could not count.
    //
    // (b) The old backstop required `hasNewFill` AND the round-trip count to
    //     advance IN THE SAME POLL. `hasNewFill` is an EDGE and one-shot —
    //     server.js burns the Order ID the first time it sees the row — while
    //     the round-trip count is a LEVEL. When they land on different polls
    //     (closing row with no Order ID, a poll race, ordersTableSuspect
    //     flipping across the fill) the trade fell through to the re-anchor
    //     below, which discarded the pending P&L AND never counted it.
    //
    // The round-trip count is strictly better evidence than the fill edge: it
    // comes from a net-position walk that only emits on a genuine return to
    // flat, and unlike an edge it cannot be missed by looking one poll late.
    // So when it is available, it alone decides, and flatness is irrelevant.
    const pnl = balance - st.balanceAtLastFlat;
    // On a flip we DID observe the position that just closed, so its size is
    // known; only the poll-aliased case is genuinely unobserved.
    const size = st.sizeSeenThisTrade;
    st.trades.push(size > 0 ? { size, pnl, at: nowMs } : { size: 0, pnl, at: nowMs, inferred: true });
    st.dayPnl += pnl;
    st.tradeCount += 1;
    if (size > 0) st.maxSize = Math.max(st.maxSize, size);
    if (pnl < 0) st.lastLossTs = nowMs;
    st.balanceAtLastFlat = balance;
    // A flip leaves a NEW position already open at this size — start the next
    // trade's high-water mark from it rather than from zero, or the reversed
    // leg would report size 0 when it closes.
    st.sizeSeenThisTrade = snap.isFlat ? 0 : openSize;
    st.closedRoundTripsScored = closedRoundTrips;
  } else if (closedRoundTrips === null && st.wasFlat === true && snap.isFlat === true && balance !== null && balance !== st.balanceAtLastFlat && snap.hasNewFill) {
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
    //
    // 2026-08-20 BUG FIX (found live, Anoop's screenshot: HUD read "9/3
    // TRADES — DONE" and locked him out after ~4 real round trips; the
    // recorded state was 1 observed trade + 8 `inferred` ones). `hasNewFill`
    // is necessary but NOT sufficient: it proves *an order filled*, not that
    // *a position closed*. An ENTRY fill satisfies it exactly as well as an
    // exit fill. So the sequence
    //     19:16:44  Buy 2 fills (entry)   → balance moves by the commission
    //     19:16:47  poll lands: positions panel has not rendered the new
    //               position yet, so isFlat still reads true
    // hit flat→flat + balance-moved + new-fill and scored a completed trade
    // that had in fact only just OPENED. Confirmed against the broker's own
    // orders table for 2026-08-20: three real round trips (14:42/14:43,
    // 19:16/19:19, 19:45/19:46) were each scored 2-3 times, once per fill
    // in them, and their P&L was split across the duplicates. Note dayPnl
    // stayed CORRECT throughout (it sums balance deltas, and the deltas still
    // partition the same total) — it was purely the trade COUNT, and the
    // per-trade `size`, that were wrong. That count feeds tradesPerDay,
    // trade-confirm-rules and size-freeze-guard, so it stops a real session.
    //
    // The fix is to require evidence that a position actually returned to
    // flat: `closedRoundTrips` is a per-symbol signed-quantity net-position
    // walk over today's filled orders (reconstructClosedTradesFromOrders),
    // which emits a record only on a genuine return to flat and is immune to
    // both scale-ins and split exits. Firing only when that count has moved
    // since the last trade we scored means an entry fill can no longer be
    // mistaken for a close.
    //
    // When `closedRoundTrips` is null the orders table was unreadable this
    // poll, and we fall back to the 2026-08-19 `hasNewFill`-only behavior:
    // still guarded against pure balance drift, but able to over-count again.
    // server.js always supplies the number when the read is trustworthy.
    const pnl = balance - st.balanceAtLastFlat;
    // 2026-08-21 (Anoop's D1): tag WHERE the evidence came from. This trade
    // was scored on the degraded path — the orders table was unreadable, the
    // walk disagreed with the positions panel, or a row would not parse — so
    // it rests on the fill EDGE alone, which is the rule that produced the
    // 9/3 over-count. It is still recorded (refusing to score under-counts,
    // which silently lets him trade past the cap), but it is marked so the
    // count can be shown as provisional and enforced as advisory rather than
    // hard-locking a live session on a number we cannot stand behind.
    st.trades.push({ size: 0, pnl, at: nowMs, inferred: true, evidence: 'degraded' });
    st.dayPnl += pnl;
    st.tradeCount += 1;
    if (pnl < 0) st.lastLossTs = nowMs;
    st.balanceAtLastFlat = balance;
    st.sizeSeenThisTrade = 0;
    if (closedRoundTrips !== null) st.closedRoundTripsScored = closedRoundTrips;
  } else if (st.wasFlat === true && snap.isFlat === true && balance !== null && balance !== st.balanceAtLastFlat && !snap.hasNewFill
             && !(closedRoundTrips !== null && closedRoundTrips > st.closedRoundTripsScored)) {
    // Balance moved while flat but no new fill was seen this poll — per the
    // fix above, do NOT score a trade. But also do NOT silently keep the
    // stale baseline forever — re-anchor to the current balance so a later
    // GENUINE flat-to-flat trade (with a real new fill) computes its delta
    // from the settled/current number, not from a balance that was already
    // known-wrong minutes ago.
    st.balanceAtLastFlat = balance;
  }
  // 2026-08-20: note the `!snap.hasNewFill` guard added to the branch above,
  // and that there is deliberately NO else-branch for "a fill happened but
  // nothing closed yet" (the entry-fill case the fix above stopped scoring).
  // Caught by this file's own new test rather than live: re-anchoring on an
  // ENTRY fill would move balanceAtLastFlat past the entry commission, so the
  // eventual close would compute its delta from the post-commission balance
  // and that commission would vanish from BOTH the trade's pnl and dayPnl —
  // replacing an over-counted trade COUNT with a quietly understated P&L,
  // which is the worse bug of the two. Holding the baseline across the open
  // position is what makes the close's balance delta a true full round-trip
  // result. Verified against 2026-08-20's real numbers: holding the baseline
  // reproduces the +35.60 and +67.00 the account actually recorded.
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
// 2026-08-20 (review, H5): the walk now also REPORTS ITS OWN HEALTH, because
// the fold started depending on its count and a silently-wrong count is worse
// than no count. Two failure modes, both found by inspection:
//
//   1. A row that survives isFilledOrderRow but fails to parse (unreadable
//      Avg Fill Price or Update Time) is dropped by the validity filter. The
//      running sum then never returns to zero, so EVERY later round trip in
//      that symbol becomes invisible — the count freezes, which now means the
//      poll-aliasing backstop is disabled for the rest of the day and the
//      mismatch banner pins on permanently. The same thing happens to a
//      position opened before IST midnight and closed after it: the day filter
//      keeps the exit and discards the entry.
//   2. The old close test was `st.qty === 0` exactly, so a fill that CROSSES
//      zero (sell 5 against a long 2) reversed the position without ever
//      booking the close — the order-history twin of the fold's own flip bug.
//
// `netBySymbol` lets the caller cross-check the walk against the real
// positions panel: if the walk thinks a symbol is still open while the broker
// says flat, the walk is desynced and its count must NOT be trusted.
function analyzeOrderWalk(orders, dayKeyMs) {
  const empty = { closed: [], netBySymbol: {}, droppedRows: 0 };
  if (!Array.isArray(orders) || dayKeyMs == null) return empty;
  const parsed = orders
    .filter(isFilledOrderRow)
    .map(o => ({
      symbol: o.Symbol,
      side: String(o.Side || '').toLowerCase(),
      qty: Number(o['Filled Qty'] || o.Qty) || 0,
      price: parseBalance(o['Avg Fill Price']),
      at: parseISTTimestamp(o['Update Time']),
    }));
  // Unparseable is a DEFECT (the row is real, we just can't read it) and is
  // counted. Belonging to another day is NORMAL filtering and is not.
  const droppedRows = parsed.filter(o => o.at == null || !(o.qty > 0) || o.price == null).length;
  const filled = parsed
    .filter(o => o.at != null && o.qty > 0 && o.price != null)
    .filter(o => o.at >= dayKeyMs && o.at < dayKeyMs + 86400000)
    .sort((a, b) => a.at - b.at);

  const bySymbol = {};
  const closed = [];
  for (const o of filled) {
    const st = bySymbol[o.symbol] || (bySymbol[o.symbol] = { qty: 0, entry: null, peakQty: 0 });
    const before = st.qty;
    const after = before + (o.side === 'buy' ? o.qty : -o.qty);
    // A close is "returned to flat" OR "crossed through flat" — the latter is
    // a reversal, which closes the old position and opens a new one on the
    // same fill.
    const crossed = before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before));
    // 2026-08-21 BUG FIX (found by the 2026-08-20 replay test, real data,
    // three attempts). st.entry.qty only captured the FIRST fill's size — a
    // scale-in entry (this codebase's own RT3: six Sell-2 fills before one
    // Buy-12 exit) reported 2, not the true 12-lot position. abs(before) at
    // the closing fill fixed that but broke split exits the same way in
    // reverse (RT4's Buy 2, closed via two Sell-1 fills, reported 1). The
    // correct answer is the PEAK absolute position size reached anywhere
    // between open and close, tracked in st.peakQty. It updates on every fill
    // EXCEPT the crossing fill itself: on a reversal, that fill's resulting
    // position belongs to the NEW leg (e.g. -3 opening a short) — folding it
    // into the peak here would report the leg that is closing right now with
    // a size that actually describes the leg about to open. The closing
    // leg's peak has to be read (below) before it gets overwritten for the
    // next one. This silently corrupted two real consumers before being
    // caught: the backfill (wrong size on any multi-fill round trip
    // recovered after a restart) and expectedPnlFromFills' P&L cross-check
    // (wrong gross P&L for exactly the shapes — scale-ins, split exits,
    // reversals — most likely to trigger it).
    if (before === 0) {
      st.entry = o;
      st.peakQty = Math.abs(after);
    } else if (!crossed) {
      st.peakQty = Math.max(st.peakQty, Math.abs(after));
    }
    if (crossed && st.entry) {
      closed.push({
        symbol: o.symbol,
        side: st.entry.side,
        size: st.peakQty,
        entryPrice: st.entry.price,
        exitPrice: o.price,
        entryAt: st.entry.at,
        exitAt: o.at,
        // 2026-08-20 (found in review): `at` is the field every consumer of
        // this array reads as "when this trade happened" (fold's own live
        // records use it, and mistake-patterns.js's F2b timing guard checks
        // it). Backfilled records carried entryAt/exitAt but no `at`, so a
        // time-based detector written against the documented trade shape would
        // silently skip them on a guard it believed was passing. Mirrored from
        // exitAt — the close is what `at` means on a live-fold record too.
        at: o.at,
        pnl: 0,
        pnlUnknown: true,
        source: 'backfilled-from-orders',
      });
      // On a reversal the residual quantity IS a new position, opened by this
      // same fill — so it becomes the next round trip's entry rather than
      // leaving the walk with no entry to close against later. Its peak
      // resets to the residual size, not 0 — abs(after) is genuinely how
      // large the new position already is at the moment it was opened.
      st.entry = after === 0 ? null : o;
      st.peakQty = after === 0 ? 0 : Math.abs(after);
    }
    st.qty = after;
  }

  const netBySymbol = {};
  for (const [symbol, st] of Object.entries(bySymbol)) {
    if (st.qty !== 0) netBySymbol[symbol] = st.qty;
  }
  return { closed, netBySymbol, droppedRows };
}

// Back-compat wrapper: the backfill only ever wanted the closed round trips.
function reconstructClosedTradesFromOrders(orders, dayKeyMs) {
  return analyzeOrderWalk(orders, dayKeyMs).closed;
}

/**
 * Is the order walk's view of the world consistent with the broker's own
 * positions panel? Desync means the walk's round-trip count is frozen or
 * wrong, so callers must fall back to the degraded path rather than gate on it.
 *
 * @param {object} netBySymbol  from analyzeOrderWalk
 * @param {Array} positionRows  the live positions table rows
 */
function isWalkDesynced(netBySymbol, positionRows) {
  const open = new Map();
  if (Array.isArray(positionRows)) {
    for (const p of positionRows) {
      if (!p || typeof p !== 'object') continue;
      const sym = String(p.Symbol || '').trim();
      if (!sym) continue;
      const q = Number(String(p.Qty == null ? '' : p.Qty).replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(q) && q !== 0) open.set(sym, Math.abs(q));
    }
  }
  const walkSymbols = Object.keys(netBySymbol || {});
  // The walk says a position is open that the broker doesn't show → the walk
  // never booked a close it should have (a dropped or unreadable row).
  for (const sym of walkSymbols) {
    if (!open.has(sym)) return true;
    if (open.get(sym) !== Math.abs(netBySymbol[sym])) return true;
  }
  // The broker shows a position the walk knows nothing about → the walk is
  // missing the entry (e.g. it filled before this IST day started).
  for (const sym of open.keys()) {
    if (!walkSymbols.includes(sym)) return true;
  }
  return false;
}

// ── Independent P&L cross-check (2026-08-20) ───────────────────────────────
// The fold derives realized P&L from BALANCE DELTAS. That is the only source
// confirmed against the account itself, but it has no second opinion — and
// TODOS.md carried "never checked against a real closed trade with non-zero
// P&L" as an open blocker for days, because there was nothing to check it
// AGAINST.
//
// There is now. The order walk already recovers entry price, exit price, side
// and size for every closed round trip, and the point value is no longer a
// guess: scripts/verify-fold.js checked 117 real broker-confirmed trades
// across 9 days and found every single realized P&L to be an exact multiple
// of $0.50 — zero violations — which pins MNQ at $2.00/point (0.25 tick =
// $0.50/tick), and those per-trade figures reconcile exactly to the day
// ledger on all 9 days. So a price-derived P&L is now a legitimate SECOND
// derivation, not the invented number the older comment in this file
// (correctly, at the time) refused to produce.
//
// This does NOT replace the balance delta. Balance delta remains the truth
// for the guardrail: it is the account, and it captures fees and anything
// else the exchange did. This is a CROSS-CHECK — two independent derivations
// that should agree, so that a disagreement becomes a signal instead of a
// silent wrong number. Same discipline as the round-trip count reconciliation.
//
// Symbols with no VERIFIED point value return null rather than a guess. MGC
// has no trades in the checked history, so it is deliberately absent: a
// cross-check that invents its own multiplier would manufacture false alarms
// (or false comfort), which is worse than declining to check.
const VERIFIED_POINT_VALUE = {
  MNQ: 2.0, // 117/117 realized P&L values exact at $0.50/tick — see scripts/verify-fold.js
};

// TradingView renders contracts as "MNQU6"/"MGCQ6" — root plus month/year code.
function contractRoot(symbol) {
  const up = String(symbol || '').toUpperCase();
  // The month/year suffix is REQUIRED in this match, not optional. With it
  // optional and a lazy root ([A-Z]+?), the engine happily matched the entire
  // symbol as the root and the suffix as empty — so "MNQU6" resolved to
  // "MNQU6", pointValueFor returned null, and the cross-check silently
  // declined on every real contract. Caught by this module's own tests, which
  // is also why two of them were passing on null === null.
  const m = up.match(/^([A-Z]+?)[FGHJKMNQUVXZ][0-9]{1,2}$/);
  return m ? m[1] : up;
}

function pointValueFor(symbol) {
  const v = VERIFIED_POINT_VALUE[contractRoot(symbol)];
  return typeof v === 'number' ? v : null;
}

/**
 * Expected realized P&L for one closed round trip, derived from its FILL
 * PRICES rather than from the account balance.
 *
 * @param {object} rt  a closed record from analyzeOrderWalk
 * @param {number} commissionPerContractPerSide  from rules.json — never hardcoded
 * @returns {object|null} { gross, commission, net, pointValue } or null when
 *   the symbol has no verified point value or the record is incomplete.
 */
function expectedPnlFromFills(rt, commissionPerContractPerSide) {
  if (!rt || typeof rt !== 'object') return null;
  const pv = pointValueFor(rt.symbol);
  if (pv === null) return null;
  const { entryPrice, exitPrice, size, side } = rt;
  if (![entryPrice, exitPrice, size].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  if (size <= 0) return null;
  // A long profits when price rises; a short when it falls.
  const dir = side === 'sell' ? -1 : 1;
  const gross = (exitPrice - entryPrice) * dir * pv * size;
  const rate = Number(commissionPerContractPerSide);
  const commission = Number.isFinite(rate) ? rate * size * 2 : 0;
  return { gross, commission, net: gross - commission, pointValue: pv };
}

// True when a persisted state was written by a fold whose counts we no longer
// trust. Callers must discard it (freshState()) rather than restore it.
function isStateSchemaStale(saved) {
  if (!saved || typeof saved !== 'object') return true;
  return Number(saved.schemaVersion) !== STATE_SCHEMA_VERSION;
}

module.exports = { fold, freshState, parseBalance, istDayStartMs, reconstructClosedTradesFromOrders, analyzeOrderWalk, isWalkDesynced, parseISTTimestamp, isFilledOrderRow, isStateSchemaStale, STATE_SCHEMA_VERSION, expectedPnlFromFills, pointValueFor, contractRoot };
