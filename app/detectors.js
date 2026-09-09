'use strict';
// ── Bar-pattern detectors — extracted from server.js 2026-08-26 ─────────────
// The four functions every watcher fires on, lifted verbatim out of
// server.js so they can be run somewhere other than a live TradingView
// connection. Same reason amd-phase.js and playbook-c.js were extracted:
// pure arithmetic on bars, directly testable here in a way it never would be
// inline in a 487KB file that requires the whole world at load time.
//
// WHY THIS EXTRACTION WAS THE BLOCKER — you cannot backtest a detector you
// cannot import. Before this, "do my playbooks actually work?" was
// unanswerable in principle, not just unanswered: `detectFVGFromBars` lived
// at server.js:4603 alongside `require('ws')`, the Anthropic SDK, the
// Telegram bridge and the MCP child-process spawner, so any harness wanting
// to replay it over history had to either boot the entire trading server or
// REIMPLEMENT the detector — and a reimplemented detector proves nothing
// about the one that actually fires. scripts/backtest-playbooks.js imports
// these; so does the live server. One definition, two callers, no drift.
//
// VERBATIM. Nothing about the logic changed in this move except
// detectSFPFromBars now also returns the sweeping bar's `wick` (see its own
// note) — every threshold, tolerance and comparison is byte-for-byte what
// was firing before. Behaviour changes belong in their own commit, where a
// bad one is visible; smuggling them into a move is how a refactor becomes
// an outage on a live-money account.

// Full-range engulfing per Playbook C: the current bar must take out BOTH the
// high AND the low of the previous bar (not just overlap its open/close body,
// which is what the old body-only check did). Direction must also be the
// opposite of the previous bar's direction.
//
// 2026-08-27 — BODY ENGULF IS NOW ALSO REQUIRED, and the two conditions are
// not redundant in the direction you'd assume. Range engulf (high/low) does
// NOT imply body engulf: a candle with long wicks can take out both extremes
// of the previous bar while its own open→close body sits entirely inside the
// previous body. That is a wide indecision candle, not a reversal, and it was
// firing alerts. Anoop asked for the body to be engulfed fully, so both are
// checked: the range must be taken out AND this body must cover that body.
function bodyEngulfs(prev, curr) {
  const pTop = Math.max(prev.open, prev.close), pBot = Math.min(prev.open, prev.close);
  const cTop = Math.max(curr.open, curr.close), cBot = Math.min(curr.open, curr.close);
  return cTop >= pTop && cBot <= pBot;
}

function detectEngulfFromBars(bars) {
  // Array.isArray, NOT `!bars || bars.length < 2`. Found by Protocol 1's
  // stress pass on 2026-08-28: a non-array such as {} has no .length, so
  // `undefined < 2` is false, the guard was bypassed, and the next line threw
  // on bars[-1].open. Every caller passes an array today — which is exactly
  // why this survived unnoticed until something fed it garbage on purpose.
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  if ([prev.open, prev.close, prev.high, prev.low, curr.open, curr.close, curr.high, curr.low].some(v => typeof v !== 'number')) return null;

  const rangeEngulf = curr.high >= prev.high && curr.low <= prev.low;
  if (!rangeEngulf || !bodyEngulfs(prev, curr)) return null;

  if (prev.close < prev.open && curr.close > curr.open) return { direction: 'BULLISH' };
  if (prev.close > prev.open && curr.close < curr.open) return { direction: 'BEARISH' };
  return null;
}

