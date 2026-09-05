// today-status.js — "what is true about TODAY" for the coaching context.
//
// WHY THIS EXISTS (2026-09-03)
// ---------------------------------------------------------------------------
// server.js's jessiAppGetData('status') used to compute today's trade count as
// `gr_history.slice(-1)[0].n` — the newest rolled-up day row. gr_history only
// gains a row when a day is ROLLED UP at End Day, so on any fresh morning the
// newest row is YESTERDAY, and the coach was handed yesterday's trade count
// labelled "trades today".
//
// It fired live on 2026-09-03 at 13:06 IST, before Anoop had placed a single
// trade: the pre-session check returned NO-GO — "You have already placed 6
// trades today. The session cap is 5. You are OVER your session cap already" —
// and instructed him to stop trading and run the reset protocol. The 6 trades
// and $747.7 were 2026-09-02's row. Balance, caps and loss tiers in the same
// reply were all correct, which is precisely what made the wrong number
// credible. Neither the system clock nor tradingDayStampIST was involved.
//
// The rule this module enforces, and the reason it is a separate unit-tested
// file rather than five lines inline: a row belonging to another day must
// NEVER be presented as today. Every fallback below is keyed to todayKey, and
// there is deliberately no path that can reach into a neighbouring day when
// today has no data — "no data for today" is a real, reportable answer and is
// strictly better than a confident wrong one.
//
// `todayKey` is a TRADING-day stamp (server.js tradingDayStampIST — 03:45 IST
// Globex rollover), not a calendar date. Callers must pass it in; this module
// never reads the clock, which is what makes it testable.

'use strict';

/**
 * @param {object} o
 * @param {Array}  o.grHistory     rolled-up day rows: [{date, n, pnl, disc, ...}]
 * @param {object} o.dayTrades     per-trade rows keyed by trading day: {"YYYY-MM-DD": [...]}
 * @param {number} o.accTradeCount the client's live counter for today (may be null)
 * @param {string} o.todayKey      today's TRADING-day stamp
 * @returns {{todayKey:string, n:number, source:string, hasTodayData:boolean,
 *            today:(object|null), prevDay:(object|null)}}
 */
function resolveTodayStatus(o) {
  const opts = o || {};
  const todayKey = opts.todayKey || null;
  const grAll = Array.isArray(opts.grHistory) ? opts.grHistory : [];
  const dt = (opts.dayTrades && typeof opts.dayTrades === 'object') ? opts.dayTrades : {};

  // Rows are appended in date order, but a re-roll can append a second row for
  // the same day — take the LAST match for today, not the first.
  const today = grAll.filter(d => d && d.date === todayKey).slice(-1)[0] || null;

  // Strictly BEFORE today. `<` and not `!==`: a future-dated row (clock skew on
  // an import, a hand-edited file) must not be able to masquerade as "the last
  // completed day" and pull tomorrow's numbers into today's coaching.
  const prevDay = todayKey
    ? (grAll.filter(d => d && d.date && d.date < todayKey).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-1)[0] || null)
    : null;

  const todayTrades = Array.isArray(dt[todayKey]) ? dt[todayKey] : [];

  // Trust order, most authoritative first. All three are today-keyed.
  let n, source;
  if (today && today.n != null) {
    n = today.n; source = 'gr_history';
  } else if (todayTrades.length) {
    n = todayTrades.length; source = 'day_trades';
  } else if (opts.accTradeCount != null) {
    n = Number(opts.accTradeCount) || 0; source = 'account';
  } else {
    n = 0; source = 'none';
  }

  return {
    todayKey,
    n,
    source,
    // "Has today actually produced a record yet?" — distinct from n === 0,
    // which is also what a real flat day looks like.
    hasTodayData: !!(today || todayTrades.length),
    today,
    prevDay
  };
}

module.exports = { resolveTodayStatus };
