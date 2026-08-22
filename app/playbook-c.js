'use strict';
// ── PLAYBOOK C — ENGULFING BAR VALIDITY (no AI) — added 2026-08-22 ───────────
// Playbook C has existed as prose in claude-agent.js's SHARED_RULES since the
// beginning, so it applied whenever Anoop asked an agent — and NOWHERE in the
// monitors that actually fire his alerts. `detectEngulfFromBars()` in server.js
// checks exactly one of the rulebook's four conditions (the full-range engulf),
// and the two it omits are the two that separate a reversal from an ordinary
// continuation candle mid-trend. The engulf monitor therefore alerts on candles
// Anoop's own rulebook disqualifies, with nothing indicating the check was
// skipped.
//
// The rulebook, verbatim from SHARED_RULES:
//   Bullish valid: forms at a swing low in an HH-HL pattern, closes above the
//   previous candle, takes out BOTH the low AND the high of the previous candle.
//   NEVER take a bullish engulfing AFTER buy-side liquidity has already been
//   swept. (Bearish mirrors: swing high, LL-LH, never after sell-side swept.)
//
// Extracted as its own module for the same reason amd-phase.js was: it is pure
// arithmetic on bars, it is the gate every engulf alert depends on, and it is
// directly unit-testable here in a way it never would be inline in server.js.
//
// WHERE JUDGMENT WAS APPLIED — these are the tunable parts. Watch the
// rejection reasons in the UI before changing any of them:
//   1. "Forms at a swing low" — the engulfing candle is the newest closed bar,
//      so it cannot be a CONFIRMED fractal pivot yet (that needs PIVOT_LEG bars
//      after it). Operationalised as: its low is the lowest of the last
//      PIVOT_WINDOW bars, OR it retests a confirmed pivot low within LEVEL_TOL.
//   2. "HH-HL pattern" — last two confirmed pivot highs ascending AND last two
//      confirmed pivot lows ascending. Fewer than two of either = structure
//      unknown = reject. Deliberately strict; too strict is the safe direction
//      to err, because a missed alert costs a trade and a false one costs money.
//   3. "Liquidity already swept" — means TAKEN AND REJECTED (wick through, close
//      back on the original side), the same trap-candle shape detectSFPFromBars
//      already encodes. See the long note on requirement 5 for why the naive
//      reading of this rule is self-contradictory.

const PBC_PIVOT_LEG = 2;        // bars each side for a confirmed fractal pivot
const PBC_PIVOT_WINDOW = 5;     // "is this the local extreme" window
const PBC_LIQ_LOOKBACK = 10;    // how far back a sweep still counts as recent
const PBC_LEVEL_TOL = 0.0005;   // 0.05% — same tolerance getSwingLevels dedupes on
const PBC_HISTORY_BARS = 40;    // bars the caller should fetch (5 is not enough)

// Drop the still-forming candle.
//
// The last bar any OHLCV source returns is usually still live and updating, so
// evaluating it re-reads a high/low/close that is still moving. checkSFPSignal
// fixed this for itself on 2026-07-15 (it was firing a "new" liquidity raid on
// nearly every poll); the engulf and FVG monitors were never given the same fix
// and repaint the same way — an engulf can appear at minute 3 of a 15m candle
// and be gone by the close. This is that fix, shared.
//
// tfCode is the TradingView resolution ('15','30','60','D'...). Only intraday
// minute codes can be bar-aligned this way; for anything non-numeric the bar
// duration is not a fixed minute count, so the array is returned untouched
// rather than guessing wrong and silently discarding real data.
function dropFormingBar(bars, tfCode) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const minutes = parseInt(tfCode, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return bars;
  const last = bars[bars.length - 1];
  if (!last || typeof last.time !== 'number') return bars;
  // bar.time may be unix seconds or ms depending on source — same defensive
  // treatment barTimeToDate() already uses in server.js.
  const startSec = last.time > 1e12 ? Math.floor(last.time / 1000) : last.time;
  const nowSec = Math.floor(Date.now() / 1000);
  return (startSec + minutes * 60 > nowSec) ? bars.slice(0, -1) : bars;
}

// Confirmed fractal pivots WITH their bar index. server.js's getSwingLevels()
// returns prices only, which is enough for the SFP level pool but not for
// reading structure (which needs to know the ORDER pivots occurred in).
//
// Strict on the left, inclusive on the right, is the standard way to
// disambiguate a plateau. Without it, two adjacent bars sharing the same high
// BOTH register as pivots, the structure check then compares two equal prices,
// `h2 > h1` is false, and every flat-topped move is misread as "mixed/ranging".
// Equal highs are common in futures, so this mattered immediately in testing.
// Near-equal consecutive pivots are then collapsed to one (the later).
function findPivots(bars, leg = PBC_PIVOT_LEG) {
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
    k === arr.length - 1 || Math.abs(arr[k + 1].price - p.price) / p.price >= PBC_LEVEL_TOL);
  return { pivotHighs: collapse(highs), pivotLows: collapse(lows) };
}

