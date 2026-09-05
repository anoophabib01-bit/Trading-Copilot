'use strict';
// ── PROTOCOL 3: TRUST ───────────────────────────────────────────────────────
// Anoop, 2026-08-31: "i do not want same mistake so create a self check mini
// protocol."
//
// ── WHAT THE OTHER TWO PROTOCOLS DO NOT ASK ─────────────────────────────────
// Protocol 1 (health) asks "is the app RUNNING?".
// Protocol 2 (feed) asks "is the feed READING?".
// Neither asks the question that actually cost him on 2026-08-31:
//
//        IS WHAT THE APP IS SHOWING SUPPORTED BY THE DATA IT HAS?
//
// That day the feed WAS reading and the app WAS running. The broker panel had
// gone stale, the order-history walk desynced, and the feed correctly fell back
// to reconstructing the day from account balance moves. Net P&L stayed accurate
// to the cent. But every consumer downstream kept treating those balance-move
// rows as if they were trades, and the app published, as fact:
//
//   shown            actual (broker export)
//   2 trades         10 round-trips, 16 contracts
//   1W / 1L          6W / 4L
//   best $8          best +$30.00
//   worst -$52       worst -$59.00
//   median hold 0s   median 9s
//   "start at 5"     against a hard sizeCap of 2
//   bias: silent     2 LONG / 8 SHORT against a LONG bias with a 75% target
//
// and then Jessi coached him on a "$-61 revenge re-entry" that never happened.
//
// The marker was on every row the whole time (`source: 'live-fold-only'`).
// Nothing checked it. So this protocol checks the INVARIANTS BETWEEN what is
// stored and what is displayed, rather than the liveness of any component.
//
// DESIGN RULES, inherited from the rest of this repo:
//   • Pure and unit-tested. No fs, no clock, no network — observations are
//     gathered by the caller and passed in, exactly like feed-protocol.evaluate.
//   • It REPORTS, it does not repair. Every fault here means a number on screen
//     is unsupported; silently rewriting the number is how the original bug
//     class got here. A visible gap beats a confident wrong answer.
//   • Every finding names the real values that triggered it. "Data mismatch"
//     teaches nothing; "advice says 5, sizeCap is 2" is actionable.

const SEV = { OK: 'ok', WARN: 'warn', FAIL: 'fail' };

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }
function isFoldRow(t) { return !!t && (t.source === 'live-fold-only' || t.evidence === 'fold'); }

/**
 * T1 — per-trade statistics published from rows that cannot support them.
 * THE 2026-08-31 BUG. A balance-delta row is one number with no entry, exit,
 * side, hold or count; any best/worst/win-loss/hold figure derived from it is
 * fabricated, however plausible it looks.
 */
function checkTradeDetailSupported(day, trades) {
  const list = Array.isArray(trades) ? trades.filter(Boolean) : [];
  if (!list.length) return { id: 'T1', sev: SEV.OK, msg: 'No trades on record for this day.' };
  const fold = list.filter(isFoldRow);
  if (!fold.length) return { id: 'T1', sev: SEV.OK, msg: list.length + ' trade(s), all with real trade-level detail.' };

  const d = day || {};
  // Fields that are only knowable from real per-trade data.
  // Refined 2026-09-02, to match fold-only.js's fieldTrust(). A balance-delta
  // fold DOES know each trade's P&L and size, so best/worst/win-loss are real
  // and flagging them was over-strict — it made the recap blank four true
  // tiles. What a fold cannot know is TIMING: every folded row carries hold:0,
  // meaning unknown, and that is the field that produced a fabricated
  // "median hold 0s, you exit winners too early".
  const published = [];
  if (num(d.medHold) !== null) published.push('medHold ' + d.medHold);
  if (num(d.avgHold) !== null && num(d.avgHold) !== 0) published.push('avgHold ' + d.avgHold);
  if (num(d.avgGap) !== null && num(d.avgGap) !== 0) published.push('avgGap ' + d.avgGap);

  const allFold = fold.length === list.length;
  if (!published.length) {
    return {
      id: 'T1', sev: SEV.OK,
      msg: (allFold ? 'Day is fold-only' : 'Day is partly fold-derived')
        + ' and correctly publishes no per-trade statistics.',
    };
  }
  return {
    id: 'T1', sev: SEV.FAIL,
    msg: (allFold
      ? 'Day was reconstructed from balance moves only (' + fold.length + '/' + list.length + ' rows are fold-derived)'
      : fold.length + ' of ' + list.length + ' rows are fold-derived')
      + ', but TIMING statistics are being published: ' + published.join(', ')
      + '. A fold records balance moves, not fills — hold times and gaps were never measured, and a 0 there means unknown. P&L, size, best/worst and win-loss ARE trustworthy on this day; these are not.',
    fix: 'Suppress the timing figures and mark the day unreconciled. Keep showing P&L, size, best/worst and win-loss — those survive a fold.',
  };
}

