'use strict';
/* ── Week rollup — the Weekly Report tab's single source of computation ─────
 *
 * WHY THIS EXISTS (2026-08-29, Anoop: "i want to create a weekly report tab
 * that gives information about the whole week and a details report of all the
 * days included... it should point out major mistakes and positives... i want
 * to see this page every weekend to plan for my upcoming week.")
 *
 * A week is a FOLD OVER WHAT IS ALREADY STORED, not a new capture. Everything
 * here reads gr_history (per-day discipline records), day_trades (per-trade
 * detail), balance_ledger (money), ck_history (pre-session checklist) and
 * notes (journal). Nothing new has to be recorded for a week to exist, which
 * is why weeks predating this module can be backfilled exactly.
 *
 * THE THREE DESIGN DECISIONS ANOOP MADE, and why the code looks like this:
 *
 * 1. VERDICT IS A QUADRANT, not a single score. His own data killed the
 *    single-score idea: over 2026-08-17..28 the HIGHEST discipline day (79%)
 *    was the WORST money day (-$1,436.20) and the best money day (+$858) scored
 *    59%. A tab headlining either number alone would have told him the opposite
 *    of the truth. So each day lands in one of four cells — earned it / got
 *    away with it / cost of doing business / self-inflicted — and the week is
 *    described by where the days sat, not by averaging two uncorrelated numbers.
 *
 * 2. A FLAT DAY IS A WIN. His mind_log names the core problem as
 *    "triple-click[ing] the mouse button for an unnecessary trade". If not
 *    trading is the fix, restraint has to be visible, or a 5-trade losing week
 *    and a 1-trade winning week both just read as "showed up". Weekdays with
 *    no trades score as heldFire. Weekends never do — the market is shut and
 *    counting Saturday as restraint would inflate the number into a lie.
 *
 * 3. LOSS ATTRIBUTION IS MUTUALLY EXCLUSIVE, by a FIXED severity order.
 *    Flags overlap (a trade is routinely revenge AND oversize), so summing
 *    per-flag P&L double-counts: on 2026-08-24..28 the per-flag sums were
 *    revenge -$1,077.58 and oversize -$421.38 against total losing rows of
 *    -$3,882.80. Each loss is blamed on its single most serious breach, in a
 *    FIXED order (see SEVERITY) so the slices mean the same thing every week
 *    and a trend across weeks is real rather than an artefact of re-ranking.
 *
 * ── THREE P&L STORES, AND WHICH ONE IS ACTUALLY RIGHT ─────────────────────
 * gr_history, balance_ledger and the day_trades rows are one fact stored three
 * ways, and on 2026-08-24..28 they disagreed: gr_history -$1,392.08 against
 * -$1,217.28 from the other two, a $174.80 gap on a single day (2026-08-26).
 *
 * gr_history wins, and the reason is not "it is the broker's number" — it is
 * that gr_history is the OUTPUT OF day-rollup's rollupDay(), the only
 * computation here that handles a day whose rows carry MIXED pnlBasis. That
 * day had 96 contracts across 13 rows, some stamped 'gross' (CSV import) and
 * some 'net' (live fold). rollupDay normalises every row to gross and charges
 * commission once; balance_ledger summed the rows raw and wrote the result
 * into BOTH its gross and net fields, so commission was never taken off.
 *
 * The ledger is a convenience mirror that agrees whenever a day's rows share
 * one basis — which is every other day on record, including the all-fold
 * 2026-08-25 where gross === net is correct rather than a bug. So: prefer the
 * shared computation over the mirror, and always emit `reconcile` so a
 * disagreeing day is named rather than resolved out of sight. That is the same
 * failure class health-protocol.js already exists to catch.
 *
 * PURE. No fs, no DOM, no clock beyond what is passed in. UMD: window.WeekRollup
 * in the browser, CommonJS for server.js and the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WeekRollup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed blame order — Anoop's choice, 2026-08-29. Oversize outranks revenge
  // because it is the one breach that can end the account in a single trade:
  // the $2,000 trailing drawdown is the whole allowance and the size-5 short on
  // 2026-08-28 alone cost $1,322.00 of it. Changing this order changes what
  // every historical week says it was about, so it is a constant, not an option.
  const SEVERITY = ['oversize', 'revenge', 'hold-exceeded', 'out-of-window'];

  const SLICE_LABEL = {
    oversize: 'Oversize',
    revenge: 'Revenge / cooldown',
    'hold-exceeded': 'Held too long',
    'out-of-window': 'Outside session',
    clean: 'Clean loss',
    unattributed: 'No flag data'
  };

  function num(n) { return typeof n === 'number' && Number.isFinite(n) ? n : 0; }
  function r2(n) { return Math.round(n * 100) / 100; }

  // ── ISO-8601 week identity ────────────────────────────────────────────────
  // Monday-first; the week owning the Thursday owns the year. Used as the
  // storage key (DATA/weekly/2026-W35.json), so it must never drift.
  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;          // Mon=0 .. Sun=6
    d.setUTCDate(d.getUTCDate() - day + 3);       // to that week's Thursday
    const year = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return year + '-W' + String(week).padStart(2, '0');
  }

  /** The Monday of the week containing `dateStr`, as YYYY-MM-DD. */
  function weekStart(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  /** All seven YYYY-MM-DD dates Mon..Sun for the week containing `dateStr`. */
  function weekDates(dateStr) {
    const start = new Date(weekStart(dateStr) + 'T00:00:00Z');
    const out = [];
    for (let i = 0; i < 7; i++) {
      out.push(new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
    }
    return out;
  }

  /** The Monday of the week before the one containing `dateStr`. */
  function prevWeekStart(dateStr) {
    const d = new Date(weekStart(dateStr) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  }

  // ── Per-day breach count ──────────────────────────────────────────────────
  // What "broke the rules today" means, in one place. Kept to breaches that
  // are BOTH in rules.json AND reliably recorded: size over cap, revenge
  // re-entry, trading on past three consecutive losses, and entries outside the
  // session windows. Deliberately NOT the disc% score — see the header for why
  // that number cannot carry a verdict.
  function dayBreaches(grDay, rows) {
    if (!grDay) return { total: 0, parts: { oversize: 0, revenge: 0, pastThreeLosses: 0, outOfWindow: 0 } };
    const outOfWindow = (rows || []).filter(t => (t.flags || []).indexOf('out-of-window') >= 0).length;
    const parts = {
      oversize: num(grDay.over),
      revenge: num(grDay.revenge),
      pastThreeLosses: grDay.tradedPast3Losses ? 1 : 0,
      outOfWindow: outOfWindow
    };
    return { total: parts.oversize + parts.revenge + parts.pastThreeLosses + parts.outOfWindow, parts: parts };
  }

  // ── Quadrant ──────────────────────────────────────────────────────────────
  // money(up|down) x process(kept|broken). A flat-P&L traded day counts as
  // `earned` only if the rules held — churning to breakeven is not earning it.
  function quadrantOf(net, breaches) {
    const kept = breaches === 0;
    if (net < 0) return kept ? 'badLuck' : 'selfInflicted';
    return kept ? 'earned' : 'gotAway';
  }

  const QUADRANT_LABEL = {
    earned: 'Earned it',
    gotAway: 'Got away with it',
    badLuck: 'Cost of doing business',
    selfInflicted: 'Self-inflicted'
  };

  // ── Loss attribution ──────────────────────────────────────────────────────
  // One losing trade -> exactly one slice, by SEVERITY. Winners are excluded
  // entirely: this answers "where did the money go", and a revenge trade that
  // happened to win did not cost anything to attribute. `coveragePct` is
  // reported so the pie can state what fraction of the loss it actually
  // explained rather than implying it explained all of it.
  function attributeLosses(rows) {
    const slices = {};
    let totalLoss = 0, attributed = 0, unattributedRows = 0, losingRows = 0;
    (rows || []).forEach(t => {
      const pnl = num(t.pnl);
      if (pnl >= 0) return;
      losingRows++;
      totalLoss += pnl;
      let key;
      if (!Array.isArray(t.flags)) { key = 'unattributed'; unattributedRows++; }
      else {
        key = 'clean';
        for (let i = 0; i < SEVERITY.length; i++) {
          if (t.flags.indexOf(SEVERITY[i]) >= 0) { key = SEVERITY[i]; break; }
        }
      }
      if (key !== 'unattributed') attributed += pnl;
      slices[key] = r2((slices[key] || 0) + pnl);
    });
    const ordered = Object.keys(slices)
      .map(k => ({
        key: k,
        label: SLICE_LABEL[k] || k,
        loss: slices[k],
        pct: totalLoss ? Math.round(slices[k] / totalLoss * 1000) / 10 : 0
      }))
      .sort((a, b) => a.loss - b.loss);
    return {
      slices: ordered,
      totalLoss: r2(totalLoss),
      attributedLoss: r2(attributed),
      losingRows: losingRows,
      unattributedRows: unattributedRows,
      coveragePct: totalLoss ? Math.round(attributed / totalLoss * 1000) / 10 : 100
    };
  }

  // ── The week ──────────────────────────────────────────────────────────────
  /**
   * @param anyDateInWeek  YYYY-MM-DD, any day of the target week
   * @param src {
   *   grDays:      array of gr_history day objects (any range; filtered here)
   *   tradesByDay: { 'YYYY-MM-DD': [row, ...] } from day_trades
   *   ledger:      { 'YYYY-MM-DD': { net } } from balance_ledger — money truth
   *   ckByDate:    { 'YYYY-MM-DD': ck_history entry }
   *   notesByDate: { 'YYYY-MM-DD': { text, mood, followedPlan, mistake, lesson } }
   *   account:     rules.json eval/funded block { start, maxDrawdown, profitTarget, minTradingDays }
   *   todayKey:    YYYY-MM-DD trading-day key of "now" — decides which days are
   *                still in the future and so must NOT be scored as held-fire
   * }
   */
  function rollupWeek(anyDateInWeek, src) {
    const s = src || {};
    const dates = weekDates(anyDateInWeek);
    const grBy = {};
    (s.grDays || []).forEach(d => { if (d && d.date) grBy[d.date] = d; });
    const tradesByDay = s.tradesByDay || {};
    const ledger = s.ledger || {};
    const ckByDate = s.ckByDate || {};
    const notesByDate = s.notesByDate || {};
    const todayKey = s.todayKey || dates[6];
    // Earliest day this account has ANY record for. Supplied by the caller
    // (week-store derives it from the stores); absent means "no horizon known",
    // in which case nothing is treated as pre-history.
    const dataStart = s.dataStart || null;

    const days = [];
    let allRows = [];
    dates.forEach((date, i) => {
      const isWeekend = i >= 5;
      const future = date > todayKey;
      const gr = grBy[date] || null;
      const rows = tradesByDay[date] || [];
      const traded = !!gr || rows.length > 0;
      const br = dayBreaches(gr, rows);
      // Money truth order: the broker's ledger, then gr_history's day figure,
      // then the rows. A day only claims $0 when it actually traded to $0.
      const led = ledger[date];
      const rowSum = rows.length ? r2(rows.reduce((a, t) => a + num(t.pnl), 0)) : null;
      const ledNet = led && typeof led.net === 'number' ? r2(led.net) : null;
      const grNet = gr && typeof gr.pnl === 'number' ? r2(gr.pnl) : null;
      // ── WHY gr_history WINS, and why that is not the obvious choice ──────
      // First instinct was to prefer balance_ledger as "the broker's own
      // figure". That is wrong, and the arithmetic on 2026-08-26 proves it:
      //
      //   13 rows, 96 contracts, MIXED pnlBasis (some 'gross' from CSV
      //   import, some 'net' from the live fold).
      //   balance_ledger : gross -498.80, net -498.80   <- identical
      //   gr_history     : -673.60
      //
      // The ledger stored the raw row sum in BOTH fields, so commission was
      // never taken off. gr_history is the output of day-rollup's rollupDay(),
      // which normalises every row to gross via grossOf() and then subtracts
      // commission exactly once — the only computation in this app that
      // handles a mixed-basis day correctly (see day-rollup.js's pnlBasis
      // header for the double-charging bug that logic exists to fix).
      //
      // The ledger is a convenience mirror that happens to agree whenever a
      // day's rows share one basis, which is most days — 2026-08-25 is
      // all-fold, so gross === net there is CORRECT, not a bug. Preferring it
      // understated the week of 2026-08-24 by $174.80.
      //
      // So: the shared computation wins over the convenience mirror. Same
      // principle as day-rollup.js's own header — one definition, not two.
      const net = grNet != null ? grNet : ledNet != null ? ledNet : rowSum != null ? rowSum : 0;
      // THREE-WAY, not two. When a repair touches one store and not the others
      // they drift silently, so every day that disagrees is reported rather
      // than resolved out of sight.
      const present = [ledNet, grNet, rowSum].filter(v => v != null);
      const sourcesAgree = present.length < 2
        || present.every(v => Math.abs(v - present[0]) < 0.01);
      // ── HELD FIRE IS ONLY CREDITED INSIDE THE RECORDED PERIOD ────────────
      // (2026-08-31) The first version credited restraint for any past weekday
      // with no trades — including weeks BEFORE this account had a single
      // record. Rendering the four-week window on 2026-08-31 produced
      // "2026-W33: Days held fire 5", five days of discipline invented for a
      // week he was not using the app. Same failure as the empty-in-progress
      // week: an absence of data reported as a presence of virtue.
      //
      // `dataStart` is the earliest day this account has any record for.
      // Weekdays before it are pre-history: not traded, not restraint, no data.
      // TODAY does not count either, until it is over. Opened at 13:08 on a
      // Monday — before the NY session has run — the `<= todayKey` version
      // credited a day of restraint for a day he had not finished not-trading
      // yet. Restraint is only earned by a completed day, so this is a strict
      // `<`. It flips to a win at the next rollover if the day stays flat.
      const preHistory = !!dataStart && date < dataStart;
      const dayIsOver = date < todayKey;
      const heldFire = !traded && !isWeekend && dayIsOver && !preHistory;
      days.push({
        date: date,
        dow: i,                       // 0=Mon .. 6=Sun
        isWeekend: isWeekend,
        future: future,
        traded: traded,
        heldFire: heldFire,
        preHistory: preHistory,
        net: traded ? r2(net) : 0,
        sources: { ledger: ledNet, grHistory: grNet, rows: rowSum, agree: sourcesAgree },
        n: gr ? num(gr.n) : rows.length,
        contracts: gr ? num(gr.contracts) : rows.reduce((a, t) => a + num(t.size), 0),
        maxSize: gr ? num(gr.maxSize) : 0,
        disc: gr && typeof gr.disc === 'number' ? gr.disc : null,
        giveback: gr ? num(gr.giveback) : 0,
        flips: gr ? num(gr.flips) : 0,
        maxConsecLoss: gr ? num(gr.maxConsecLoss) : 0,
        sizedUpIntoLoss: !!(gr && gr.sizedUpIntoLoss),
        wins: gr ? num(gr.wins) : 0,
        losses: gr ? num(gr.losses) : 0,
        avgHold: gr ? num(gr.avgHold) : 0,
        breaches: br.total,
        breachParts: br.parts,
        quadrant: traded ? quadrantOf(net, br.total) : null,
        checklist: ckByDate[date]
          ? { score: ckByDate[date].score, tier: ckByDate[date].tier, label: ckByDate[date].label }
          : null,
        note: notesByDate[date] || null
      });
      if (rows.length) allRows = allRows.concat(rows);
    });

    const traded = days.filter(d => d.traded);
    const netBroker = r2(traded.reduce((a, d) => a + d.net, 0));
    const netRows = r2(allRows.reduce((a, t) => a + num(t.pnl), 0));

    const quadrants = { earned: [], gotAway: [], badLuck: [], selfInflicted: [] };
    traded.forEach(d => { if (quadrants[d.quadrant]) quadrants[d.quadrant].push(d.date); });

    const attribution = attributeLosses(allRows);

    const discDays = traded.filter(d => d.disc != null);
    const behaviour = {
      trades: allRows.length,
      contracts: traded.reduce((a, d) => a + d.contracts, 0),
      maxSize: traded.reduce((m, d) => Math.max(m, d.maxSize), 0),
      oversizeTrades: traded.reduce((a, d) => a + d.breachParts.oversize, 0),
      revengeTrades: traded.reduce((a, d) => a + d.breachParts.revenge, 0),
      outOfWindowTrades: traded.reduce((a, d) => a + d.breachParts.outOfWindow, 0),
      flips: traded.reduce((a, d) => a + d.flips, 0),
      giveback: r2(traded.reduce((a, d) => a + d.giveback, 0)),
      worstConsecLoss: traded.reduce((m, d) => Math.max(m, d.maxConsecLoss), 0),
      sizedUpIntoLossDays: traded.filter(d => d.sizedUpIntoLoss).length,
      pastThreeLossesDays: traded.filter(d => d.breachParts.pastThreeLosses).length,
      wins: traded.reduce((a, d) => a + d.wins, 0),
      losses: traded.reduce((a, d) => a + d.losses, 0),
      grossWins: r2(allRows.filter(t => num(t.pnl) > 0).reduce((a, t) => a + num(t.pnl), 0)),
      grossLosses: attribution.totalLoss,
      avgDisc: discDays.length ? Math.round(discDays.reduce((a, d) => a + d.disc, 0) / discDays.length) : null,
      heldFireDays: days.filter(d => d.heldFire).length,
      preHistoryDays: days.filter(d => d.preHistory && !d.isWeekend).length,
      tradedDays: traded.length,
      cleanDays: traded.filter(d => d.breaches === 0).length
    };

    // ── Account picture ──────────────────────────────────────────────────────
    // What this week did to the ONE number that ends the account. Reported as a
    // share of the whole allowance, because "-$1,436" means nothing until it is
    // said as "72% of everything you are allowed to lose, in one day".
    const acct = s.account || {};
    const maxDD = num(acct.maxDrawdown);
    const worstDay = traded.length ? traded.reduce((w, d) => (d.net < w.net ? d : w), traded[0]) : null;
    const bestDay = traded.length ? traded.reduce((b, d) => (d.net > b.net ? d : b), traded[0]) : null;
    const account = {
      start: num(acct.start) || null,
      maxDrawdown: maxDD || null,
      profitTarget: num(acct.profitTarget) || null,
      minTradingDays: num(acct.minTradingDays) || null,
      drawdownUsedThisWeek: netBroker < 0 ? r2(-netBroker) : 0,
      drawdownPctThisWeek: maxDD && netBroker < 0 ? Math.round(-netBroker / maxDD * 1000) / 10 : 0,
      worstDayPctOfDrawdown: maxDD && worstDay && worstDay.net < 0
        ? Math.round(-worstDay.net / maxDD * 1000) / 10 : 0,
      progressToTargetPct: num(acct.profitTarget)
        ? Math.round(netBroker / acct.profitTarget * 1000) / 10 : null,
      tradingDaysThisWeek: traded.length
    };

    return {
      weekKey: isoWeekKey(anyDateInWeek),
      start: dates[0],
      end: dates[6],
      // Complete once the trading week is over, NOT once Sunday has passed —
      // he reviews on Saturday, and a week that says "still running" on the
      // morning he sits down to review it is a week he cannot close out.
      complete: dates[4] < todayKey,
      dataStart: dataStart,
      days: days,
      money: {
        net: netBroker,
        netFromRows: netRows,
        reconcile: {
          delta: r2(netBroker - netRows),
          agree: Math.abs(netBroker - netRows) < 0.01,
          disagreeDays: days.filter(d => d.traded && !d.sources.agree)
            .map(d => ({ date: d.date, ledger: d.sources.ledger, grHistory: d.sources.grHistory, rows: d.sources.rows })),
          note: 'balance_ledger, gr_history and the trade rows are one fact stored three ways. The week total prefers gr_history, because it is the only one computed through day-rollup, which subtracts commission exactly once on a day whose rows have mixed gross/net basis. balance_ledger sums rows raw, so on a mixed-basis day it silently reports the gross figure as net.'
        },
        best: bestDay ? { date: bestDay.date, net: bestDay.net } : null,
        worst: worstDay ? { date: worstDay.date, net: worstDay.net } : null
      },
      quadrants: quadrants,
      attribution: attribution,
      behaviour: behaviour,
      account: account
    };
  }

  // ── Week-over-week ────────────────────────────────────────────────────────
  // Only fields where a direction is unambiguous. `betterIsUp` says which way
  // is good, so the renderer never has to guess that giveback rising is bad.
  const TREND_FIELDS = [
    { key: 'net', get: w => w.money.net, betterIsUp: true, label: 'Net P&L', money: true },
    { key: 'trades', get: w => w.behaviour.trades, betterIsUp: false, label: 'Trades taken' },
    { key: 'maxSize', get: w => w.behaviour.maxSize, betterIsUp: false, label: 'Biggest size' },
    { key: 'oversizeTrades', get: w => w.behaviour.oversizeTrades, betterIsUp: false, label: 'Oversize trades' },
    { key: 'revengeTrades', get: w => w.behaviour.revengeTrades, betterIsUp: false, label: 'Revenge trades' },
    { key: 'giveback', get: w => w.behaviour.giveback, betterIsUp: false, label: 'Giveback', money: true },
    { key: 'cleanDays', get: w => w.behaviour.cleanDays, betterIsUp: true, label: 'Clean days' },
    { key: 'heldFireDays', get: w => w.behaviour.heldFireDays, betterIsUp: true, label: 'Days held fire' }
  ];

  /**
   * Has anything actually happened in this week yet?
   *
   * WHY THIS GATE EXISTS (2026-08-31). The first version compared the week on
   * screen against the previous one unconditionally. Opened on a Monday, that
   * scored an in-progress week with zero trades as an improvement on EVERY
   * behavioural metric at once — "Trades taken 49 -> 0, better. Biggest size
   * 18 -> 0, better. Giveback $2,505 -> $0, better." Not having traded yet is
   * not progress, and a report that congratulates him at 09:00 on Monday for
   * work he has not done is worse than no report: it is the exact flattery
   * this tab exists to refuse.
   */
  function weekHasData(w) {
    return !!w && !!w.behaviour && (w.behaviour.tradedDays > 0 || w.behaviour.heldFireDays > 0);
  }

  /** Two weeks may only be scored against each other if BOTH are finished. */
  function weeksComparable(a, b) {
    return weekHasData(a) && weekHasData(b) && !!a.complete && !!b.complete;
  }

  function compareWeeks(current, previous) {
    if (!current) return [];
    const scoreable = weeksComparable(current, previous);
    return TREND_FIELDS.map(f => {
      const now = f.get(current);
      const then = previous ? f.get(previous) : null;
      // A delta is still reported when the pair is not scoreable — the numbers
      // are real — but `good` stays null so nothing renders a verdict on it.
      const delta = then == null ? null : r2(now - then);
      let dir = 'flat';
      if (delta != null && delta !== 0) dir = delta > 0 ? 'up' : 'down';
      let good = null;
      if (scoreable && delta != null && delta !== 0) good = (delta > 0) === f.betterIsUp;
      return {
        key: f.key, label: f.label, money: !!f.money,
        now: now, prev: then, delta: delta, dir: dir, good: good,
        scoreable: scoreable
      };
    });
  }

  // ── Multi-week trend ──────────────────────────────────────────────────────
  // (2026-08-31, Anoop: "lets compare 4 weeks data in this section".)
  //
  // One row per metric, one column per week, oldest -> newest. Two weeks tells
  // you a direction; four tells you whether it is a trend or just last week.
  //
  // Weeks with no data are carried as explicit nulls rather than dropped, so
  // the columns stay aligned to real calendar weeks — a gap where he did not
  // trade at all is itself information, and silently closing it would make a
  // three-week break look like three consecutive trading weeks.
  //
  // The verdict arrow compares the two most recent FINISHED weeks that both
  // have data, never the in-progress one. See weekHasData above.
  function trendSeries(weeks) {
    const list = (weeks || []).filter(Boolean);
    const scored = list.filter(w => weekHasData(w) && w.complete);
    const latest = scored[scored.length - 1] || null;
    const prior = scored[scored.length - 2] || null;

    return TREND_FIELDS.map(f => {
      const points = list.map(w => {
        const has = weekHasData(w);
        return {
          weekKey: w.weekKey,
          start: w.start,
          value: has ? f.get(w) : null,
          hasData: has,
          inProgress: !w.complete
        };
      });
      const now = latest ? f.get(latest) : null;
      const then = prior ? f.get(prior) : null;
      const delta = (now == null || then == null) ? null : r2(now - then);
      let dir = 'flat';
      if (delta != null && delta !== 0) dir = delta > 0 ? 'up' : 'down';
      let good = null;
      if (delta != null && delta !== 0) good = (delta > 0) === f.betterIsUp;
      return {
        key: f.key, label: f.label, money: !!f.money, betterIsUp: f.betterIsUp,
        points: points,
        latestWeekKey: latest ? latest.weekKey : null,
        priorWeekKey: prior ? prior.weekKey : null,
        now: now, prev: then, delta: delta, dir: dir, good: good,
        scoredWeeks: scored.length
      };
    });
  }

  // ── Does discipline actually pay? ─────────────────────────────────────────
  // (2026-08-29, taken from RizeTrade's "rule adherence — win rate with vs
  // without rules" idea, which is the one thing in the Tradervue comparison
  // this app did not already do better.)
  //
  // MEASURED PER CONTRACT, NOT PER TRADE — and that is the whole design.
  // Per-trade expectancy is not comparable across different sizes: a 10-lot
  // trade risks ten times what a 1-lot does, so "bigger trades earn more per
  // trade" is arithmetic, not evidence. Reading his rows per-trade suggests
  // size > 2 is his most profitable behaviour (+$10.85/trade vs -$16.14). Per
  // contract the gap collapses to +$1.36 vs -$10.50, and the remaining edge is
  // an artefact of WHICH trades were big: the large-size rows are mostly
  // sub-3-point scalps closed in seconds. The one large position actually held
  // through a move lost $1,322 on 131 adverse points.
  //
  // So this function reports adherence only, never a size recommendation, and
  // it refuses to draw a conclusion below MIN_RELIABLE trades in either arm.
  // A tab that told him oversizing pays would be the most expensive bug this
  // app could ship.
  const MIN_RELIABLE = 30;

  function armStats(rows) {
    const usable = rows.filter(t => num(t.size) > 0);
    const n = usable.length;
    const contracts = usable.reduce((a, t) => a + num(t.size), 0);
    const net = usable.reduce((a, t) => a + num(t.pnl), 0);
    const wins = usable.filter(t => num(t.pnl) > 0);
    const losses = usable.filter(t => num(t.pnl) < 0);
    return {
      trades: n,
      contracts: contracts,
      net: r2(net),
      winPct: n ? Math.round(wins.length / n * 100) : null,
      perTrade: n ? r2(net / n) : null,
      perContract: contracts ? r2(net / contracts) : null,
      avgWin: wins.length ? r2(wins.reduce((a, t) => a + num(t.pnl), 0) / wins.length) : 0,
      avgLoss: losses.length ? r2(losses.reduce((a, t) => a + num(t.pnl), 0) / losses.length) : 0,
      worst: n ? r2(Math.min.apply(null, usable.map(t => num(t.pnl)))) : 0
    };
  }

  /**
   * Split every trade on record into rule-kept vs rule-broken and compare.
   * `rows` should be ALL available history, not one week — a single week rarely
   * has enough clean trades for the comparison to mean anything, and quoting an
   * unreliable edge is worse than quoting none.
   */
  function adherenceSplit(rows) {
    const all = rows || [];
    // Two DIFFERENT reasons a row cannot be used, reported separately rather
    // than as one "excluded" bucket: an ungraded row was never flag-scored, an
    // unsized row has no contract count so it cannot be normalised. Collapsing
    // them would hide which data problem to go and fix.
    const graded = all.filter(t => Array.isArray(t.flags) && num(t.size) > 0);
    const ungraded = all.filter(t => !Array.isArray(t.flags));
    const unsized = all.filter(t => Array.isArray(t.flags) && num(t.size) <= 0);
    const clean = armStats(graded.filter(t => t.flags.length === 0));
    const breached = armStats(graded.filter(t => t.flags.length > 0));
    const reliable = clean.trades >= MIN_RELIABLE && breached.trades >= MIN_RELIABLE;
    const edge = (clean.perContract != null && breached.perContract != null)
      ? r2(clean.perContract - breached.perContract) : null;
    return {
      clean: clean,
      breached: breached,
      gradedTrades: graded.length,
      ungradedTrades: ungraded.length,
      unsizedTrades: unsized.length,
      perContractEdge: edge,
      disciplinePays: edge == null ? null : edge > 0,
      reliable: reliable,
      minReliable: MIN_RELIABLE,
      note: reliable
        ? 'Both arms have enough trades for the comparison to mean something.'
        : 'Only ' + clean.trades + ' clean and ' + breached.trades + ' breached trades on record — '
          + 'below ' + MIN_RELIABLE + ' in either arm this is a direction, not a proven edge. It firms up as more weeks land.',
      basisNote: 'Per CONTRACT, not per trade. Comparing per-trade figures across different sizes measures how big you bet, not how well you traded.'
    };
  }

  // ── Mistakes and positives ────────────────────────────────────────────────
  // Anoop: "it should point out major mistakes and positives".
  //
  // MECHANICAL, RANKED BY COST. Every finding carries the number that produced
  // it, because a coaching line without its evidence is indistinguishable from
  // a guess — and this file is read on the morning he decides next week's size.
  //
  // The hard rule here is NO MANUFACTURED POSITIVES. A week with nothing good
  // in it returns an empty positives array and the renderer says so. Inventing
  // encouragement on a week that cost 61% of the account's whole allowance
  // would train him to discount the section entirely, which would also cost him
  // the real positives in the weeks that have them.
  function weekFindings(week, prev) {
    if (!week) return { mistakes: [], positives: [], headline: null };
    const b = week.behaviour, a = week.account, at = week.attribution;
    const mistakes = [], positives = [];
    const money = n => (n < 0 ? '-$' : '$') + Math.abs(r2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // — Mistakes, most expensive first —
    const worstSlice = at.slices.filter(s => s.key !== 'clean' && s.key !== 'unattributed')[0];
    if (worstSlice && worstSlice.loss < 0) {
      mistakes.push({
        key: worstSlice.key,
        cost: worstSlice.loss,
        title: worstSlice.label + ' cost ' + money(worstSlice.loss),
        detail: worstSlice.pct + '% of everything you lost this week, after each losing trade was blamed on its single worst breach. '
          + 'Clean losses — the ones that are just the cost of trading — came to '
          + money((at.slices.find(s => s.key === 'clean') || { loss: 0 }).loss) + '.'
      });
    }
    if (a.worstDayPctOfDrawdown >= 25 && week.money.worst) {
      mistakes.push({
        key: 'worst-day-drawdown',
        cost: week.money.worst.net,
        title: week.money.worst.date + ' took ' + a.worstDayPctOfDrawdown + '% of your entire drawdown allowance',
        detail: money(week.money.worst.net) + ' against a ' + money(a.maxDrawdown)
          + ' allowance. Four days like that and the account is gone, regardless of what the other days do.'
      });
    }
    if (b.maxSize > 2) {
      mistakes.push({
        key: 'max-size',
        cost: null,
        title: 'Biggest position was ' + b.maxSize + ' lots',
        detail: 'Your own stated ceiling is 2. ' + b.oversizeTrades + ' of ' + b.trades
          + ' trades were over it. Your mind_log: "taking a maximum of two sizes is ideal for my mindset right now."'
      });
    }
    if (b.giveback > 0 && b.giveback > Math.abs(week.money.net)) {
      mistakes.push({
        key: 'giveback',
        cost: -b.giveback,
        title: 'Gave back ' + money(b.giveback) + ' from intraday peaks',
        detail: 'More than the week actually lost (' + money(week.money.net)
          + '). The money was on the screen and handed back — that is an exit problem, not an entry problem.'
      });
    }
    if (b.sizedUpIntoLossDays > 0) {
      mistakes.push({
        key: 'sized-up-into-loss',
        cost: null,
        title: 'Sized up while already down on ' + b.sizedUpIntoLossDays + ' of ' + b.tradedDays + ' days',
        detail: 'The single mechanic behind 4 of your 6 blown accounts. Increasing risk to recover a loss is the definition of the pattern.'
      });
    }
    if (b.pastThreeLossesDays > 0) {
      mistakes.push({
        key: 'past-three-losses',
        cost: null,
        title: 'Kept trading past 3 consecutive losses on ' + b.pastThreeLossesDays + ' day(s)',
        detail: 'Your own 8-rule protocol: two losses in a row = close the platform. Non-negotiable, and it was negotiated ' + b.pastThreeLossesDays + ' time(s).'
      });
    }
    if (b.cleanDays === 0 && b.tradedDays > 0) {
      mistakes.push({
        key: 'no-clean-days',
        cost: null,
        title: 'Not one clean day in ' + b.tradedDays,
        detail: 'Every single trading day carried at least one rule breach. There is no day this week you can point at as the template for next week.'
      });
    }

    // — Positives, only where the data actually shows one —
    if (b.heldFireDays > 0) {
      positives.push({
        key: 'held-fire',
        title: 'Held fire on ' + b.heldFireDays + ' weekday(s)',
        detail: 'No trades taken. Given that your own note names unnecessary trades as the core problem, a day you stayed out is a day you executed correctly.'
      });
    }
    if (b.cleanDays > 0) {
      positives.push({
        key: 'clean-days',
        title: b.cleanDays + ' clean day(s) — no rule breaches at all',
        detail: 'These are the days worth studying. Whatever you did on them is the process, not the exception.'
      });
    }
    if (week.quadrants.earned.length) {
      positives.push({
        key: 'earned',
        title: 'Earned it on ' + week.quadrants.earned.length + ' day(s): ' + week.quadrants.earned.join(', '),
        detail: 'Green P&L with the rules intact — the only quadrant that is actually repeatable.'
      });
    }
    if (prev) {
      compareWeeks(week, prev).filter(t => t.good === true).forEach(t => {
        positives.push({
          key: 'improved-' + t.key,
          title: t.label + ' improved: ' + (t.money ? money(t.prev) : t.prev) + ' → ' + (t.money ? money(t.now) : t.now),
          detail: 'Moved the right way versus last week.'
        });
      });
    }
    const bestClean = (week.days || []).filter(d => d.traded && d.breaches === 0 && d.net > 0)
      .sort((x, y) => y.net - x.net)[0];
    if (bestClean) {
      positives.push({
        key: 'best-clean-day',
        title: 'Best clean day: ' + bestClean.date + ' at ' + money(bestClean.net),
        detail: 'Made money without breaking anything. This is the day to copy.'
      });
    }

    // — Headline —
    const q = week.quadrants;
    const bad = q.selfInflicted.length + q.gotAway.length;
    let headline;
    if (!b.tradedDays) headline = 'No trades this week.';
    else if (q.selfInflicted.length >= 3) {
      headline = q.selfInflicted.length + ' of ' + b.tradedDays + ' trading days ended self-inflicted — losing money with the rules already broken.';
    } else if (bad > b.tradedDays / 2) {
      headline = bad + ' of ' + b.tradedDays + ' days broke rules. The P&L is not the story; the process is.';
    } else if (q.earned.length === b.tradedDays) {
      headline = 'Every trading day this week was earned — green with the rules intact.';
    } else {
      headline = q.earned.length + ' of ' + b.tradedDays + ' days earned it cleanly.';
    }

    return { mistakes: mistakes, positives: positives, headline: headline };
  }

  return {
    rollupWeek, compareWeeks, trendSeries, weekHasData, weeksComparable, weekFindings, adherenceSplit, attributeLosses, dayBreaches, quadrantOf,
    isoWeekKey, weekStart, weekDates, prevWeekStart,
    SEVERITY, SLICE_LABEL, QUADRANT_LABEL, TREND_FIELDS
  };
});
