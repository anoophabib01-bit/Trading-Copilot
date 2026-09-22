'use strict';
/* ── exit-drift.js — what price did AFTER your last exit ─────────────────────
 *
 * (2026-08-31, Anoop's idea: "whatever happened in the market from the exit
 * time that I have exited till the current time, if the market has gone lower
 * than the last exit price then it should be noted as LOWER the last exit...
 * This can also give me the direction of the market for the next trade.")
 *
 * Anchors on the last COMPLETED trade's exit and reports what price has done
 * since. Two readings come out of one walk:
 *
 *   DIRECTION    where price sits now relative to that exit — a bias input.
 *   EXIT QUALITY the same drift read against the side he was in, which answers
 *                a more useful question: did he leave money on the table, or
 *                get out before the move went against him?
 *
 * ── THE TWO THINGS THAT MAKE OR BREAK THIS ──────────────────────────────────
 *
 * 1. RAW "HIGHER OR LOWER" IS ALMOST ALWAYS BOTH. Over any meaningful window
 *    MNQ trades above AND below any given price; the answer is a function of
 *    volatility x elapsed time, not of direction. A boolean would read as a
 *    signal while carrying nearly no information. So the verdict is gated on
 *    MAGNITUDE, normalised to ATR, and returns NO_READ below the threshold.
 *    NO_READ is the expected answer much of the time and is a real answer —
 *    this module must never manufacture a direction to avoid saying nothing.
 *
 * 2. IT MUST NOT BECOME A REGRET FEED. "Price went 15 points past your exit",
 *    shown seconds after he closes a winner, is a live display of money left on
 *    the table — aimed squarely at the two failure modes his own history is
 *    made of (revenge re-entry, "I'll get it back"). So this module reports
 *    `minutesSince` and honours `cooldownMinutes`: inside the cooldown the
 *    verdict is withheld (COOLING) regardless of what price did. The caller
 *    must respect it. The number being true is not sufficient reason to show
 *    it at the moment it does the most damage.
 *
 * NO EXIT PRICE MEANS NO READ. Fold-derived rows carry `xp: null` (see
 * fold-only.js): on an unreconciled day there is no exit price, and anchoring
 * on a stale or inferred one would produce a confident reading built on
 * nothing. Same rule the trust protocol enforces everywhere else.
 *
 * PURE. No fs, no clock, no chart access — the caller passes the trade, the
 * bars and `nowMs`. Unit-tested in test/exit-drift.test.js.
 */

const VERDICT = {
  ABOVE: 'ABOVE',     // price is meaningfully above the last exit
  BELOW: 'BELOW',     // meaningfully below
  NO_READ: 'NO_READ', // drift too small to mean anything
  COOLING: 'COOLING', // too soon after the exit to show him
  UNKNOWN: 'UNKNOWN', // missing exit price / no bars — cannot compute
  MISMATCH: 'MISMATCH', // the bars are a different instrument than the exit
};

// How he exited, judged against the side he was in.
const QUALITY = {
  EARLY: 'EARLY',     // it kept going his way — he left money on the table
  WELL: 'WELL',       // it turned against the trade — the exit protected him
  NEUTRAL: 'NEUTRAL', // inside the threshold
  UNKNOWN: 'UNKNOWN',
};

// HOW FAR THE EXIT MAY SIT FROM THE BARS BEFORE THEY CANNOT BE THE SAME THING.
//
// The chart is not a fixed instrument: the PO3 secondary-symbol watch flips it
// between MNQ and MGC, and data_get_ohlcv returns whatever is on screen. An MNQ
// exit at 29406 read against gold bars at 4371 is not a 25,035-point drift, it
// is two different products — but every number downstream (ATR units, the 1-10
// score, the bias comparison) would be computed on it and presented with total
// confidence. day_trades rows carry no symbol, so name-matching is impossible;
// the price range is the only evidence available.
//
// 0.5 = the exit must be within +/-50% of the bar range. Deliberately loose:
// neither contract moves anything close to 50% intraday, so this cannot fire on
// a real drift no matter how violent, while the MNQ/MGC confusion sits at ~85%.
// It is a nonsense detector, not a tolerance to be tuned.
const MAX_INSTRUMENT_DEVIATION = 0.5;