/**
 * T2 — the app recommending a size above the hard cap.
 * A recommendation over sizeCap should be impossible by construction. The 150K
 * breach on 2026-07-21 was sized 5 against a stated 2-cap the app was not
 * enforcing (see rules.json _sizeCap_comment); the app then RECOMMENDING 5 on
 * 2026-08-31 is the same failure one layer up.
 */
function checkSizeAdviceWithinCap(advice, rules) {
  const cap = num(rules && rules.sizeCap);
  const size = num(advice && advice.size);
  if (cap === null) return { id: 'T2', sev: SEV.WARN, msg: 'No sizeCap configured — cannot verify size advice.' };
  if (size === null) return { id: 'T2', sev: SEV.OK, msg: 'No size advice published.' };
  if (size > cap) {
    return {
      id: 'T2', sev: SEV.FAIL,
      msg: 'Starting-size advice is ' + size + ' contracts against a hard sizeCap of ' + cap + '.',
      fix: 'Clamp the recommendation to sizeCap. Advice above the cap must be unreachable, not merely unlikely.',
    };
  }
  return { id: 'T2', sev: SEV.OK, msg: 'Size advice ' + size + ' is within the cap of ' + cap + '.' };
}

/**
 * T3 — bias adherence silently un-computable.
 * bias-tracker filters to rows carrying a side. Fold rows have side:null, so a
 * day of 8 counter-trend shorts filtered down to zero trades and reported
 * nothing at all. Absent is not the same as compliant, and must not look it.
 */
function checkBiasComputable(bias, trades) {
  const list = Array.isArray(trades) ? trades.filter(Boolean) : [];
  if (!list.length) return { id: 'T3', sev: SEV.OK, msg: 'No trades to judge bias against.' };
  const withoutSide = list.filter((t) => !t.side).length;
  if (!withoutSide) return { id: 'T3', sev: SEV.OK, msg: 'All ' + list.length + ' trade(s) carry a side.' };
  const counted = num(bias && bias.total);
  const declared = bias && bias.direction && bias.direction.dir;
  if (!declared) {
    return { id: 'T3', sev: SEV.OK, msg: 'No direction of record declared — nothing to measure against.' };
  }
  return {
    id: 'T3',
    sev: withoutSide === list.length ? SEV.FAIL : SEV.WARN,
    msg: withoutSide + ' of ' + list.length + ' trade(s) have no recorded side, so bias adherence '
      + (counted ? 'was measured over only ' + counted + ' of them' : 'could not be measured at all')
      + ' against a declared ' + declared + ' bias.',
    fix: 'Report adherence as not-computable and say how many rows lack a side. An unmeasurable rule must never render as a kept one.',
  };
}

/**
 * T4 — gross and net disagree with the contract count.
 * net = gross - (contracts x commissionPerSide x 2). On 2026-08-31 the fold
 * recorded size 5 while 16 contracts traded, so gross was reconstructed
 * $20.90 light. Catching this would have exposed the whole fault from the
 * day summary alone, with no broker export needed.
 */
