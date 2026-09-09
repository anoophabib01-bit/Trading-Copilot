'use strict';
// G26: size wildcard shared with the CSV importer — a best-effort fold size
// (sizeSeenThisTrade) is a wildcard, a verified fill count is not. One copy.
const { sizeIsBestEffort } = require('./renderer/trade-identity.js');
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
    // 2026-08-28: flat transitions with a ZERO balance delta — no fill
    // happened, so they are not trades. Counted rather than dropped silently
    // so the app can show that the guard did something, and how often.
    phantomFlats: 0,
    lastPhantomAt: null,
    // 2026-08-28: consecutive polls showing flat. A close is only folded once
    // flat has been SEEN TWICE or the broker's round-trip count confirms it —
    // one empty read of the positions table is not a close.
    flatConfirmCount: 0,
    flatFirstSeenAt: null,   // when flat was FIRST observed — the real close time
    trades: [], // {size, pnl, at} for today, oldest first
    // 2026-08-20: how many CLOSED ROUND TRIPS (per the broker's own order
    // history, via reconstructClosedTradesFromOrders) had completed as of the
    // last trade this fold scored. The poll-aliasing backstop below fires only
    // when this number has actually moved — see its comment for the live
    // incident that made "a new fill exists" an insufficient guard.
    closedRoundTripsScored: 0,
    // 2026-08-24: the broker's OWN session P&L, copied verbatim from the
    // account-summary panel on each poll (see readBrokerPnl at the foot of
    // this file for why this is the authoritative figure and dayPnl above is
    // now the fallback). Persisted with the rest of the state so a restart
    // mid-session shows the real number immediately rather than re-deriving
    // a partial one from whatever balance it happens to see first.
    brokerTotalPnl: null,
    brokerOpenPnl: null,
    brokerNetLiq: null,
    brokerPnlAt: null,
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
// ── Direction and prices on a folded trade (2026-08-25) ─────────────────────
// Anoop: "also the side has not been mentioned check with it too! was the
// trade long or short?"
//
// Every live-written row had side/ep/xp/mp null, so the Journal showed "—"
// for direction on a whole day of trading. That was never a data-availability
// problem — it was two halves of the same trade never being introduced:
//
//   the FOLD knows the exact $ P&L (a balance delta at flat) and nothing else;
//   the WALK (analyzeOrderWalk) knows side, entry price, exit price, size and
//   both timestamps — read straight off the broker's own order rows — but
//   deliberately refuses to compute $ (see its header: no per-contract
//   multiplier it trusts, and a guessed dollar figure LOOKS trustworthy).
//
// server.js already computed the walk every poll to get its round-trip COUNT,
// then threw the records themselves away. Joining them gives a complete row
// with no new inference anywhere: every field still comes from the source
// that actually observed it.
//
// STRICTLY GATED. The join is only sound when this poll's balance delta and
// exactly one walk round trip describe the same close:
//   - the walk must be trustworthy this poll (server.js passes null when it
//     is desynced or dropped rows — the same gate its count already uses);
//   - the count must have advanced by EXACTLY 1. If two round trips closed
//     inside one poll interval, the single balance delta spans both and
//     there is no one side to attach — stamping either one would assert a
//     direction for a P&L that is not that trade's.
// When the gate fails the row is written exactly as before: null side, no
// prices. Missing stays missing rather than becoming a plausible guess.
function walkDetailFor(snap, prevScored, closedRoundTrips) {
  const records = Array.isArray(snap.closedRoundTripRecords) ? snap.closedRoundTripRecords : null;
  if (!records || closedRoundTrips === null) return null;
  if (closedRoundTrips - prevScored !== 1) return null;
  const rt = records[closedRoundTrips - 1];
  if (!rt || (rt.side !== 'buy' && rt.side !== 'sell')) return null;
  const d = {
    // The row vocabulary is LONG/SHORT everywhere in this app (day_trades,
    // MAE/MFE, the tolerance identity); the broker's word is buy/sell. Same
    // translation day-rollup.js's normalizeSide does, and for the same
    // reason — a raw 'BUY' beside a historical 'LONG' silently reads as a
    // short to MAE/MFE and can never tolerance-match its own CSV row.
    side: rt.side === 'buy' ? 'LONG' : 'SHORT',
  };
  if (Number.isFinite(rt.entryPrice)) d.entryPrice = rt.entryPrice;
  if (Number.isFinite(rt.exitPrice)) d.exitPrice = rt.exitPrice;
  if (Number.isFinite(rt.entryAt)) d.entryAt = rt.entryAt;
  if (Number.isFinite(rt.exitAt)) d.exitAt = rt.exitAt;
  if (Number.isFinite(rt.entryAt) && Number.isFinite(rt.exitAt) && rt.exitAt >= rt.entryAt) {
    d.holdSec = Math.round((rt.exitAt - rt.entryAt) / 1000);
  }
  // The walk's size is the PEAK position between open and close — the same
  // number the fold's sizeSeenThisTrade is trying to observe, but recovered
  // from order rows rather than from catching a poll mid-trade. It is the
  // only way a poll-aliased scalp (opened and closed inside one 10s
  // interval) gets a real size instead of the 0 "not observed" sentinel.
  if (Number.isFinite(rt.size) && rt.size > 0) d.walkSize = rt.size;
  return d;
}

// Merge walk detail onto a trade record the fold is about to push. Never
// overwrites the fold's own P&L or observed size — those are the fold's to
// know. `walkSize` is applied ONLY where size was genuinely unobserved (0).
function applyWalkDetail(rec, detail) {
  if (!detail) return rec;
  const { walkSize, ...fields } = detail;
  const out = Object.assign({}, rec, fields);
  if (!(out.size > 0) && walkSize > 0) {
    out.size = walkSize;
    // The row is no longer size-unknown, so the sentinel that told every
    // size-rule consumer "0 means not observed" must go with it.
    delete out.inferred;
  }
  return out;
}