const DEFAULTS = {
  thresholdAtr: 0.5,     // drift must exceed this many ATR to earn a direction
  cooldownMinutes: 15,   // matches his own post-trade cooldown rule
  minBars: 2,            // one bar is a tick of noise, not a drift
  windowMinutes: null,   // null = since exit; a number caps how far back to look
};

// NULL IS NOT ZERO. Number(null) === 0 and 0 is finite, so the obvious version
// of this helper turns a missing exit price into a price of zero and then
// happily reports that the market is 29,400 points ABOVE your exit. Fold-only
// rows carry xp:null (see fold-only.js), so that path is reached on any
// unreconciled day. Caught by test/exit-drift.test.js, and it is the same
// mistake the oversize guard's header warns about: "UNKNOWN IS NOT ZERO."
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }

// SECONDS OR MILLISECONDS IN, MILLISECONDS OUT.
//
// This is the bug the module shipped with on 2026-08-31, and it made the whole
// panel invisible rather than wrong — which is why it survived a day unnoticed.
// data_get_ohlcv returns bar stamps in SECONDS ({time: 1788254220, ...}) while
// a trade's exit `x` is an app-internal epoch in MILLISECONDS (1788187088066).
// Compared raw, a ~1.79e9 second stamp is NEVER greater than a ~1.79e12 ms one,
// so every bar failed the `t > exitMs` filter, barsAfter returned 0, and
// computeExitDrift took its `minBars` early-exit and returned UNKNOWN forever.
// The renderer hides the box on UNKNOWN by design, so a fully-wired feature
// rendered nothing and looked like it had never been built.
//
// bar-recorder.js already normalises the same two sources for the same reason.
// These two helpers must agree — if one changes, change both.
function toMs(v) {
  const n = num(v);
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalizeSide(side) {
  const s = String(side || '').toUpperCase();
  if (s === 'LONG' || s === 'BUY' || s === 'B') return 'LONG';
  if (s === 'SHORT' || s === 'SELL' || s === 'S') return 'SHORT';
  return null;
}

/**
 * Bars strictly AFTER the exit. A bar straddling the exit is excluded: part of
 * its range belongs to the trade he was still in, and counting it would credit
 * the drift with movement that happened before he was flat.
 */
function barsAfter(bars, exitMs, windowMinutes, nowMs) {
  const list = Array.isArray(bars) ? bars.filter(Boolean) : [];
  const anchor = toMs(exitMs);
  if (anchor == null) return [];
  // nowMs is threaded through so this stays clock-free, as the header promises.
  // Date.now() survives only as a fallback for a caller that omits it, and is
  // reached only when windowMinutes is set (it is null by default).
  const ref = num(nowMs) != null ? num(nowMs) : Date.now();
  const from = windowMinutes ? Math.max(anchor, ref - windowMinutes * 60000) : anchor;
  return list.filter((b) => {
    const t = toMs(b.t != null ? b.t : b.time);
    return t != null && t > from;
  });
}

// POINTS -> TICKS, ONLY WHEN THE TICK SIZE IS KNOWN.
//
// The tick size is NOT hardcoded here, and must not be. MNQ is 0.25 and MGC is
// 0.10, so a constant would be silently wrong the moment he looks at the other
// symbol he trades — and this module cannot see which symbol is on the chart.
// The caller reads it from TradingView's own symbol_info (minmov/pricescale,
// via point-value-verify.js's tickSizeFrom) and passes it in. When it is
// missing, ticks come back NULL and the panel shows points alone: an absent
// number he can see beats a plausible one derived from a guessed tick size,
// which is the same rule point-value-verify.js's header sets out.
//
// Price and the exit are both tick-aligned, so the quotient is a whole number
// of ticks; it is rounded to kill float dust (195 / 0.25 landing on 779.9999).
function toTicks(points, tickSize) {
  const p = num(points), ts = num(tickSize);
  if (p == null || ts == null || ts <= 0) return null;
  return Math.round(p / ts);
}

/**
 * @param {object} opts
 *   lastTrade {x, xp, side}   the last COMPLETED trade
 *   bars      [{t,o,h,l,c}]   bars covering exit -> now
 *   atr       number          ATR in points on the same timeframe as `bars`
 *   tickSize  number|null     from symbol_info; null = report points only
 *   nowMs     number
 *   cfg       partial DEFAULTS
 */
function computeExitDrift(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, o.cfg || {});
  const t = o.lastTrade || null;
  const nowMs = num(o.nowMs) != null ? num(o.nowMs) : null;

  const base = {
    verdict: VERDICT.UNKNOWN, quality: QUALITY.UNKNOWN,
    exitPrice: null, lastPrice: null, side: null,
    maxUp: null, maxDown: null, netDrift: null, atrUnits: null,
    // Tick readings ride alongside the point readings on every path, null
    // whenever the tick size was not supplied. See toTicks above.
    tickSize: null, ticks: null, maxUpTicks: null, maxDownTicks: null,
    minutesSince: null, barsUsed: 0, reason: null,
    // How much of the "since your exit" window the bars ACTUALLY cover.
    // Declared on every path for the same reason `strength` is.
    coverageMinutes: null, partialCoverage: false,
    // Explicitly null on EVERY path, not just the scored one: a consumer testing
    // `strength === null` must not be defeated by an undefined from an early return.
    strength: null,
    // WHICH INSTRUMENT the reading is anchored on (2026-09-21). The panel
    // converts the drift to dollars, and the point value is per-contract —
    // MNQ $2 against MGC $10 — so the reader cannot pick the right multiplier
    // without knowing what the exit was. Passed through from the caller, which
    // is the only party that can read it off the chart; null (not a guessed
    // default) when it is unknown, so the consumer can label its fallback
    // instead of presenting an assumption as a fact.
    symbol: o.symbol != null ? String(o.symbol) : null,
  };

  if (!t) return Object.assign(base, { reason: 'No completed trade on record yet.' });

  const exitPrice = num(t.xp);
  const exitMs = toMs(t.x);
  if (exitPrice == null || exitMs == null) {
    return Object.assign(base, {
      reason: 'The last trade has no recorded exit price — that day was reconstructed from '
        + 'balance moves, so there is nothing to measure drift from. Reconcile it first.',
    });
  }

  const side = normalizeSide(t.side);
  const minutesSince = nowMs != null ? Math.max(0, Math.round((nowMs - exitMs) / 60000)) : null;
  const used = barsAfter(o.bars, exitMs, cfg.windowMinutes, nowMs);

  if (used.length < cfg.minBars) {
    return Object.assign(base, {
      exitPrice, side, minutesSince, barsUsed: used.length,
      reason: 'Only ' + used.length + ' bar(s) since the exit — not enough to call a drift yet.',
    });
  }

  let hi = -Infinity, lo = Infinity, lastClose = null;
  used.forEach((b) => {
    const h = num(b.h != null ? b.h : b.high);
    const l = num(b.l != null ? b.l : b.low);
    const c = num(b.c != null ? b.c : b.close);
    if (h != null && h > hi) hi = h;
    if (l != null && l < lo) lo = l;
    if (c != null) lastClose = c;
  });
  if (lastClose == null || !Number.isFinite(hi) || !Number.isFinite(lo)) {
    return Object.assign(base, { exitPrice, side, minutesSince, barsUsed: used.length, reason: 'Bars unreadable.' });
  }

  // COVERAGE IS MEASURED, NOT ASSUMED. runExitDrift asks for a fixed 120 bars,
  // which on a 1m chart is ~2 hours — but the exit it anchors on can be days
  // old. maxUp/maxDown are then a range over the bars we HAPPEN to hold while
  // being labelled "since your exit", which is a confident wrong answer of
  // exactly the kind the trust protocol exists to stop. netDrift is unaffected
  // (it only needs the latest close), so the fix is to report the true window
  // and let the caller label it, not to suppress the reading.
  const barStamps = (Array.isArray(o.bars) ? o.bars : [])
    .map((b) => (b ? toMs(b.t != null ? b.t : b.time) : null))
    .filter((n) => n != null);
  const firstBarMs = barStamps.length ? Math.min.apply(null, barStamps) : null;
  const lastBarMs = barStamps.length ? Math.max.apply(null, barStamps) : null;
  // TOLERANCE OF ONE BAR. Bars are discrete, so the first bar after an exit is
  // ALWAYS at least one interval later — testing `firstBar > exitMs` alone
  // would flag every healthy read as partial and put a caveat on the panel
  // permanently, which trains him to ignore it. Coverage is only short when the
  // gap exceeds a couple of bars, so the spacing is inferred from the data
  // rather than assumed from a timeframe string we may not have.
  const sorted = barStamps.slice().sort((x, y) => x - y);
  let spacing = null;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && (spacing == null || gap < spacing)) spacing = gap;
  }
  const tolerance = spacing != null ? spacing * 2 : 0;
  const partialCoverage = firstBarMs != null && (firstBarMs - exitMs) > tolerance;
  const coverageMinutes = partialCoverage
    ? Math.max(0, Math.round((lastBarMs - firstBarMs) / 60000))
    : minutesSince;

  // Refuse before any arithmetic that would treat two instruments as one.
  const mid = (hi + lo) / 2;
  if (mid > 0 && Math.abs(exitPrice - mid) / mid > MAX_INSTRUMENT_DEVIATION) {
    return Object.assign(base, {
      exitPrice, side, minutesSince, barsUsed: used.length,
      verdict: VERDICT.MISMATCH,
      reason: 'Your last exit was at ' + exitPrice + ' but the chart is showing '
        + (o.symbol ? o.symbol + ' ' : '') + 'around ' + round2(mid)
        + ' — that is a different instrument, so there is no drift to measure. '
        + 'Switch the chart back to the contract you traded.',
    });
  }

  const maxUp = round2(hi - exitPrice);
  const maxDown = round2(exitPrice - lo);
  const netDrift = round2(lastClose - exitPrice);
  const atr = num(o.atr);
  const atrUnits = atr && atr > 0 ? round2(netDrift / atr) : null;

  const tickSize = num(o.tickSize);
  const out = Object.assign(base, {
    exitPrice, lastPrice: lastClose, side, maxUp, maxDown, netDrift, atrUnits,
    minutesSince, barsUsed: used.length, coverageMinutes, partialCoverage,
    tickSize: tickSize != null && tickSize > 0 ? tickSize : null,
    ticks: toTicks(netDrift, tickSize),
    maxUpTicks: toTicks(maxUp, tickSize),
    maxDownTicks: toTicks(maxDown, tickSize),
  });

  // Cooldown wins over everything. Checked AFTER computing so the numbers are
  // available to a post-session view, but the verdict is withheld live.
  if (minutesSince != null && minutesSince < cfg.cooldownMinutes) {
    return Object.assign(out, {
      verdict: VERDICT.COOLING, quality: QUALITY.UNKNOWN,
      reason: 'Only ' + minutesSince + ' min since the exit — inside your ' + cfg.cooldownMinutes
        + '-minute cooldown. Showing you what you left on the table right now is how a re-entry starts.',
    });
  }

  // Direction, gated on magnitude. Without an ATR there is no honest threshold,
  // so the module declines rather than falling back to a hardcoded point value
  // that would mean different things in different regimes.
  if (atrUnits == null) {
    return Object.assign(out, { verdict: VERDICT.NO_READ, quality: QUALITY.NEUTRAL, reason: 'No ATR supplied — cannot judge whether this drift is meaningful.' });
  }
  if (Math.abs(atrUnits) < cfg.thresholdAtr) {
    return Object.assign(out, {
      verdict: VERDICT.NO_READ, quality: QUALITY.NEUTRAL,
      reason: 'Drift is ' + Math.abs(atrUnits) + ' ATR, under the ' + cfg.thresholdAtr
        + ' ATR threshold. That is noise, not a direction.',
    });
  }

  out.verdict = netDrift > 0 ? VERDICT.ABOVE : VERDICT.BELOW;

  // Exit quality reads the SAME drift against the side he was in.
  if (side === 'LONG') out.quality = netDrift > 0 ? QUALITY.EARLY : QUALITY.WELL;
  else if (side === 'SHORT') out.quality = netDrift < 0 ? QUALITY.EARLY : QUALITY.WELL;
  else out.quality = QUALITY.UNKNOWN;

  // Scored only now that a real verdict exists.
  out.strength = scoreDrift(out, used);

  out.reason = 'Price is ' + Math.abs(netDrift) + ' pts ' + (netDrift > 0 ? 'above' : 'below')
    + ' your exit (' + Math.abs(atrUnits) + ' ATR) ' + (minutesSince != null ? minutesSince + ' min after it.' : '.');
  return out;
}