// Bar-over-bar higher-high/higher-low majority vote. NOT a real swing-pivot
// market-structure read — see get4HTrend's comment in server.js for the full
// caveat, and classifyStructureFromPivots() below for the real one.
//
// ── DO NOT WIDEN THE WINDOW YOU FEED THIS (2026-09-01) ────────────────────
// The 60% threshold counts CONSECUTIVE bar-to-bar transitions, so its
// strictness scales with the window. At the 5 bars get4HTrend passes it, that
// is 3 of 4 transitions — a reasonable majority vote. At 39 bars it demands 23
// of 38 consecutive higher highs AND 23 higher lows, which real price action
// almost never produces: measured on 1,037 real MNQ 1H bars it reads clearly
// 42.7% of the time at 5 bars but only 21.1% at 39.
//
// This was found live. The HTF gate was briefly wired to call this with 39
// bars, which drove it to `htf-1h-unclear` on 78% of all blocks — the app
// failing to read structure, wearing the costume of a rule refusing a trade.
// Use classifyStructureFromPivots() for any structure read on a real window.
function classifyTrendFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return 'unclear';
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].high > bars[i - 1].high) higherHighs++;
    else if (bars[i].high < bars[i - 1].high) lowerHighs++;
    if (bars[i].low > bars[i - 1].low) higherLows++;
    else if (bars[i].low < bars[i - 1].low) lowerLows++;
  }
  const n = bars.length - 1;
  const threshold = Math.ceil(n * 0.6);
  if (higherHighs >= threshold && higherLows >= threshold) return 'bullish';
  if (lowerHighs >= threshold && lowerLows >= threshold) return 'bearish';
  return 'unclear';
}

// ── Swing-pivot market structure ──────────────────────────────────────────
// Moved here from playbook-c.js on 2026-09-01 so the HTF gate and Playbook C
// read structure through ONE definition. The gate sits above every playbook,
// so it must not import one; both now import this.
//
// PIVOT_LEG/LEVEL_TOL live here for the same reason — playbook-c.js re-imports
// them under its old PBC_* names, so the tolerance findPivots collapses on and
// the tolerance Playbook C's retest checks use can never drift apart.
const PIVOT_LEG = 2;         // bars each side for a confirmed fractal pivot
// LEVEL_TOL = 0.05%. At the last cached 15M close (29,569.25) that is ~14.8 MNQ
// points ≈ $29.57/contract — 1.85× rules.json's own minRiskPoints (8) and 4.9×
// stopBufferPoints (3). Calibrated on the 1H and INHERITED by the 15M. Do NOT
// change the value without re-running the structure-classifier sweep: the
// tolerance response is non-monotonic (0.0004 → 73.8%, 0.0005 → 70.6%,
// 0.0006 → 73.0%) and the dataset cannot support tuning it.
const LEVEL_TOL = 0.0005;

// Confirmed fractal pivots WITH their bar index. getSwingLevels() returns
// prices only, which is enough for the SFP level pool but not for reading
// structure (which needs to know the ORDER pivots occurred in).
//
// Strict on the left, inclusive on the right, is the standard way to
// disambiguate a plateau. Without it, two adjacent bars sharing the same high
// BOTH register as pivots, the structure check then compares two equal prices,
// `h2 > h1` is false, and every flat-topped move is misread as "mixed/ranging".
// Equal highs are common in futures, so this mattered immediately in testing.
// Near-equal consecutive pivots are then collapsed to one (the later).
function findPivots(bars, leg = PIVOT_LEG) {
  const highs = [], lows = [];
  for (let i = leg; i < bars.length - leg; i++) {
    const left = bars.slice(i - leg, i);
    const right = bars.slice(i + 1, i + leg + 1);
    if (left.every(b => bars[i].high > b.high) && right.every(b => bars[i].high >= b.high)) {
      highs.push({ i, price: bars[i].high });
    }
    if (left.every(b => bars[i].low < b.low) && right.every(b => bars[i].low <= b.low)) {
      lows.push({ i, price: bars[i].low });
    }
  }
  const collapse = (arr) => arr.filter((p, k) =>
    k === arr.length - 1 || Math.abs(arr[k + 1].price - p.price) / p.price >= LEVEL_TOL);
  return { pivotHighs: collapse(highs), pivotLows: collapse(lows) };
}

