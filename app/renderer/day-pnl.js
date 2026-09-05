// ── Today's P&L — ONE decision, two surfaces (2026-09-04) ────────────────────
// Anoop, looking at his own running app: the left panel's Today row read
// "+$127" while the HUD two inches below it read "Day -$2,308". Same day, same
// account, same screen.
//
// WHY THEY DIVERGED — it was not a rounding or a refresh bug:
//
//   The HUD (grRender):     live.connected ? live.dayPnl : sum(manual trades)
//   The panel (enforceAccountInvariant):
//                           if (live.connected && NO ledger entry for today)
//                               acc.profit = live.dayPnl
//                           else if (no ledger days at all) acc.profit = 0
//                           else                            ...nothing.
//
// That last branch is the bug. Once today HAS a ledger entry — a CSV upload, or
// a day rollup writing one — the panel stopped assigning acc.profit entirely
// and kept whatever stale value was already sitting in it (from the persisted
// `profit` config key, or accumulated by hand through handleTradeLogged). The
// live feed kept moving; the panel did not.
//
// THIS IS NOT COSMETIC. acc.profit is read by computeMechanicalGoNogo() for
// `dayStopHit` and by getSizeFromProfit() for the size ladder. A stale +$127 on
// a -$2,308 day means the mechanical day-stop gate was evaluating a number that
// had no relationship to the account — it could not fire, and the size ladder
// was sizing off a profit that did not exist.
//
// PRECEDENCE, and why:
//   1. LIVE — the broker feed is the account. When it is connected its dayPnl
//      wins outright. This is the tier both surfaces already agreed on.
//   2. LEDGER — today's CSV/rollup net. Reached only when the feed is down.
//      This tier is NEW to the HUD, and it is a deliberate improvement: the
//      HUD's own 2026-08-11 comment records reading "Day -$637" while the
//      broker CSV said -$855.50, because the fallback is a sum of trades typed
//      in by hand and two of six were never logged. A CSV-confirmed figure is
//      strictly better evidence than that sum, so it goes first.
//   3. MANUAL — the sum of hand-logged trades. Last, and labelled unverified,
//      exactly as the HUD already labelled it.
//   4. Nothing at all → 0, source 'none'.
//
// WHAT THIS FUNCTION DOES NOT DO: it does not decide whether the day is
// STOPPED. That check stays on the live feed alone in grRender, because
// auto-stopping a trading day off a hand-typed number is a different risk from
// displaying one. Enforcement precedence is not display precedence.
//
// Pure and side-effect-free so both callers and the tests share one copy.

function dayPnl(input) {
  var i = input || {};
  var live = i.live;

  if (live && live.connected && Number.isFinite(live.dayPnl)) {
    return { value: live.dayPnl, source: 'live', verified: true };
  }
  if (Number.isFinite(i.ledgerToday)) {
    return { value: i.ledgerToday, source: 'ledger', verified: true };
  }
  var trades = Array.isArray(i.trades) ? i.trades : null;
  if (trades && trades.length) {
    var sum = 0;
    for (var n = 0; n < trades.length; n++) {
      var p = trades[n] && trades[n].pnl;
      if (Number.isFinite(p)) sum += p;
    }
    return { value: sum, source: 'manual', verified: false };
  }
  // No feed, no ledger entry, nothing logged. Zero is the honest answer — but
  // it is reported as 'none', not as a verified zero, so a caller can tell
  // "flat" apart from "we have no idea".
  return { value: 0, source: 'none', verified: false };
}

// The suffix the HUD prints after the number. Kept here so the panel and the
// HUD cannot drift on what they call the same source.
function dayPnlSourceTag(source) {
  if (source === 'manual') return ' · manual — unverified';
  if (source === 'ledger') return ' · from CSV';
  return '';
}

// ── The same split, for the rest of the Today block (2026-09-04) ────────────
// Anoop, on the redesigned panel: "not just P/L all the other details are
// empty" — Trades read 0 and Break read "—" while the HUD underneath read
// 6 trades and a live cooldown.
//
// Identical cause to the P&L one, one layer wider: acc.tradeCount and
// acc.lastTradeTime were only ever written by handleTradeLogged — the manual
// "Log trade" path. Nothing in the live-feed path touched them. So on a
// live-fed session the panel showed the numbers of the trades he typed in by
// hand, which is none of them.
//
// AND AGAIN THIS IS AN ENFORCEMENT BUG, not a display one: acc.tradeCount is
// what computeMechanicalGoNogo() tests for `overTradeLimit`, so the trade-count
// gate was reading 0 all day and could never fire.
function dayCounts(input) {
  var i = input || {};
  var live = i.live;
  if (live && live.connected) {
    return {
      trades: Number.isFinite(live.tradeCount) ? live.tradeCount : 0,
      maxSize: Number.isFinite(live.maxSize) ? live.maxSize : 0,
      source: 'live'
    };
  }
  var trades = Array.isArray(i.trades) ? i.trades : [];
  var maxSize = 0;
  for (var n = 0; n < trades.length; n++) {
    var sz = trades[n] && trades[n].size;
    if (Number.isFinite(sz) && sz > maxSize) maxSize = sz;
  }
  return { trades: trades.length, maxSize: maxSize, source: trades.length ? 'manual' : 'none' };
}

// Milliseconds left on the mandatory post-trade break.
//
// The live feed does not report "you took a trade at T" — it reports a loss
// timestamp, which the guardrail turns into cooldownUntil. So the live break
// IS the guardrail cooldown; the manual path still has a real lastTradeTime.
// Whichever ends LATER wins, so a manual log during a live session cannot
// shorten a cooldown that is already running.
function breakRemainingMs(input) {
  var i = input || {};
  var now = Number.isFinite(i.now) ? i.now : Date.now();
  var ms = Number.isFinite(i.cooldownMs) ? i.cooldownMs : 15 * 60 * 1000;
  var ends = 0;
  if (Number.isFinite(i.cooldownUntil)) ends = Math.max(ends, i.cooldownUntil);
  if (Number.isFinite(i.lastTradeTime)) ends = Math.max(ends, i.lastTradeTime + ms);
  return ends > now ? ends - now : 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dayPnl: dayPnl, dayPnlSourceTag: dayPnlSourceTag, dayCounts: dayCounts, breakRemainingMs: breakRemainingMs };
}
if (typeof window !== 'undefined') {
  window.DayPnl = { dayPnl: dayPnl, dayPnlSourceTag: dayPnlSourceTag, dayCounts: dayCounts, breakRemainingMs: breakRemainingMs };
}