/**
 * One line for the UI / coach. Deliberately states the exit-quality reading
 * BEFORE the direction: exit quality is about a decision he already made and
 * can learn from, while direction is a hint about a trade he has not taken yet.
 * Leading with the hint is what turns this into a trade suggestion, which it
 * is explicitly not.
 */
function formatExitDrift(d) {
  if (!d) return null;
  if (d.verdict === VERDICT.UNKNOWN) return d.reason;
  if (d.verdict === VERDICT.MISMATCH) return d.reason;
  if (d.verdict === VERDICT.COOLING) return 'Post-exit read held back — ' + d.reason;
  if (d.verdict === VERDICT.NO_READ) return 'No read since your last exit: ' + d.reason;
  const q = d.quality === QUALITY.EARLY
    ? 'it kept going your way after you closed — you left ' + Math.abs(d.netDrift) + ' pts on the table'
    : d.quality === QUALITY.WELL
      ? 'it turned against the trade after you closed — the exit protected you'
      : 'side unknown, so exit quality cannot be judged';
  const dist = Math.abs(d.netDrift) + ' pts'
    + (d.ticks != null ? ' / ' + Math.abs(d.ticks) + ' ticks' : '');
  return 'Since your last exit at ' + d.exitPrice + ': ' + q + '. Price now sits '
    + (d.verdict === VERDICT.ABOVE ? 'ABOVE' : 'BELOW') + ' that exit by ' + dist
    + ' (' + Math.abs(d.atrUnits) + ' ATR). '
    + (d.partialCoverage
        ? 'Range over the last ' + d.coverageMinutes + ' min (bars do not reach back to the exit): +'
        : 'Range since: +')
    + d.maxUp + ' / -' + d.maxDown + '.';
}