// HH-HL / LL-LH read off confirmed swing pivots — "higher high, higher low"
// in the sense Anoop actually means it: the last two swing highs ascending AND
// the last two swing lows ascending, not a count of consecutive candles.
//
// Returns the same vocabulary as classifyTrendFromBars ('bullish' | 'bearish'
// | 'unclear') so it is a drop-in for callers that read structure.
//
// Fewer than two pivots each side is 'unclear', never a guess: with one swing
// high there is nothing to compare it to, and answering anyway is how a gate
// starts inventing a trend out of a flat chart.
function classifyStructureFromPivots(bars) {
  if (!Array.isArray(bars) || bars.length < PIVOT_LEG * 2 + 1) return 'unclear';
  const { pivotHighs, pivotLows } = findPivots(bars);
  if (pivotHighs.length < 2 || pivotLows.length < 2) return 'unclear';
  const h1 = pivotHighs[pivotHighs.length - 2].price;
  const h2 = pivotHighs[pivotHighs.length - 1].price;
  const l1 = pivotLows[pivotLows.length - 2].price;
  const l2 = pivotLows[pivotLows.length - 1].price;
  if (h2 > h1 && l2 > l1) return 'bullish';
  if (h2 < h1 && l2 < l1) return 'bearish';
  return 'unclear';
}

// Classic 3-candle gap: bar[i-2] and bar[i] leave a price range bar[i-1]
// never traded into. Bullish FVG when bar[i-2].high < bar[i].low (gap up);
// bearish when bar[i-2].low > bar[i].high (gap down). This detects the gap
// EXISTING — it does not confirm the SFP/liquidity-raid that must precede it
// per the full JadeCap playbook. checkSFPSignal pairs the two.
function detectFVGFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  const a = bars[bars.length - 3];
  const c = bars[bars.length - 1];
  if ([a.high, a.low, c.high, c.low].some(v => typeof v !== 'number')) return null;

  if (a.high < c.low) return { direction: 'BULLISH', gapLow: a.high, gapHigh: c.low };
  if (a.low > c.high) return { direction: 'BEARISH', gapLow: c.high, gapHigh: a.low };
  return null;
}

// The three most recent distinct 5-bar fractal highs/lows — the liquidity
// pool an SFP is checked against. Near-equal levels collapse to the most
// recent (0.05%, the same tolerance playbook-c.js dedupes pivots on).
function getSwingLevels(bars) {
  if (!Array.isArray(bars)) return { swingHighs: [], swingLows: [] };
  const highs = [], lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const w = bars.slice(i - 2, i + 3);
    if (bars[i].high === Math.max(...w.map(b => b.high))) highs.push(bars[i].high);
    if (bars[i].low === Math.min(...w.map(b => b.low))) lows.push(bars[i].low);
  }
  const dedupeMostRecent = (arr) => {
    const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 3; i--) {
      const v = arr[i];
      if (!out.some(o => Math.abs(o - v) / v < LEVEL_TOL)) out.push(v);
    }
    return out;
  };
  return { swingHighs: dedupeMostRecent(highs), swingLows: dedupeMostRecent(lows) };
}

// SFP (swing failure pattern) / liquidity raid: the latest bar wicks through
// a key level and closes back on the other side of it — the "trap candle."
// Checked against every level in the pool; first match wins.
//
// ADDED 2026-08-26: `wick` — the extreme the sweep actually reached. Playbook
// B's stop is "beyond the SFP wick" (Prop Trading/CLAUDE.md), and the monitor
// was only ever keeping the swept LEVEL. Those are different prices: the
// level is where the stops rested, the wick is how far past them price ran.
// Stopping at the level puts the stop inside the trap the setup is built on,
// which is the one place it is most likely to be hit before the trade works.
// The level is still returned unchanged — nothing that read it before
// changes behaviour.
function detectSFPFromBars(bars, levels) {
  if (!Array.isArray(bars) || bars.length < 1) return null;
  const curr = bars[bars.length - 1];
  if ([curr.high, curr.low, curr.close].some(v => typeof v !== 'number')) return null;

  for (const level of (levels && levels.highs) || []) {
    if (typeof level === 'number' && curr.high > level && curr.close < level) {
      return { direction: 'BEARISH', level, wick: curr.high };
    }
  }
  for (const level of (levels && levels.lows) || []) {
    if (typeof level === 'number' && curr.low < level && curr.close > level) {
      return { direction: 'BULLISH', level, wick: curr.low };
    }
  }
  return null;
}