// Returns { valid, reason, structure }.
//
// `reason` is surfaced in the UI on rejection rather than swallowed — seeing
// WHICH candles get disqualified, and why, is how the thresholds above get
// tuned from evidence instead of feel. A rejection is not a missed trade.
//
// `bars` must be CLOSED bars (run dropFormingBar first) and should be
// PBC_HISTORY_BARS deep — the 5-bar market_multi_tf feed cannot support a
// structure read, so the caller needs getFullBars().
// `pdhpdl` is server.js's getPDHPDL() result, or null.
function validateEngulfPlaybookC(bars, direction, pdhpdl) {
  if (!Array.isArray(bars) || bars.length < PBC_PIVOT_LEG * 2 + PBC_PIVOT_WINDOW) {
    return { valid: false, reason: 'not enough bar history for a structure read', structure: 'unknown' };
  }
  const n = bars.length;
  const engulf = bars[n - 1];
  const prev = bars[n - 2];
  const bull = direction === 'BULLISH';

  // ── Requirements 1+2: colour flip + full-range engulf ──────────────────────
  // Re-verified here rather than trusted from the caller, so this function is
  // valid on its own terms and testable in isolation.
  if (bull && !(prev.close < prev.open && engulf.close > engulf.open)) {
    return { valid: false, reason: 'not a bullish colour flip', structure: 'n/a' };
  }
  if (!bull && !(prev.close > prev.open && engulf.close < engulf.open)) {
    return { valid: false, reason: 'not a bearish colour flip', structure: 'n/a' };
  }
  if (!(engulf.high >= prev.high && engulf.low <= prev.low)) {
    return { valid: false, reason: 'does not take out BOTH the high and low of the previous candle', structure: 'n/a' };
  }

  // Pivots computed on everything EXCEPT the engulfing candle and the one it
  // engulfed — those two are the event, not the structure that preceded it.
  const priorBars = bars.slice(0, n - 2);
  const { pivotHighs, pivotLows } = findPivots(priorBars);

  // ── Requirement 3: HH-HL (bullish) / LL-LH (bearish) ──────────────────────
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return { valid: false, reason: 'fewer than 2 confirmed pivots each side — structure unknown', structure: 'unknown' };
  }
  const h1 = pivotHighs[pivotHighs.length - 2].price, h2 = pivotHighs[pivotHighs.length - 1].price;
  const l1 = pivotLows[pivotLows.length - 2].price,  l2 = pivotLows[pivotLows.length - 1].price;
  const isHHHL = h2 > h1 && l2 > l1;
  const isLLLH = h2 < h1 && l2 < l1;
  const structure = isHHHL ? 'HH-HL' : isLLLH ? 'LL-LH' : 'mixed/ranging';

  if (bull && !isHHHL) {
    return { valid: false, reason: `bullish engulfing needs an HH-HL structure, found ${structure}`, structure };
  }
  if (!bull && !isLLLH) {
    return { valid: false, reason: `bearish engulfing needs an LL-LH structure, found ${structure}`, structure };
  }

  // ── Requirement 4: forms AT a swing low (bullish) / swing high (bearish) ──
  const windowBars = bars.slice(Math.max(0, n - PBC_PIVOT_WINDOW));
  if (bull) {
    const isLocalLow = engulf.low === Math.min(...windowBars.map(b => b.low));
    const retestsPivot = pivotLows.some(p => Math.abs(p.price - engulf.low) / p.price < PBC_LEVEL_TOL);
    if (!isLocalLow && !retestsPivot) {
      return { valid: false, reason: 'not at a swing low — mid-range entry', structure };
    }
  } else {
    const isLocalHigh = engulf.high === Math.max(...windowBars.map(b => b.high));
    const retestsPivot = pivotHighs.some(p => Math.abs(p.price - engulf.high) / p.price < PBC_LEVEL_TOL);
    if (!isLocalHigh && !retestsPivot) {
      return { valid: false, reason: 'not at a swing high — mid-range entry', structure };
    }
  }

  // ── Requirement 5: the hard disqualifier — liquidity already taken ────────
  // "Swept" means TAKEN AND REJECTED: price wicked through the level and is now
  // back on the original side of it — the same trap-candle shape
  // detectSFPFromBars() encodes for the SFP monitor.
  //
  // That precision is load-bearing. An earlier draft treated ANY push through
  // an old high as a sweep, which rejected every bullish engulfing in an
  // uptrend — because in an HH-HL uptrend price MUST trade above old highs;
  // that is what makes it an uptrend. The naive reading is self-contradictory
  // with requirement 3. The rule targets buying AFTER the stops above have been
  // run and price has fallen back: an exhausted move with its target gone.
  const windowStart = Math.max(0, n - PBC_LIQ_LOOKBACK);
  const liqWindow = bars.slice(windowStart);
  if (bull) {
    // Buy-side liquidity rests ABOVE prior highs. Only levels formed BEFORE the
    // current leg count — a high made inside the window is part of this move,
    // not resting liquidity it consumed.
    const levels = [
      ...(pdhpdl && typeof pdhpdl.pdh === 'number' ? [pdhpdl.pdh] : []),
      ...pivotHighs.filter(p => p.i < windowStart).map(p => p.price)
    ];
    const maxHigh = Math.max(...liqWindow.map(b => b.high));
    const swept = levels.find(lv => maxHigh > lv * (1 + PBC_LEVEL_TOL) && engulf.close < lv);
    if (swept !== undefined) {
      return { valid: false, reason: `buy-side liquidity at ${swept.toFixed(2)} already swept and rejected — too late for a bullish engulfing`, structure };
    }
  } else {
    const levels = [
      ...(pdhpdl && typeof pdhpdl.pdl === 'number' ? [pdhpdl.pdl] : []),
      ...pivotLows.filter(p => p.i < windowStart).map(p => p.price)
    ];
    const minLow = Math.min(...liqWindow.map(b => b.low));
    const swept = levels.find(lv => minLow < lv * (1 - PBC_LEVEL_TOL) && engulf.close > lv);
    if (swept !== undefined) {
      return { valid: false, reason: `sell-side liquidity at ${swept.toFixed(2)} already swept and rejected — too late for a bearish engulfing`, structure };
    }
  }

  return {
    valid: true,
    reason: `valid ${structure} ${bull ? 'swing-low' : 'swing-high'} engulfing, liquidity intact`,
    structure
  };
}

module.exports = {
  dropFormingBar,
  findPivots,
  validateEngulfPlaybookC,
  PBC_HISTORY_BARS
};