/**
 * ATR in points, from the bars themselves.
 *
 * Computed here rather than read off the chart so the threshold and the drift
 * always come from the SAME bars on the SAME timeframe. Sourcing ATR from a
 * chart indicator while measuring drift on a different series is how a
 * threshold silently stops meaning what it says.
 *
 * True range includes the gap from the previous close, so an overnight or
 * news gap widens the threshold instead of being counted as a free drift.
 * Returns null on too little data — never a default, because a made-up ATR
 * would make every drift look significant or none of them.
 */
/**
 * STRENGTH 1-10, from how the candles actually moved.
 *
 * A score that is just rescaled ATR would add precision it does not have, so
 * this reads three DIFFERENT things off the same bars. They disagree often,
 * which is the point — a big move that chopped the whole way is not the same
 * event as a small clean one, and one number that ignores the difference is
 * worse than no number.
 *
 *   MAGNITUDE   (50%) how far, in ATR. 2 ATR earns full marks; beyond that
 *                     the extra distance says little the first 2 did not.
 *   EFFICIENCY  (30%) |net| / total travel (maxUp + maxDown). 1.0 means every
 *                     point of movement became progress; 0.2 means price went
 *                     a long way and came back — travel without direction.
 *   CONSISTENCY (20%) share of bars that closed further along the drift. A run
 *                     of same-way closes is a different event from one gap and
 *                     then nothing, even at identical net drift.
 *
 * WHAT IT IS NOT: a probability, a confidence level, or a reason to size up.
 * It scores what price DID after the exit — not what it will do next. Nothing
 * here has been backtested against whether the next trade wins.
 *
 * Returns null whenever the verdict is not a real read. A "3/10" printed over
 * noise claims more than NO_READ does, and manufacturing that precision is the
 * exact failure this module was built to avoid.
 */