// ── Wilder ADX / DI (added 2026-08-26) ─────────────────────────────────────
// The regime filter DSH's V2 strategy is built on, and the first thing in this
// repo that reliably distinguishes "trending" from "chop" ahead of time. Their
// six backtest rounds concluded that no unfiltered breakout rule is
// regime-independent — breakouts win in trends and lose in ranges — and that
// ADX was the only filter that separated the two well enough to matter.
//
// CAUSAL BY CONSTRUCTION: index i depends only on bars 0..i. That matters more
// here than usual, because computing an indicator over the whole array and then
// indexing it inside a backtest loop is the standard way look-ahead sneaks into
// a multi-indicator strategy. Wilder smoothing is recursive on the previous
// value only, so this is safe to precompute — but only because it is written
// this way. Values before index period*2 are NaN, never 0: a comparison like
// `adx[i] >= 35` must read as false during warm-up, and 0 would do that by
// accident while NaN does it on purpose.
//
// Returns { adx, plusDI, minusDI }, each an array parallel to `bars`.
function adxSeries(bars, period = 14) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const adx = new Array(n).fill(NaN), plusDI = new Array(n).fill(NaN), minusDI = new Array(n).fill(NaN);
  if (n < period * 2 + 1) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = bars[i], b = bars[i - 1];
    if (!a || !b || typeof a.high !== 'number' || typeof a.low !== 'number' || typeof b.close !== 'number') {
      return { adx, plusDI, minusDI };   // one bad bar poisons the whole series — refuse it, per TRUST-PROTOCOL Rule 1
    }
    const up = a.high - b.high, dn = b.low - a.low;
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close));
  }

  const dx = new Array(n).fill(NaN);
  let atr = 0, pd = 0, md = 0;
  for (let i = 1; i <= period; i++) { atr += tr[i]; pd += pDM[i]; md += mDM[i]; }
  const setDI = (i) => {
    plusDI[i] = atr > 0 ? 100 * pd / atr : 0;
    minusDI[i] = atr > 0 ? 100 * md / atr : 0;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / sum : 0;
  };
  setDI(period);
  let dxSum = 0;
  for (let i = period + 1; i <= period * 2; i++) {
    atr = atr - atr / period + tr[i]; pd = pd - pd / period + pDM[i]; md = md - md / period + mDM[i];
    setDI(i); dxSum += dx[i];
  }
  adx[period * 2] = dxSum / period;
  for (let i = period * 2 + 1; i < n; i++) {
    atr = atr - atr / period + tr[i]; pd = pd - pd / period + pDM[i]; md = md - md / period + mDM[i];
    setDI(i);
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx, plusDI, minusDI };
}

// Highest high of the `lookback` bars ENDING BEFORE index i. Excluding bar i
// is the whole point — a breakout must clear a level that existed before the
// bar that broke it, or every strong bar trivially "breaks out" of itself.
function priorHigh(bars, i, lookback) {
  if (!Array.isArray(bars) || i - lookback < 0) return null;
  let hi = -Infinity;
  for (let k = i - lookback; k < i; k++) {
    const v = bars[k] && bars[k].high;
    if (typeof v !== 'number') return null;
    if (v > hi) hi = v;
  }
  return Number.isFinite(hi) ? hi : null;
}