function checkCommissionConsistency(day, rules) {
  const gross = num(day && day.gross);
  const net = num(day && day.pnl);
  const contracts = num(day && day.contracts);
  const perSide = num(rules && rules.commissionPerContractPerSide);
  if (gross === null || net === null || contracts === null || perSide === null) {
    return { id: 'T4', sev: SEV.OK, msg: 'Not enough fields to cross-check commission.' };
  }
  const expected = gross - contracts * perSide * 2;
  const drift = Math.round((net - expected) * 100) / 100;
  if (Math.abs(drift) < 0.02) {
    return { id: 'T4', sev: SEV.OK, msg: 'Gross/net/contracts agree (' + contracts + 'c at $' + perSide + '/side).' };
  }
  return {
    id: 'T4', sev: SEV.WARN,
    msg: 'Gross $' + gross + ' minus commission on ' + contracts + ' contracts should net $'
      + Math.round(expected * 100) / 100 + ', but the day says $' + net + ' (drift $' + drift + ').',
    fix: 'Usually means the recorded contract count is wrong, not the money — check the size on each row.',
  };
}

/**
 * T5 — statistics written while the feed knew it was degraded.
 * The feed already publishes brokerSummaryStale and a desync flag. If a day's
 * numbers were produced during that window they are provisional, and saying so
 * costs nothing.
 */
function checkFeedTrustAtWrite(feed) {
  if (!feed) return { id: 'T5', sev: SEV.OK, msg: 'No feed state supplied.' };
  const bad = [];
  if (feed.brokerSummaryStale === true) bad.push('the account-summary table was stale');
  if (feed.orderHistoryDesynced === true) bad.push('the order-history walk was desynced');
  if (num(feed.closedRoundTripsScored) === 0 && num(feed.tradeCount) > 0) {
    bad.push('trades were counted without a single scored round-trip (' + feed.tradeCount + ' from balance moves)');
  }
  if (!bad.length) return { id: 'T5', sev: SEV.OK, msg: 'Feed reported itself healthy while today\'s numbers were written.' };
  return {
    id: 'T5', sev: SEV.WARN,
    msg: 'Today\'s numbers were produced while ' + bad.join(', and ') + '.',
    fix: 'Mark the day provisional until reconciled. The feed knew; the record should say so too.',
  };
}

/**
 * Run the protocol.
 * @param {{day, trades, advice, bias, feed}} obs
 * @param {object} rules  active rules (rules.json shape)
 */
function evaluate(obs, rules) {
  const o = obs || {};
  const checks = [
    checkTradeDetailSupported(o.day, o.trades),
    checkSizeAdviceWithinCap(o.advice, rules),
    checkBiasComputable(o.bias, o.trades),
    checkCommissionConsistency(o.day, rules),
    checkFeedTrustAtWrite(o.feed),
  ];
  const fails = checks.filter((c) => c.sev === SEV.FAIL);
  const warns = checks.filter((c) => c.sev === SEV.WARN);
  return {
    checks,
    failed: fails.length,
    warned: warns.length,
    severity: fails.length ? SEV.FAIL : warns.length ? SEV.WARN : SEV.OK,
    summary: summarise(checks),
  };
}

function summarise(checks) {
  const fails = checks.filter((c) => c.sev === SEV.FAIL);
  const warns = checks.filter((c) => c.sev === SEV.WARN);
  if (!fails.length && !warns.length) return 'TRUST OK — every published figure is supported by the data behind it.';
  const parts = [];
  if (fails.length) parts.push(fails.length + ' unsupported figure' + (fails.length === 1 ? '' : 's') + ' on screen');
  if (warns.length) parts.push(warns.length + ' caution' + (warns.length === 1 ? '' : 's'));
  return 'TRUST ' + (fails.length ? 'FAIL' : 'WARN') + ' — ' + parts.join(', ') + '. '
    + fails.concat(warns).map((c) => c.id + ': ' + c.msg).join(' | ');
}

module.exports = {
  evaluate, summarise, SEV,
  checkTradeDetailSupported, checkSizeAdviceWithinCap,
  checkBiasComputable, checkCommissionConsistency, checkFeedTrustAtWrite,
};