function scoreDrift(d, bars) {
  if (!d || (d.verdict !== VERDICT.ABOVE && d.verdict !== VERDICT.BELOW)) return null;
  const net = num(d.netDrift);
  const atrU = num(d.atrUnits);
  const up = num(d.maxUp), down = num(d.maxDown);
  if (net == null || atrU == null) return null;

  const magnitude = Math.min(1, Math.abs(atrU) / 2);

  // Total travel is the full post-exit range. Both halves are stored as
  // positive distances from the exit, so they add rather than cancel.
  const travel = (up != null ? Math.max(0, up) : 0) + (down != null ? Math.max(0, down) : 0);
  const efficiency = travel > 0 ? Math.min(1, Math.abs(net) / travel) : 0;

  // Consistency walks closes, not highs: a wick that pokes the right way and
  // closes back is the market rejecting that direction, not confirming it.
  const list = (Array.isArray(bars) ? bars : []).filter(Boolean);
  let moved = 0, counted = 0;
  for (let i = 1; i < list.length; i++) {
    const c = num(list[i].c != null ? list[i].c : list[i].close);
    const p = num(list[i - 1].c != null ? list[i - 1].c : list[i - 1].close);
    if (c == null || p == null || c === p) continue;
    counted++;
    if ((net > 0 && c > p) || (net < 0 && c < p)) moved++;
  }
  const consistency = counted ? moved / counted : 0;

  const raw = 0.5 * magnitude + 0.3 * efficiency + 0.2 * consistency;
  // Floor of 1: this only runs when there IS a read, and a 0 would read as
  // "nothing happened" when the threshold has already been cleared.
  const score = Math.max(1, Math.min(10, Math.round(raw * 10)));
  return {
    score,
    magnitude: round2(magnitude), efficiency: round2(efficiency), consistency: round2(consistency),
    label: score >= 8 ? "decisive" : score >= 6 ? "clear" : score >= 4 ? "modest" : "weak",
    basis: "magnitude " + round2(magnitude) + " / efficiency " + round2(efficiency)
      + " / consistency " + round2(consistency) + " — scores the move that HAPPENED, not the next trade",
  };
}
function atrFromBars(bars, period) {
  const list = (Array.isArray(bars) ? bars : []).filter(Boolean);
  const p = num(period) || 14;
  if (list.length < 2) return null;
  const tr = [];
  for (let i = 1; i < list.length; i++) {
    const h = num(list[i].h != null ? list[i].h : list[i].high);
    const l = num(list[i].l != null ? list[i].l : list[i].low);
    const pc = num(list[i - 1].c != null ? list[i - 1].c : list[i - 1].close);
    if (h == null || l == null) continue;
    tr.push(pc == null ? h - l : Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!tr.length) return null;
  const use = tr.slice(-p);
  return round2(use.reduce((a, b) => a + b, 0) / use.length);
}

module.exports = { computeExitDrift, formatExitDrift, scoreDrift, atrFromBars, barsAfter, normalizeSide, toMs, toTicks, VERDICT, QUALITY, DEFAULTS };