function fold(prevState, snap) {
  const nowMs = snap.nowMs;
  const dayKeyMs = istDayStartMs(nowMs);
  const carrying = prevState && prevState.dayKeyMs === dayKeyMs ? prevState : freshState();
  const st = { ...carrying, dayKeyMs, trades: carrying.trades.slice() };

  const balance = typeof snap.balance === 'number' && Number.isFinite(snap.balance) ? snap.balance : null;
  const openSize = Number(snap.openSize) || 0;
  const closedRoundTrips = Number.isFinite(snap.closedRoundTrips) ? snap.closedRoundTrips : null;
  // 2026-09-02: carried on the state so effectiveTradeCount can tell a walk
  // figure that is CURRENT from one that is merely the last it ever had. Left
  // untouched (rather than defaulted to false) when the caller does not supply
  // it, so an older caller cannot silently mark a healthy walk as stale.
  // Read the baseline ONCE, here, before any branch advances it — walkDetailFor
  // needs the count as it stood at the start of this poll to tell "one round
  // trip closed" from "two did".
  const scoredBefore = Number.isFinite(carrying.closedRoundTripsScored) ? carrying.closedRoundTripsScored : 0;
  // A state persisted before this field existed (or restored mid-day) has no
  // baseline. Adopt the CURRENT round-trip count rather than 0 — adopting 0
  // would make every round trip already completed today look "new" and fire
  // the backstop for each one. This can only ever under-count, never
  // fabricate, which is the correct direction to fail on a live-money account.
  if (!Number.isFinite(st.closedRoundTripsScored)) {
    st.closedRoundTripsScored = closedRoundTrips === null ? 0 : closedRoundTrips;
  }
  // Recorded on EVERY poll, before any early return, so the flag can never
  // describe an older poll than the number it qualifies.
  if (snap.walkTrusted !== undefined) st.walkTrusted = !!snap.walkTrusted;

  // 2026-08-24: capture the broker's own session P&L FIRST, before any
  // branch below can return early. The first-poll branch returns without
  // scoring, and on a restart that is the poll whose number matters most —
  // it is the one that replaces a stale -$154.20 with the real +$399.70.
  // These are recorded, never folded into dayPnl: the balance-delta
  // arithmetic below stays exactly as it was so per-trade attribution and
  // every existing test remain untouched. Precedence between the two lives
  // in effectiveDayPnl(), not here.
  const brokerTotalPnl = typeof snap.brokerTotalPnl === 'number' && Number.isFinite(snap.brokerTotalPnl) ? snap.brokerTotalPnl : null;
  const brokerOpenPnl = typeof snap.brokerOpenPnl === 'number' && Number.isFinite(snap.brokerOpenPnl) ? snap.brokerOpenPnl : null;
  const brokerNetLiq = typeof snap.brokerNetLiq === 'number' && Number.isFinite(snap.brokerNetLiq) ? snap.brokerNetLiq : null;
  if (brokerTotalPnl !== null) {
    st.brokerTotalPnl = brokerTotalPnl;
    st.brokerOpenPnl = brokerOpenPnl;
    st.brokerPnlAt = nowMs;
  }
  // Net Liq is stored independently of the P&L columns: it is readable even
  // on a poll where the P&L columns are not, and it is the account figure he
  // reconciles against his statement.
  if (brokerNetLiq !== null) st.brokerNetLiq = brokerNetLiq;
  const brokerHeaderBalance = typeof snap.brokerHeaderBalance === 'number' && Number.isFinite(snap.brokerHeaderBalance) ? snap.brokerHeaderBalance : null;
  if (brokerHeaderBalance !== null) st.brokerHeaderBalance = brokerHeaderBalance;
  if (typeof snap.brokerSummaryStale === 'boolean') st.brokerSummaryStale = snap.brokerSummaryStale;
  // An unreadable summary this poll must NOT blank a good reading from the
  // last one — effectiveDayPnl() ages it out on its own timer instead, so a
  // single flaky read degrades to "slightly stale" rather than to "no number".

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

  // ── ONE EMPTY READ IS NOT A CLOSE (2026-08-28) ───────────────────────────
  // The positions table reading empty for a single poll is indistinguishable
  // from a genuine close, and the fold treated both as one. Live consequence
  // on 2026-08-28: a real LONG 29652.75 -> 29682.75 was open from 19:10:04 to
  // 19:14:43, and a blip at 19:12:49 folded a SECOND trade mid-flight. The
  // enrich path then back-filled that phantom row's prices from the order
  // walk, so it only became recognisable as a duplicate AFTER the merge that
  // would have caught it had already run. Protocol 2 kept repairing it and the
  // writer kept re-creating it.
  //
  // The zero-delta guard cannot catch this one: the balance HAD moved, so the
  // delta was non-zero. What was missing is proof that the position actually
  // closed.
  //
  // Two independent proofs are accepted, and either is enough:
  //   1. PERSISTENCE — flat observed on two consecutive polls. A one-poll
  //      blink is not a close.
  //   2. EVIDENCE — the broker's own closed-round-trip count moved. That is
  //      the order history confirming a round trip completed, and it is
  //      trusted immediately because it is not an inference.
  //
  // Requiring BOTH would lose a real trade whenever the order table lagged;
  // requiring NEITHER is what produced the phantom. Either-or is the only
  // combination that is neither blind nor deaf.
  const roundTripMoved = closedRoundTrips !== null && closedRoundTrips > st.closedRoundTripsScored;
  if (st.wasFlat === false && snap.isFlat === true && balance !== null
      && !roundTripMoved && (st.flatConfirmCount || 0) < 1) {
    // First flat sighting with no corroboration. Hold: do NOT fold, do NOT
    // move the baseline, and do NOT flip wasFlat — so if the next poll shows
    // the position still open, this was a blink and nothing happened.
    st.flatConfirmCount = (st.flatConfirmCount || 0) + 1;
    // Remember WHEN flat was first seen. The trade closed then, not when the
    // next poll happened to confirm it — stamping the confirmation time would
    // push every close ~10s late and misreport hold times and gaps.
    if (st.flatFirstSeenAt == null) st.flatFirstSeenAt = nowMs;
    return st;
  }
  if (!snap.isFlat) { st.flatConfirmCount = 0; st.flatFirstSeenAt = null; }

  if (st.wasFlat === false && snap.isFlat === true && balance !== null) {
    const pnl = balance - st.balanceAtLastFlat;
    const size = st.sizeSeenThisTrade;
    // The close happened when flat was FIRST seen, not at this confirming poll.
    const closedAt = st.flatFirstSeenAt != null ? st.flatFirstSeenAt : nowMs;
    st.flatConfirmCount = 0;
    st.flatFirstSeenAt = null;

    // ── ZERO-DELTA GUARD (2026-08-28) ─────────────────────────────────────
    // A closed trade ALWAYS moves the balance, because commission always
    // applies — the fold's P&L is a balance delta, so it is net by
    // construction. A delta of exactly zero therefore means no fill happened:
    // the positions table read empty for a poll and then repopulated, which
    // registers as a not-flat -> flat transition with no money behind it.
    //
    // Found live: Anoop took ONE trade on 2026-08-28 and the fold held two —
    // {size 1, pnl 1.10} and a phantom {size 1, pnl 0} three minutes later.
    // That phantom was the whole cause of "2/10 trades" against one real
    // trade, of the LIVE FEED MISMATCH banner (broker order history 0 round
    // trips vs tracker 2), and of the day-record SELF-HEAL firing every poll
    // forever trying to write a trade that must not exist.
    //
    // Counted, never silently dropped: `phantomFlats` is the evidence that
    // this happened, and the UI reports it rather than the number simply
    // being quietly right. A guard whose work is invisible is indistinguish-
    // able from a guard that is not running.
    if (pnl === 0) {
      st.phantomFlats = (st.phantomFlats || 0) + 1;
      st.lastPhantomAt = closedAt;
      st.balanceAtLastFlat = balance;
      st.sizeSeenThisTrade = 0;
      st.wasFlat = true;
      return st;
    }

    st.trades.push(applyWalkDetail({ size, pnl, at: closedAt }, walkDetailFor(snap, scoredBefore, closedRoundTrips)));
    st.dayPnl += pnl;
    st.tradeCount += 1;
    st.maxSize = Math.max(st.maxSize, size);
    if (pnl < 0) st.lastLossTs = closedAt;
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
    st.trades.push(applyWalkDetail(
      size > 0 ? { size, pnl, at: nowMs } : { size: 0, pnl, at: nowMs, inferred: true },
      walkDetailFor(snap, scoredBefore, closedRoundTrips)));
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
    //
    // 2026-08-24 — THE PHANTOM-TRADE FIX. This branch's entire justification
    // was "refusing to score loses the P&L", and that is no longer true: the
    // broker publishes its own session P&L (readBrokerPnl / effectiveDayPnl),
    // so when we have that number, nothing is lost by declining to invent a
    // trade here. What IS lost by scoring one is the trade COUNT, and that
    // is what stopped a real session — 2026-08-24 recorded 15 trades against
    // a real 7, of which these 8 phantoms were the whole difference, and
    // Now.md read "15 / 5" while he was deciding his next entry.
    //
    // So: re-anchor (never leave a stale baseline behind), but do not push a
    // trade, WHEN the broker's own P&L is in hand. When it is not, fall
    // through to the pre-existing behaviour unchanged — under-counting is
    // the worse failure while the day total depends on this fold, because it
    // silently lets him trade past the cap. The condition is exactly
    // "is the headline number independent of this branch yet".
    if (brokerTotalPnl !== null) {
      st.balanceAtLastFlat = balance;
      if (closedRoundTrips !== null) st.closedRoundTripsScored = closedRoundTrips;
      st.wasFlat = snap.isFlat;
      return st;
    }
    st.trades.push(applyWalkDetail({ size: 0, pnl, at: nowMs, inferred: true, evidence: 'degraded' },
      walkDetailFor(snap, scoredBefore, closedRoundTrips)));
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

// ── Repairing rows that were written before their direction was known ───────
// 2026-08-25, Anoop: "the side coloume is still empty and does not tell me
// which side have i taken the trade long or short. how can you solve it. if i
// have side information live then i can jude which side have i taken more
// trade and if it was as per my plan of Higher time frame."
//
// The walk-join added earlier the same day fixes this GOING FORWARD — the
// fold stamps side/prices on each trade as it books it. It does nothing for
// rows already on disk, and today's eleven were all written by the old code.
// "Restart and it will be right tomorrow" is not an answer to a question
// about today, and the same gap reopens after any crash, any poll where the
// orders table was unreadable, and every row ever written before this week.
//
// The order history does not expire when the process does. This is a REPAIR,
// not a re-import: it fills in blanks on rows that already exist and never
// adds, removes, reorders, or re-prices anything. P&L is untouched — that is
// the fold's, measured from the balance, and the walk has no dollars to offer
// (see analyzeOrderWalk's header).
//
// MATCHING. A stored row is joined to a walk round trip when their EXIT times
// agree within a tolerance and their sizes do not contradict. Exit time is
// the right key because the fold books a trade at the poll that observed the
// close, which can lag the broker's own fill stamp by up to a poll interval;
// entry time on a fold row is often just the same value copied.
//
// AMBIGUITY IS REFUSED, NOT GUESSED. If two round trips fall inside the
// window for one row, or one round trip is the best match for two rows, both
// are left alone. A wrong direction is worse than a blank one here: he is
// asking this question specifically to check his fills against his
// higher-timeframe plan, and a confidently wrong LONG would corrupt exactly
// the judgement he wants to make.
const ENRICH_EXIT_TOLERANCE_MS = 120000;

// ── Which folded trades never made it into the day record (2026-08-26) ─────
// Anoop: "it is not showing how is trades are done for the day."
//
// The fold had today's trade (tradeCount 1, pnl -203). day_trades.json had no
// rows for the day at all. The writer that bridges them runs ONCE, on the poll
// where tradeCount increases — so any of these loses the trade permanently:
//
//   - the server restarts after the fold persisted the trade (the count is
//     restored, so on the next poll it is no longer INCREASING and the
//     transition can never fire again);
//   - that single poll throws anywhere downstream of the fold;
//   - the order-walk join returns no records for it.
//
// A one-shot write with no retry is the wrong shape for a durable record. This
// is the reconciliation half: given the fold's trades and the rows already on
// disk, say which are missing, so the caller can write them on ANY later poll.
//
// Matching is (entry-time, P&L-in-cents). The day record's `t` is
// entryAt when the walk supplied one and the close time otherwise, so both
// are tried — a trade that gained an entry time after the row was first
// written must not be re-added as a second copy.
// How long after the real exit the balance fold can take to notice flat.
// Today's live example: exit 12:52:37, fold stamped 12:59:53 — about 7 min.
const SELFHEAL_MATCH_WINDOW_MS = 20 * 60 * 1000;

/**
 * Which folded trades are genuinely absent from the day's stored rows.
 *
 * ── THE DUPLICATION BUG THIS FIXES (2026-08-28) ──────────────────────────
 * This matched on `pnl-in-cents @ timestamp`. The same closed trade reaches
 * the day record by two routes that AGREE ON NEITHER FIELD:
 *
 *   walk-joined row : GROSS P&L, stamped at the real fill exit
 *   folded trade    : NET P&L,   stamped when the fold noticed flat
 *
 * Gross and net differ by exactly the commission, and the two timestamps are
 * minutes apart, so a trade already written by the walk never matched and was
 * "healed" in a second time. On 2026-08-28 Anoop took ONE trade and the store
 * held three rows; 2026-08-26 and 08-27 are mixed the same way.
 *
 * The two routes DO agree on size, on being the same flat event a few minutes
 * apart, and on the arithmetic between their P&Ls: gross - net == size ×
 * round-turn commission. Matching on those three is what makes a duplicate
 * recognisable. P&L equality is kept as a fast path so exact re-writes still
 * match when the routes happen to agree.
 *
 * Deliberately conservative in the SAFE direction: a false "already present"
 * loses a trade from the record, so a candidate must match on size AND be
 * inside the window AND have a P&L that is either equal or commission-apart.
 * Anything else is still reported missing and written.
 *
 * @param {number} opts.commissionPerContractPerSide from rules.json — never hardcoded
 */
function missingFromDayRows(foldTrades, rows, opts) {
  const o = opts || {};
  const commSide = Number.isFinite(o.commissionPerContractPerSide) ? o.commissionPerContractPerSide : null;
  const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : SELFHEAL_MATCH_WINDOW_MS;
  const list = Array.isArray(foldTrades) ? foldTrades : [];
  const stored = (Array.isArray(rows) ? rows : []).filter(r => r && Number.isFinite(r.pnl));

  // Fast path: exact P&L at an exact timestamp, mapped to the ROW INDEX so it
  // can be claimed. A plain Set here was a real bug — two folded trades with
  // the same size and P&L minutes apart both matched the single stored row,
  // so the second was silently declared already-present and LOST. One stored
  // row can only ever account for one folded trade.
  const exact = new Map();
  stored.forEach((r, i) => {
    const cents = Math.round(r.pnl * 100);
    if (Number.isFinite(r.t) && !exact.has(cents + '@' + r.t)) exact.set(cents + '@' + r.t, i);
    if (Number.isFinite(r.x) && !exact.has(cents + '@' + r.x)) exact.set(cents + '@' + r.x, i);
  });

  const claimed = new Set();

  return list.filter(t => {
    // Same guards writeLiveTradeToDayRecord applies — reporting a trade as
    // "missing" that it will then refuse to write would loop every poll.
    if (!t || t.pnlUnknown === true) return false;
    if (!Number.isFinite(t.pnl) || t.at == null) return false;

    // ── SIZE-0 FOLD ENTRIES ARE FRAGMENTS, NOT TRADES (2026-08-28) ────────
    // `size` here is sizeSeenThisTrade — the largest position the fold ever
    // OBSERVED open during the trade. Zero means every poll of that trade
    // either read flat or read a position whose quantity could not be parsed:
    // the fold saw a balance move but never saw a position behind it.
    //
    // Live on 2026-08-28: the fold held nine entries for about five real
    // trades, and every spurious one had size 0 —
    //   19:10:09 size 0 -$0.45 · 19:12:49 size 0 +$39.10 · 19:18:39 size 0
    //   -$13.00 · 19:30:48 size 0 -$11.45
    // — while the real trades were 3 lots (+$174.30), 2 lots (-$140.80) and
    // 1 lot (-$153.90), each already recorded from the ORDER WALK with fill
    // prices. The fragments were partial balance deltas of trades the walk had
    // already captured whole.
    //
    // They are excluded from being WRITTEN AS ROWS, not deleted: the fold's
    // dayPnl still sums every delta, so the day's P&L is unaffected. This only
    // stops a fragment from becoming a row that competes with the real one —
    // which is what made Protocol 2 clean the file and the self-heal refill it
    // on a loop.
    //
    // Safe direction: a size-0 entry can never be matched to a row by size, so
    // it could only ever be written as a NEW row — never merged. Suppressing
    // it therefore cannot lose a trade the walk recorded, and a trade the walk
    // did NOT record still arrives with a real observed size.
    // EXPLICITLY zero, not merely absent. `size: 0` means the fold ran and
    // observed no position; `size` missing means the field was never recorded
    // at all — an older state shape, or a caller that does not track it. Those
    // are different facts, and treating the second as the first would suppress
    // real trades whose size simply is not known. Production fold entries
    // always carry an explicit size, so the guard still catches every real
    // fragment.
    if (t.size != null && Math.abs(Number(t.size)) === 0) return false;

    const cents = Math.round(t.pnl * 100);
    for (const key of [cents + '@' + t.at,
                       Number.isFinite(t.entryAt) ? cents + '@' + t.entryAt : null]) {
      if (!key || !exact.has(key)) continue;
      const idx = exact.get(key);
      if (claimed.has(idx)) continue;      // that row is already spoken for
      claimed.add(idx);
      return false;
    }

    // Cross-route match: same size, same flat event, P&L equal or exactly
    // commission apart.
    const tSize = Math.abs(Number(t.size) || 0);
    const foldAt = Number(t.at);
    for (let i = 0; i < stored.length; i++) {
      if (claimed.has(i)) continue;
      const r = stored[i];
      const rSize = Math.abs(Number(r.size) || 0);
      const sizeExact = tSize && rSize && tSize === rSize;
      // G26: a size MISMATCH is not itself a refusal — the fold's size is
      // sizeSeenThisTrade (best-effort, can be a partial read of a larger CSV
      // fill). Only a size-0 (never observed) row is skipped here; the strong
      // samePrices identity below still fires at any size, and the weak P&L
      // match is gated on sizeExact further down.
      if (!tSize || !rSize) continue;

      const rExit = Number.isFinite(r.x) ? r.x : r.t;
      const rEntry = Number.isFinite(r.t) ? r.t : rExit;
      if (!Number.isFinite(rExit)) continue;
      // The fold notices flat AT or AFTER the exit. A small negative
      // tolerance absorbs clock skew between the two reads.
      const dt = foldAt - rExit;
      const inWindow = (dt >= -60000 && dt <= windowMs)
        || (Number.isFinite(t.entryAt) && Math.abs(Number(t.entryAt) - rEntry) <= windowMs);
      if (!inWindow) continue;

      // G26: same fill prices identify the same trade EVEN AT DIFFERENT SIZES —
      // the live fold's best-effort size can be a partial read of a larger CSV
      // fill. Only fires when both rows carry prices.
      const samePrices = t.entryPrice != null && t.exitPrice != null
        && Number(r.ep) === Number(t.entryPrice)
        && Number(r.xp) === Number(t.exitPrice);
      if (samePrices) { claimed.add(i); return false; }

      // Cross-route P&L match is the WEAK one — it still requires exact size,
      // because equal P&L across different sizes is the dangerous direction
      // (two genuine trades that happen to share a P&L).
      if (!sizeExact) continue;
      const samePnl = Math.abs(Number(r.pnl) - Number(t.pnl)) < 0.01;
      let commissionApart = false;
      if (commSide != null) {
        const expected = tSize * commSide * 2;
        // Either row may be the gross one, so compare the absolute gap.
        commissionApart = Math.abs(Math.abs(Number(r.pnl) - Number(t.pnl)) - expected) < 0.02;
      }
      if (samePnl || commissionApart) { claimed.add(i); return false; }
    }
    return true;
  });
}

// ── Merging a closed trade into the day's rows (2026-08-28) ────────────────
// writeLiveTradeToDayRecord deduped on `t|x|pnl-cents|size`. Putting P&L in a
// row's IDENTITY is the bug: P&L is a VALUE of a trade, and it is precisely
// the field the two routes disagree on. The walk route reports GROSS at the
// real fill times; the fold route reports NET minutes later. Same trade, two
// fingerprints, two rows.
//
// Identity is the flat event: when it opened, when it closed, how big it was.
// This matches on that, falls back to the same cross-route test
// missingFromDayRows uses, and MERGES rather than appending — so the surviving
// row keeps the walk's prices AND a single net P&L.
//
// Returns { rows, action } where action is 'inserted' | 'merged'.
function mergeTradeRow(existingRows, newRow, opts) {
  const o = opts || {};
  const commSide = Number.isFinite(o.commissionPerContractPerSide) ? o.commissionPerContractPerSide : null;
  const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : SELFHEAL_MATCH_WINDOW_MS;
  const rows = (Array.isArray(existingRows) ? existingRows : []).slice();
  if (!newRow) return { rows, action: 'skipped' };

  const nSize = Math.abs(Number(newRow.size) || 0);
  const nExit = Number.isFinite(newRow.x) ? newRow.x : newRow.t;
  const nEntry = Number.isFinite(newRow.t) ? newRow.t : nExit;

  let hit = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const rSize = Math.abs(Number(r.size) || 0);
    const sizeExact = nSize && rSize && nSize === rSize;
    // G26: a size mismatch is a refusal ONLY when both sides carry a VERIFIED
    // size. The live fold's sizeSeenThisTrade is best-effort — a partial read
    // of a larger CSV fill — so a best-effort size is a wildcard, the same rule
    // sizeIsBestEffort applies on the CSV-import side. A size-0 row (never
    // observed) is skipped exactly as before.
    const sizeWild = sizeIsBestEffort(newRow) || sizeIsBestEffort(r);
    if (!nSize || !rSize) continue;
    if (!sizeExact && !sizeWild) continue;
    const rExit = Number.isFinite(r.x) ? r.x : r.t;
    const rEntry = Number.isFinite(r.t) ? r.t : rExit;

    // Same flat event: identical stamps (the common case — a re-read of the
    // same walk trade), or the two routes' stamps a few minutes apart.
    const sameStamps = rEntry === nEntry && rExit === nExit;
    const nearby = Number.isFinite(rExit) && Number.isFinite(nExit)
      && Math.abs(nExit - rExit) <= windowMs;
    if (!sameStamps && !nearby) continue;

    if (sameStamps) { hit = i; break; }

    // SAME FILL PRICES = SAME TRADE. The strongest signal available, and
    // stronger than any P&L test: two rows quoting the same side, the same
    // entry and the same exit for the same size ARE the same trade, whatever
    // P&L each happens to be carrying. Added after the guard went in and the
    // store still held two rows for one trade — SHORT 29611 -> 29609.5 twice,
    // one stamped $0.00 and one $1.10, because the walk route writes a stale
    // P&L that is neither equal to nor commission-apart from the real one.
    // GUARDED: identical prices alone is not enough. Two genuinely separate
    // trades could share a size, an entry and an exit, and merging those would
    // LOSE one — the dangerous direction. So this only fires when at least one
    // of the two rows carries a P&L that CONTRADICTS ITS OWN PRICES, which is
    // the signature of the stale-P&L duplicate and cannot be true of a real,
    // self-consistent row. My own earlier test caught the unguarded version
    // merging two legitimate scale-outs.
    const samePrices = r.side && newRow.side
      && String(r.side).toUpperCase() === String(newRow.side).toUpperCase()
      && Number(r.ep) === Number(newRow.ep)
      && Number(r.xp) === Number(newRow.xp);
    // G26: when one side's size is best-effort, identical fill prices ARE the
    // same trade — the size mismatch is a partial read, not a second trade.
    // (The stale-P&L guard below is for the SAME-size case and cannot apply
    // across sizes.)
    if (samePrices && sizeWild) { hit = i; break; }
    if (samePrices && commSide != null) {
      const pv = Number.isFinite(o.pointValue) ? o.pointValue : 2;
      const dir = String(r.side).toUpperCase() === 'LONG' ? 1 : -1;
      const expectedNet = Math.round(((Number(r.xp) - Number(r.ep)) * dir * nSize * pv - nSize * commSide * 2) * 100) / 100;
      const aStale = Math.abs(Number(r.pnl) - expectedNet) > 0.02;
      const bStale = Math.abs(Number(newRow.pnl) - expectedNet) > 0.02;
      // Both self-consistent => two real trades that happen to look alike.
      if (aStale || bStale) { hit = i; break; }
    }

    // Cross-route: P&L equal, or exactly size x round-turn commission apart.
    // G26: this WEAK match is the only one that still requires exact size —
    // equal P&L across different sizes is the dangerous direction (two genuine
    // trades that happen to share a P&L), so a size mismatch falls through here
    // and inserts rather than merging.
    if (!sizeExact) continue;
    const gap = Math.abs(Number(r.pnl) - Number(newRow.pnl));
    const samePnl = gap < 0.01;
    const commissionApart = commSide != null && Math.abs(gap - nSize * commSide * 2) < 0.02;
    if (samePnl || commissionApart) { hit = i; break; }
  }

  if (hit < 0) { rows.push(newRow); return { rows, action: 'inserted' }; }

  // MERGE. Prices and real fill stamps come from whichever row has them; the
  // surviving P&L is the NET one. When one side is gross and the other net,
  // the smaller magnitude in the profitable direction is the net figure —
  // derived explicitly from the commission rather than guessed.
  const a = rows[hit], b = newRow;
  const withPrices = (b.ep != null && b.xp != null) ? b : ((a.ep != null && a.xp != null) ? a : null);
  let pnl = Number.isFinite(b.pnl) ? b.pnl : a.pnl;
  if (commSide != null && Number.isFinite(a.pnl) && Number.isFinite(b.pnl)) {
    const gap = Math.abs(a.pnl - b.pnl);
    if (Math.abs(gap - nSize * commSide * 2) < 0.02) {
      // One is gross, one is net. Net is the one closer to zero from above:
      // net = gross - commission, so net < gross always.
      pnl = Math.min(a.pnl, b.pnl);
    }
  }
  // A row that knows its own fill prices should not carry a P&L that
  // contradicts them. Recompute gross from the prices and net it — the same
  // rule the 2026-08-28 migration applied to history, so live rows and
  // migrated rows are produced by identical arithmetic. Falls back to the
  // chosen pnl when prices are absent.
  const mEp = withPrices ? Number(withPrices.ep) : NaN;
  const mXp = withPrices ? Number(withPrices.xp) : NaN;
  const mSide = String((withPrices && withPrices.side) || b.side || a.side || '').toUpperCase();
  if (commSide != null && Number.isFinite(mEp) && Number.isFinite(mXp) && nSize && (mSide === 'LONG' || mSide === 'SHORT')) {
    const dir = mSide === 'LONG' ? 1 : -1;
    const gross = (mXp - mEp) * dir * nSize * (Number.isFinite(o.pointValue) ? o.pointValue : 2);
    pnl = Math.round((gross - nSize * commSide * 2) * 100) / 100;
  }

  rows[hit] = Object.assign({}, a, b, {
    pnl,
    side: (withPrices && withPrices.side) || b.side || a.side || null,
    ep: withPrices ? withPrices.ep : (b.ep != null ? b.ep : a.ep),
    xp: withPrices ? withPrices.xp : (b.xp != null ? b.xp : a.xp),
    t: withPrices ? withPrices.t : a.t,
    x: withPrices ? withPrices.x : a.x,
    hold: (withPrices && withPrices.hold != null) ? withPrices.hold : (a.hold != null ? a.hold : b.hold),
  });
  return { rows, action: 'merged' };
}

function enrichRowsFromWalk(rows, walkClosed, opts) {
  const o = opts || {};
  const tol = Number.isFinite(o.toleranceMs) ? o.toleranceMs : ENRICH_EXIT_TOLERANCE_MS;
  if (!Array.isArray(rows) || !Array.isArray(walkClosed) || !rows.length || !walkClosed.length) {
    return { rows: Array.isArray(rows) ? rows : [], filled: 0, ambiguous: 0 };
  }
  const usable = walkClosed.filter(rt => rt && Number.isFinite(rt.exitAt)
    && (rt.side === 'buy' || rt.side === 'sell'));
  const claimed = new Set();
  let filled = 0, ambiguous = 0;

  const out = rows.map(row => {
    // Only rows that are actually missing direction. A row that already knows
    // its side (a CSV import, or a post-fix live row) is never second-guessed.
    if (!row || row.side) return row;
    const exit = Number.isFinite(row.x) ? row.x : row.t;
    if (!Number.isFinite(exit)) return row;

    const near = usable
      .map((rt, i) => ({ rt, i, d: Math.abs(rt.exitAt - exit) }))
      .filter(c => c.d <= tol)
      // A size that is known on both sides and disagrees is a different trade.
      // Size 0 on the stored row means "not observed", so it excludes nothing.
      .filter(c => !(Number(row.size) > 0 && Number(c.rt.size) > 0 && Number(row.size) !== Number(c.rt.size)))
      .filter(c => !claimed.has(c.i))
      .sort((a, b) => a.d - b.d);

    if (!near.length) return row;
    // Two candidates equally close in time is genuinely ambiguous. Only a
    // clear winner is accepted; ties are reported and skipped.
    if (near.length > 1 && near[1].d === near[0].d) { ambiguous++; return row; }

    const rt = near[0].rt;
    claimed.add(near[0].i);
    filled++;
    const side = rt.side === 'buy' ? 'LONG' : 'SHORT';
    const next = Object.assign({}, row, { side: side });
    if (Number.isFinite(rt.entryPrice) && row.ep == null) next.ep = rt.entryPrice;
    if (Number.isFinite(rt.exitPrice) && row.xp == null) next.xp = rt.exitPrice;
    if (next.ep != null && next.xp != null && row.mp == null) {
      // A short profits when price falls, so its move is entry - exit. Same
      // sign convention as csvApply's mp and server.js's dirSign.
      next.mp = Math.round((side === 'LONG' ? next.xp - next.ep : next.ep - next.xp) * 100) / 100;
    }
    if (!(Number(next.size) > 0) && Number(rt.size) > 0) next.size = rt.size;
    if (!(Number(next.hold) > 0) && Number.isFinite(rt.entryAt) && Number.isFinite(rt.exitAt)
        && rt.exitAt >= rt.entryAt) {
      next.hold = Math.round((rt.exitAt - rt.entryAt) / 1000);
    }
    return next;
  });

  return { rows: out, filled, ambiguous };
}

function analyzeOrderWalk(orders, dayKeyMs, openingBySymbol) {
  const empty = { closed: [], netBySymbol: {}, droppedRows: 0 };
  if (!Array.isArray(orders) || dayKeyMs == null) return empty;
  const opening = openingBySymbol && typeof openingBySymbol === 'object' ? openingBySymbol : null;
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
    // 2026-09-02: the walk starts each symbol at 0 because the window starts at
    // midnight IST — which silently ASSERTS the account was flat at midnight.
    // A position carried across that boundary makes the assertion false and the
    // walk runs permanently offset, so it never returns to zero and every later
    // round trip in that symbol is refused. See reconcileOpeningPositions.
    const st = bySymbol[o.symbol]
      || (bySymbol[o.symbol] = {
        qty: (opening && Number.isFinite(opening[o.symbol])) ? opening[o.symbol] : 0,
        entry: null, peakQty: 0,
        // 2026-09-03: volume-weighted price accumulators. See the block above
        // the closed.push below for why a single fill's price is not the
        // trade's price.
        entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0
      });
    const before = st.qty;
    const delta = (o.side === 'buy' ? o.qty : -o.qty);
    const after = before + delta;
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
      st.entryQty = o.qty;
      st.entryNotional = o.price * o.qty;
      st.exitQty = 0;
      st.exitNotional = 0;
    } else if (!crossed) {
      st.peakQty = Math.max(st.peakQty, Math.abs(after));
      // A fill that moves the position further from flat is part of the ENTRY;
      // one that moves it toward flat is part of the EXIT. Before 2026-09-03
      // neither was accumulated and a partial exit simply vanished.
      if (Math.sign(delta) === Math.sign(before)) {
        st.entryQty += o.qty;
        st.entryNotional += o.price * o.qty;
      } else {
        st.exitQty += o.qty;
        st.exitNotional += o.price * o.qty;
      }
    }
    if (crossed && st.entry) {
      // ── VOLUME-WEIGHTED PRICES (2026-09-03) ──────────────────────────────
      // This walk only emits on a return to (or through) flat, so a round trip
      // can be built from many fills. entryPrice used to be the FIRST fill's
      // price and exitPrice the LAST fill's price — each one fill out of
      // however many, with the trade's full `size` attached to it.
      //
      // Caught live on 2026-09-03 against Anoop's own Tradovate statement.
      // A 4-lot long entered at 29283 was exited in two 2-lot fills, 29280.75
      // then 29283.75. The walk reported "4 lots, 29283 -> 29283.75", implying
      // +$6.00 gross; the real gross was -$6.00. That row then fed
      // mergeTradeRow, whose "a row must not contradict its own prices" repair
      // recomputed P&L FROM those prices and overwrote the balance-derived
      // -$13.60 with -$1.60 on every poll. missingFromDayRows compares P&L, saw
      // a $12.00 gap where only a $7.60 commission gap is tolerated, and
      // declared the trade missing again — 683 times in one afternoon, each
      // one re-writing the wrong number. The day P&L stayed wrong the whole
      // time and nothing could converge, because the price it was all derived
      // from was never the trade's price.
      //
      // The size fix for exactly these shapes went in on 2026-08-21 (st.peakQty
      // — see the note above); the PRICE half of the same bug was missed.
      //
      // On a reversal only the part of this fill that closes the old leg
      // belongs to this exit; the residual opens the next leg and is credited
      // to it below.
      const closingQty = Math.min(o.qty, Math.abs(before));
      const exitQty = st.exitQty + closingQty;
      const exitNotional = st.exitNotional + o.price * closingQty;
      // Round only to kill float noise. NOT to a tick: a genuine VWAP of an
      // uneven split legitimately falls between ticks, and snapping it would
      // put the error straight back.
      const vwap = (notional, qty, fallback) =>
        (qty > 0 ? Math.round((notional / qty) * 1e6) / 1e6 : fallback);
      closed.push({
        symbol: o.symbol,
        side: st.entry.side,
        size: st.peakQty,
        entryPrice: vwap(st.entryNotional, st.entryQty, st.entry.price),
        exitPrice: vwap(exitNotional, exitQty, o.price),
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
      // The residual is the new leg's opening fill, at this fill's price.
      st.entryQty = after === 0 ? 0 : Math.abs(after);
      st.entryNotional = after === 0 ? 0 : o.price * Math.abs(after);
      st.exitQty = 0;
      st.exitNotional = 0;
    }
    st.qty = after;
  }

  const netBySymbol = {};
  for (const [symbol, st] of Object.entries(bySymbol)) {
    if (st.qty !== 0) netBySymbol[symbol] = st.qty;
  }
  return { closed, netBySymbol, droppedRows };
}

/**
 * ── WHAT POSITION DID THE DAY OPEN WITH? (2026-09-02) ──────────────────────
 *
 * analyzeOrderWalk starts every symbol at zero because its window starts at
 * midnight IST. That is not a neutral default — it ASSERTS the account was flat
 * at midnight. When a position was carried across that boundary the assertion is
 * false, the walk runs permanently offset, its net never returns to zero, and
 * isWalkDesynced then correctly refuses it. Correctly, but expensively: ONE
 * unmatched contract disables the walk for EVERY symbol, which is how a single
 * stray lot took down trade counts, exit prices and trade direction for a whole
 * session.
 *
 * Live on 2026-09-02: `WALK NET: MNQU6 -1 | PANEL: (panel shows flat)` — the walk
 * booked one more sell than buy across 44 order rows and 11 round trips.
 *
 * THE INFERENCE. The positions panel is ground truth for what is open RIGHT NOW.
 * The walk's residual is what it believes is open. The difference between them is
 * exactly the position the walk never saw opened — i.e. what the day opened with.
 * So: opening = panelNow - walkResidual, per symbol.
 *
 * ── WHY THIS IS NOT JUST PAPERING OVER A DATA GAP ──────────────────────────
 * A residual has two possible causes and this only legitimately fixes one:
 *   (a) a position carried across midnight IST — the opening offset is REAL and
 *       recovering it is simply correct;
 *   (b) a fill row that has scrolled out of the Orders table — the offset is a
 *       missing row, and seeding it hides a genuine gap.
 * They are indistinguishable from the table alone. So this deliberately does NOT
 * claim verification: it returns the offsets AND `assumed: true`, the caller
 * re-walks and must confirm the result actually reconciles, and the recovered
 * count is reported as recovered rather than as walked-and-proven.
 *
 * BOUNDED ON PURPOSE. A large residual is far more likely to be a broken read
 * than an overnight hold, and seeding a large offset would manufacture round
 * trips wholesale. Above `maxOffset` it refuses and leaves the existing desync
 * refusal in place — the safe direction, and the one this codebase already takes
 * everywhere it cannot prove a number.
 *
 * PURE. Unit-tested in test/tv-broker-feed.test.js.
 */
function reconcileOpeningPositions(netBySymbol, positionRows, opts) {
  const maxOffset = (opts && Number.isFinite(opts.maxOffset)) ? opts.maxOffset : 5;
  const panel = {};
  if (Array.isArray(positionRows)) {
    for (const p of positionRows) {
      if (!p || typeof p !== 'object') continue;
      const sym = String(p.Symbol || '').trim();
      if (!sym) continue;
      const q = Number(String(p.Qty == null ? '' : p.Qty).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(q) || q === 0) continue;
      // The panel reports size and side separately; the walk speaks signed.
      const short = /sell|short/i.test(String(p.Side || ''));
      panel[sym] = short ? -Math.abs(q) : Math.abs(q);
    }
  }
  const walk = netBySymbol || {};
  const symbols = new Set([...Object.keys(walk), ...Object.keys(panel)]);
  const offsets = {};
  let any = false;
  for (const sym of symbols) {
    const w = Number.isFinite(walk[sym]) ? walk[sym] : 0;
    const p = Number.isFinite(panel[sym]) ? panel[sym] : 0;
    const off = p - w;
    if (off === 0) continue;
    if (Math.abs(off) > maxOffset) {
      return { ok: false, offsets: null, assumed: true,
        reason: 'residual of ' + off + ' on ' + sym + ' exceeds the ' + maxOffset
          + '-lot ceiling — far likelier a broken order-table read than an overnight hold, so the walk stays refused.' };
    }
    offsets[sym] = off;
    any = true;
  }
  if (!any) return { ok: false, offsets: null, assumed: false, reason: 'walk already agrees with the panel — nothing to reconcile.' };
  return { ok: true, offsets, assumed: true,
    reason: 'inferred the position each symbol opened the IST day with: '
      + Object.entries(offsets).map(e => e[0] + ' ' + (e[1] > 0 ? '+' : '') + e[1]).join(', ') };
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

module.exports = {
  SELFHEAL_MATCH_WINDOW_MS,
  mergeTradeRow, fold, freshState, walkDetailFor, applyWalkDetail, enrichRowsFromWalk, missingFromDayRows, ENRICH_EXIT_TOLERANCE_MS, parseBalance, istDayStartMs, reconstructClosedTradesFromOrders, analyzeOrderWalk, isWalkDesynced, parseISTTimestamp, isFilledOrderRow, isStateSchemaStale, STATE_SCHEMA_VERSION, expectedPnlFromFills, pointValueFor, contractRoot };

// ── The broker's OWN P&L figures (2026-08-24) ───────────────────────────────
// WHY THIS EXISTS — the bug it fixes, in Anoop's own numbers. On 2026-08-24
// the broker's Accounts panel read DOLLAR TOTAL P L = +$399.70, flat, open
// P&L $0.00. sessions/Now.md, driven by fold()'s dayPnl, read -$154.20. A
// $553.90 gap, on the first day the rest of the live surface actually worked,
// and he sized his next trade off the wrong one.
//
// The gap is not a rounding or a fee problem — it is STRUCTURAL to the
// balance-delta method, in two independent ways:
//
//   1. THE ANCHOR IS THE FIRST POLL, NOT THE SESSION START. fold() sets
//      balanceAtLastFlat on the first readable poll of the day and can only
//      ever report the delta from THAT moment. Every round trip that closed
//      before this server instance started polling (or while the panel was
//      unreadable) is outside the window by construction. The order-history
//      backfill recovers the COUNT of those trades but deliberately never
//      their $ P&L. So "Day P&L" was really "P&L since the app happened to
//      start", displayed under a label that claims otherwise.
//   2. THE RE-ANCHOR BRANCH DISCARDS DELTAS. When balance moves while flat
//      with no corroborating fill, fold() silently re-anchors and drops that
//      delta on the floor (correctly — see that branch's 2026-08-19 comment
//      about balance drift fabricating 20 trades). Each drop is permanent and
//      one-directional, so dayPnl walks away from the truth over a session.
//
// Neither is fixable inside the fold, because the information simply is not
// in the balance series. It IS, however, sitting in the DOM already:
// tradingview-mcp's getAccountSummary() reads
// table[data-name="TRADOVATE.summary.accountSummary-table"] into
// `summary.detail` — with "Total P/L" and "Open P/L" columns — and app code
// has been throwing that object away since it was written, using only
// summary.header.balance.
//
// CONFIRMED AGAINST TRADOVATE'S OWN DOCS (support.tradovate.com, "Accounts
// Module - Tradovate Web" and "Positions Module - Tradovate Web", read
// 2026-08-24):
//   Dollar Total P&L  "Combined realized and unrealized P&L for the current session."
//   Dollar Open P&L   "Profit and loss from currently open positions."
//   Realized P/L      "Realized profit or loss from closed trades during the current session."
// So Total minus Open is realized-this-session, and Total is the number the
// prop firm's own drawdown / auto-liq distance is computed from. That makes
// Total the correct input to the loss tiers, not merely a prettier display:
// it moves tick-by-tick with an OPEN position, which is precisely the "lag"
// being reported — fold()'s dayPnl cannot move until the position returns to
// flat, so a trade running -$300 against him showed as no change at all.
//
// SESSION BOUNDARY, stated rather than glossed: these are the BROKER's
// session (CME, 17:00 CT rollover), not this codebase's IST midnight day key.
// For Anoop's actual trading window (~17:00-21:00 IST) both boundaries fall
// far outside it, so they agree in practice — and where they disagree, the
// broker's is the one the daily-loss-limit is actually enforced on, which is
// the boundary a guardrail should be measuring against anyway.
//
// Returns nulls rather than throwing or guessing: an unreadable summary must
// degrade to the fold, never to a fabricated number.
function readBrokerPnl(summary) {
  const detail = summary && summary.detail;
  if (!detail || typeof detail !== 'object') {
    return { totalPnl: null, openPnl: null, realizedPnl: null, readable: false };
  }
  // Match each column by NORMALIZED name rather than an exact literal: the
  // panel has shipped both "Total P/L" and "Total P&L" wording across the
  // Tradovate web app and TradingView's broker integration, and a header
  // rename must degrade to the fold, not silently read as zero.
  const pick = (...wants) => {
    for (const [k, v] of Object.entries(detail)) {
      const norm = String(k).toLowerCase().replace(/[^a-z]/g, '');
      if (wants.includes(norm)) {
        const n = parseBalance(typeof v === 'string' ? v : String(v == null ? '' : v));
        if (n !== null) return n;
      }
    }
    return null;
  };
  const totalPnl = pick('totalpl', 'dollartotalpl', 'totalpandl');
  const openPnl = pick('openpl', 'dollaropenpl', 'openpandl');
  // 2026-08-24 (Anoop, same session): the BALANCE was wrong too, and for the
  // same reason — it came from the account-header strip, not from this table.
  // Read live while flat, the header strip said 51,219.30 for both Balance
  // and Equity while this table's Net Liq said 51,211.50, and the broker's
  // own EQUITY column said 51,211.50. The header strip is the one that
  // drifts (see fold()'s 2026-08-19 comment: it moved four times in 12
  // seconds with no position open, while Equity stayed constant). Net Liq is
  // what the account panel shows him and what the prop firm's drawdown and
  // auto-liq distances are computed against, so it is what we display.
  const netLiq = pick('netliq', 'netliquidation', 'netliqvalue');
  // 2026-08-24, CORRECTION to the note above — found the same evening against
  // the broker's own Performance export. The header strip is NOT the
  // unreliable one; the SUMMARY TABLE is the one that freezes. Two readings 70
  // minutes apart returned Total P/L 399.70 and Net Liq 51,211.50 to the cent
  // while the header balance moved 51,219.30 -> 51,270.90 and real trading
  // happened in between. The header figure reconciles EXACTLY with Tradovate's
  // own 6-day export across 239 contracts at 0.95/side; the summary table was
  // $59.40 behind. So the header is live and the table lags.
  //
  // We cannot tell staleness from the table alone — a frozen value re-reads
  // as a perfectly fresh-looking number every poll, which is why the age guard
  // in effectiveDayPnl() is not sufficient on its own. But the two figures
  // describe the same account, so when they disagree by more than rounding,
  // the lagging one is provably stale. That disagreement is the detector.
  const headerBalance = summary && summary.header ? parseBalance(summary.header.balance) : null;
  const stale = headerBalance !== null && netLiq !== null && Math.abs(headerBalance - netLiq) > 1;
  return {
    totalPnl,
    openPnl,
    netLiq,
    headerBalance,
    stale,
    // Realized is DERIVED, never picked from a third column, so it can never
    // disagree with the two numbers shown beside it.
    realizedPnl: (totalPnl !== null && openPnl !== null) ? totalPnl - openPnl : null,
    readable: totalPnl !== null,
  };
}

// How stale a broker P&L reading may be before we stop trusting it. The poll
// runs every 10s (server.js's TV_BROKER_POLL_MS); three missed polls means the
// panel has gone quiet and the number is no longer "live" in any sense a
// person would accept while deciding size.
const BROKER_PNL_MAX_AGE_MS = 35000;

/**
 * The day P&L the app should DISPLAY and ENFORCE ON, and where it came from.
 *
 * Precedence is deliberate and one-way: the broker's own figure wins whenever
 * it is fresh and readable, because it is the account's actual state rather
 * than a reconstruction of it. The fold is the FALLBACK, not a peer — a
 * silent alternation between two sources that disagree by hundreds of dollars
 * is the failure being fixed here, so `source` travels with the number
 * everywhere and callers are expected to show it.
 *
 * `drift` is the fold's disagreement with the broker's realized figure when
 * both exist. Diagnostic, never enforcement: a large drift means the fold has
 * a gap (a pre-poll trade, a discarded re-anchor) — which no longer affects
 * the headline number, but is worth seeing rather than burying.
 */
function effectiveDayPnl(state, nowMs) {
  const st = state || {};
  const at = typeof st.brokerPnlAt === 'number' ? st.brokerPnlAt : null;
  const fresh = at !== null && typeof nowMs === 'number' ? (nowMs - at) <= BROKER_PNL_MAX_AGE_MS : false;
  const total = typeof st.brokerTotalPnl === 'number' ? st.brokerTotalPnl : null;
  const open = typeof st.brokerOpenPnl === 'number' ? st.brokerOpenPnl : null;
  const foldValue = typeof st.dayPnl === 'number' ? st.dayPnl : null;
  const realized = (total !== null && open !== null) ? total - open : null;
  if (total !== null && fresh) {
    return {
      value: total,
      source: 'broker',
      realized,
      open,
      foldValue,
      drift: (realized !== null && foldValue !== null) ? foldValue - realized : null,
      // Not "did we read it recently" (we always do) but "has the table
      // fallen behind the account it describes" — see readBrokerPnl.
      stale: st.brokerSummaryStale === true,
      // How far behind, in dollars, when we can tell. This is the amount the
      // displayed day P&L is understating by.
      staleBy: (st.brokerSummaryStale === true && typeof st.brokerHeaderBalance === 'number' && typeof st.brokerNetLiq === 'number')
        ? st.brokerHeaderBalance - st.brokerNetLiq : null,
    };
  }
  return {
    value: foldValue,
    source: 'fold',
    realized: foldValue,
    open: null,
    foldValue,
    drift: null,
    // Distinguishes "the broker figure went stale" from "we never had one":
    // the first is a feed problem worth surfacing, the second is just startup.
    stale: total !== null && !fresh,
  };
}

/**
 * The trade count the app should DISPLAY and ENFORCE ON.
 *
 * WHY THIS IS NOT state.tradeCount — 2026-08-24, same incident as
 * readBrokerPnl above. The persisted state read tradeCount 15 while
 * closedRoundTripsScored (the broker's own order-history round-trip walk)
 * read 7, and Now.md showed "15 / 5" — over the daily cap, on 7 real trades.
 * Of the 15 recorded, exactly 8 carried evidence:'degraded', meaning they
 * were scored by the fill-EDGE branch alone. That branch cannot tell an entry
 * fill from an exit fill; it is the same rule that produced the "9/3 — DONE"
 * lockout on 2026-08-20, still reachable whenever the order walk is dark or
 * desynced (which it evidently was for much of 2026-08-24).
 *
 * So: count the CORROBORATED trades — every one scored by an observed flat
 * transition or by the round-trip walk advancing — and take the higher of
 * that and the walk's own count. The max() is what keeps this from failing in
 * the permissive direction: if the walk went dark while a genuine trade
 * closed, the corroborated tally still carries it; if the fold missed a close
 * the walk saw, the walk's number wins.
 */
function effectiveTradeCount(state) {
  const st = state || {};
  const trades = Array.isArray(st.trades) ? st.trades : [];
  const corroborated = trades.filter(t => !(t && t.evidence === 'degraded')).length;
  const walk = Number.isFinite(st.closedRoundTripsScored) ? st.closedRoundTripsScored : 0;
  const degraded = trades.length - corroborated;
  // ── IS THE WALK HALF OF THIS max() STILL CURRENT? (2026-09-02) ───────────
  // closedRoundTripsScored is NOT cleared when the walk goes dark — by design,
  // because clearing it would make every round trip already completed today
  // look new. The cost is that the last figure the walk ever produced keeps
  // winning the max() indefinitely once the walk desyncs.
  //
  // Live today: walk 11, corroborated 5, and the UI hard-locked at "10 trades
  // — cap 10. Done." while the SAME walk was being refused for round-trip
  // counting, for trade direction, and for exit prices on every poll. The
  // number the cap enforced on was the one piece of that walk nothing had
  // marked as untrusted.
  //
  // The value is deliberately UNCHANGED — this does not quietly lower his
  // count, which would fail in the permissive direction on a live-money
  // account. It reports that the walk figure is stale so the caller can
  // present the count as provisional instead of final. Same doctrine as
  // week-rollup's disagreeDays: surface the disagreement, never silently pick.
  const walkStale = st.walkTrusted === false && walk > corroborated;
  return {
    value: Math.max(corroborated, walk),
    rawFoldCount: typeof st.tradeCount === 'number' ? st.tradeCount : trades.length,
    degraded,
    corroborated,
    walkCount: walk,
    walkStale,
    // 'verified' only when nothing rests on the fill edge. Callers keep
    // treating a degraded count as advisory rather than a hard lock — this
    // removes the phantom trades from the number, it does not claim the
    // remainder is beyond doubt.
    // A stale walk figure is degraded evidence for the same reason: the number
    // it is carrying was true of a walk the app no longer trusts.
    evidence: (degraded > 0 || walkStale) ? 'degraded' : 'verified',
  };
}

module.exports.readBrokerPnl = readBrokerPnl;
module.exports.effectiveDayPnl = effectiveDayPnl;
module.exports.effectiveTradeCount = effectiveTradeCount;
module.exports.reconcileOpeningPositions = reconcileOpeningPositions;
module.exports.BROKER_PNL_MAX_AGE_MS = BROKER_PNL_MAX_AGE_MS;