// ── Playbook C (ADX) breakout — the four gates, as one decision ────────────
// Added 2026-09-01 so the strategy in "DSH backtesting/" can be FORWARD
// TESTED. adxSeries() and priorHigh() already existed and were used only by
// the offline backtests; this composes them into the single yes/no the live
// monitor needs, so the live path and the backtest cannot drift apart by
// re-implementing the same four conditions twice.
//
// The four gates, per the playbook (all must hold at the CLOSED bar):
//   1. ADX(period) >= adxMin        — strong trend, not chop
//   2. +DI > -DI                    — the strong trend is UP
//   3. close > priorHigh(lookback)  — fresh breakout, prior bars only
//   4. close > open                 — the breakout candle is bullish
//
// LONG ONLY. There is deliberately no bearish mirror: shorting breakdowns lost
// money in every regime DSH tested, including clean downtrends, and a
// symmetrical detector would be the easiest possible way to reintroduce that.
//
// ── WHY IT EVALUATES bars[n-2] AND NOT bars[n-1] ──────────────────────────
// Every gate is defined "at the 1H candle CLOSE". A live chart's last bar is
// still FORMING: its close, high and open all move until the hour ends, so a
// bar that passes at :17 can fail by :59. Scoring the forming bar would record
// signals that never existed — the same repaint that makes a backtest lie,
// except live and unfalsifiable. The last CLOSED bar is index n-2.
//
// Returns null when there is no signal or not enough data to judge one — never
// a partial or a guess (TRUST-PROTOCOL Rule 1). On a signal it returns the
// gate VALUES, not just `true`, so a recorded row can be audited later against
// the bars it claims to have read.
function detectAdxBreakoutFromBars(bars, opts) {
  const o = opts || {};
  const period = Number.isFinite(o.period) ? o.period : 14;
  const adxMin = Number.isFinite(o.adxMin) ? o.adxMin : 35;
  const lookback = Number.isFinite(o.lookback) ? o.lookback : 10;
  if (!Array.isArray(bars)) return null;

  // Need warm-up for ADX (2*period+1) plus the lookback window plus the
  // forming bar we are about to ignore. Short of that, refuse.
  const need = period * 2 + 2 + lookback;
  if (bars.length < need) return null;

  const i = bars.length - 2;              // the last CLOSED bar
  const bar = bars[i];
  if (!bar) return null;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!fin(bar.open) || !fin(bar.high) || !fin(bar.low) || !fin(bar.close)) return null;

  const { adx, plusDI, minusDI } = adxSeries(bars, period);
  const a = adx[i], pdi = plusDI[i], mdi = minusDI[i];
  // NaN during warm-up, and NaN fails every comparison — which is the correct
  // reading of "we do not know yet", not "not trending".
  if (!fin(a) || !fin(pdi) || !fin(mdi)) return null;

  const ph = priorHigh(bars, i, lookback);
  if (!fin(ph)) return null;

  if (!(a >= adxMin)) return null;        // gate 1
  if (!(pdi > mdi)) return null;          // gate 2
  if (!(bar.close > ph)) return null;     // gate 3
  if (!(bar.close > bar.open)) return null; // gate 4

  return {
    playbook: 'C-ADX',
    direction: 'BULLISH',
    bar: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, time: bar.time },
    barTime: bar.time,
    entryRef: bar.close,
    adx: Math.round(a * 10) / 10,
    plusDI: Math.round(pdi * 10) / 10,
    minusDI: Math.round(mdi * 10) / 10,
    priorHigh: ph,
    lookback,
    adxMin,
  };
}

module.exports = {
  adxSeries,
  priorHigh,
  detectAdxBreakoutFromBars,
  detectEngulfFromBars,
  bodyEngulfs,
  classifyTrendFromBars,
  classifyStructureFromPivots,
  findPivots,
  PIVOT_LEG,
  LEVEL_TOL,
  detectFVGFromBars,
  getSwingLevels,
  detectSFPFromBars,
};
