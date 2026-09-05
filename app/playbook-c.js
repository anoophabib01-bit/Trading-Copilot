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

// findPivots and its two constants moved to detectors.js on 2026-09-01 so the
// HTF gate (which sits above every playbook and must not import one) reads
// structure through the SAME definition this file does. Imported under the
// original PBC_* names so the rest of this file is untouched, and so the
// tolerance findPivots collapses pivots on stays identical to the one the
// retest/sweep checks below compare against.
const {
  findPivots,
  PIVOT_LEG: PBC_PIVOT_LEG,   // bars each side for a confirmed fractal pivot
  LEVEL_TOL: PBC_LEVEL_TOL,   // 0.05% — same tolerance getSwingLevels dedupes on
} = require('./detectors');

// ── WHICH FAILURES ARE A VETO, AND WHICH ARE ONLY EVIDENCE (2026-09-03) ────
// Anoop: "playbook A should be active in both direction and should intimate me
// when any engulfing in any direction takes place after which i will decide
// manually which side should i take the entry at."
//
// That splits this function's nine rejection reasons into two genuinely
// different kinds, which until now were returned identically and therefore
// treated identically by the caller:
//
//   SHAPE   — requirements 1 and 2. These are the DEFINITION of an engulfing
//             candle: the colour flip, taking out both extremes, the body
//             covering the body. A candle failing one of these is not "a
//             disqualified engulfing", it is not an engulfing at all, and
//             reporting it as one would make the alert a lie. Still a veto.
//
//   CONTEXT — requirements 3, 4 and 5: structure, swing location, resting
//             liquidity. These answer "is this a good place to take it",
//             which is precisely the judgment Anoop has just taken back. They
//             remain COMPUTED and are attached to the alert verbatim, so he
//             sees "against a bearish 15M structure" or "mid-range entry" and
//             decides — instead of never learning the candle existed.
//
//   DATA    — not enough bars to judge at all. Neither a pass nor a rejection;
//             the caller must be able to tell "the app could not look" from
//             "the app looked and said no", which is this module's oldest rule.
//
// `valid` keeps its exact old meaning — the full Playbook A setup, all five
// requirements — because Playbook B, the debate trigger and every stored
// signal row still read it that way. `stage` is additive: it tells a caller
// that wants to alert on more than the strict setup WHICH bar was hit. Nothing
// that ignores `stage` changes behaviour.
const STAGE = {
  DATA: 'data',
  SHAPE: 'shape',
  CONTEXT: 'context',
  OK: 'ok',
};

const PBC_PIVOT_WINDOW = 5;     // "is this the local extreme" window
const PBC_LIQ_LOOKBACK = 10;    // how far back a sweep still counts as recent
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
// `htfStructure` (added 2026-09-01) — 'bullish' | 'bearish' | null.
// 2026-09-03: this is now the 15M read, not the 1H one. See htf-alignment.js.
//
// Anoop, 2026-09-03: "The structure HH-HL/LL-LH is read in one hour — change
// it to 15 mins which should agree with 1hr not 4hr."
//
// Requirement 3 below is exactly that HH-HL / LL-LH read, and until now it was
// computed from `bars` — the TRIGGER timeframe's own candles. On the 15M
// watcher that was right by accident. On the 1H, 30M and 5M watchers it was
// reading structure off a chart he does not read structure on, producing a
// "trend" that flips several times an hour and admitting setups his rules
// disqualify.
//
// Pass the 15M structure (from htf-alignment.readHTF) and requirement 3 is
// judged against THAT instead. Omit it and the old local-pivot behaviour
// stands, so nothing that has not been migrated changes underneath itself.
//
// The pivots are still computed either way: requirements 4 and 5 (swing
// location and resting liquidity) are genuinely local to the trigger
// timeframe — WHERE in this chart's own swing the candle sits, and which of
// this chart's own levels have been taken. Only the structure verdict moves.
function validateEngulfPlaybookC(bars, direction, pdhpdl, htfStructure) {
  if (!Array.isArray(bars) || bars.length < PBC_PIVOT_LEG * 2 + PBC_PIVOT_WINDOW) {
    return { valid: false, stage: STAGE.DATA, reason: 'not enough bar history for a structure read', structure: 'unknown' };
  }
  const n = bars.length;
  const engulf = bars[n - 1];
  const prev = bars[n - 2];
  const bull = direction === 'BULLISH';

  // ── Requirements 1+2: colour flip + full-range engulf ──────────────────────
  // Re-verified here rather than trusted from the caller, so this function is
  // valid on its own terms and testable in isolation.
  if (bull && !(prev.close < prev.open && engulf.close > engulf.open)) {
    return { valid: false, stage: STAGE.SHAPE, reason: 'not a bullish colour flip', structure: 'n/a' };
  }
  if (!bull && !(prev.close > prev.open && engulf.close < engulf.open)) {
    return { valid: false, stage: STAGE.SHAPE, reason: 'not a bearish colour flip', structure: 'n/a' };
  }
  if (!(engulf.high >= prev.high && engulf.low <= prev.low)) {
    return { valid: false, stage: STAGE.SHAPE, reason: 'does not take out BOTH the high and low of the previous candle', structure: 'n/a' };
  }
  // 2026-08-27: body engulf, checked separately because range engulf does not
  // imply it — a long-wicked indecision candle can straddle both extremes of
  // the previous bar with its own body sitting inside that bar's body. See
  // detectors.js's bodyEngulfs() note.
  const pTop = Math.max(prev.open, prev.close), pBot = Math.min(prev.open, prev.close);
  const eTop = Math.max(engulf.open, engulf.close), eBot = Math.min(engulf.open, engulf.close);
  if (!(eTop >= pTop && eBot <= pBot)) {
    return { valid: false, stage: STAGE.SHAPE, reason: 'body does not fully engulf the previous candle body (wicks only)', structure: 'n/a' };
  }

  // Pivots computed on everything EXCEPT the engulfing candle and the one it
  // engulfed — those two are the event, not the structure that preceded it.
  const priorBars = bars.slice(0, n - 2);
  const { pivotHighs, pivotLows } = findPivots(priorBars);

  // ── Requirement 3: HH-HL (bullish) / LL-LH (bearish) ──────────────────────
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return { valid: false, stage: STAGE.CONTEXT, reason: 'fewer than 2 confirmed pivots each side — structure unknown', structure: 'unknown' };
  }
  const h1 = pivotHighs[pivotHighs.length - 2].price, h2 = pivotHighs[pivotHighs.length - 1].price;
  const l1 = pivotLows[pivotLows.length - 2].price,  l2 = pivotLows[pivotLows.length - 1].price;
  const localHHHL = h2 > h1 && l2 > l1;
  const localLLLH = h2 < h1 && l2 < l1;
  const localStructure = localHHHL ? 'HH-HL' : localLLLH ? 'LL-LH' : 'mixed/ranging';

  // Structure comes from the 15M when the caller supplies it, per the rule
  // above. The label records WHICH read decided, so a rejection can be argued
  // with later rather than merely believed.
  const useHtf = htfStructure === 'bullish' || htfStructure === 'bearish';
  const isHHHL = useHtf ? htfStructure === 'bullish' : localHHHL;
  const isLLLH = useHtf ? htfStructure === 'bearish' : localLLLH;
  const structure = useHtf
    ? (htfStructure === 'bullish' ? 'HH-HL (15M)' : 'LL-LH (15M)')
    : localStructure;

  if (bull && !isHHHL) {
    return { valid: false, stage: STAGE.CONTEXT, reason: `bullish engulfing needs an HH-HL structure, found ${structure}`, structure };
  }
  if (!bull && !isLLLH) {
    return { valid: false, stage: STAGE.CONTEXT, reason: `bearish engulfing needs an LL-LH structure, found ${structure}`, structure };
  }

  // ── Requirement 4: forms AT a swing low (bullish) / swing high (bearish) ──
  const windowBars = bars.slice(Math.max(0, n - PBC_PIVOT_WINDOW));
  if (bull) {
    const isLocalLow = engulf.low === Math.min(...windowBars.map(b => b.low));
    const retestsPivot = pivotLows.some(p => Math.abs(p.price - engulf.low) / p.price < PBC_LEVEL_TOL);
    if (!isLocalLow && !retestsPivot) {
      return { valid: false, stage: STAGE.CONTEXT, reason: 'not at a swing low — mid-range entry', structure };
    }
  } else {
    const isLocalHigh = engulf.high === Math.max(...windowBars.map(b => b.high));
    const retestsPivot = pivotHighs.some(p => Math.abs(p.price - engulf.high) / p.price < PBC_LEVEL_TOL);
    if (!isLocalHigh && !retestsPivot) {
      return { valid: false, stage: STAGE.CONTEXT, reason: 'not at a swing high — mid-range entry', structure };
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
      return { valid: false, stage: STAGE.CONTEXT, reason: `buy-side liquidity at ${swept.toFixed(2)} already swept and rejected — too late for a bullish engulfing`, structure };
    }
  } else {
    const levels = [
      ...(pdhpdl && typeof pdhpdl.pdl === 'number' ? [pdhpdl.pdl] : []),
      ...pivotLows.filter(p => p.i < windowStart).map(p => p.price)
    ];
    const minLow = Math.min(...liqWindow.map(b => b.low));
    const swept = levels.find(lv => minLow < lv * (1 - PBC_LEVEL_TOL) && engulf.close > lv);
    if (swept !== undefined) {
      return { valid: false, stage: STAGE.CONTEXT, reason: `sell-side liquidity at ${swept.toFixed(2)} already swept and rejected — too late for a bearish engulfing`, structure };
    }
  }

  return {
    valid: true,
    stage: STAGE.OK,
    reason: `valid ${structure} ${bull ? 'swing-low' : 'swing-high'} engulfing, liquidity intact`,
    structure
  };
}

// ── Key levels the engulfing candle actually interacted with ────────────────
// 2026-08-27. Purpose is Anoop's manual re-check, not an extra gate: the alert
// should say WHERE the candle formed so he can pull the chart up and judge it
// himself. Nothing here can reject a signal — it only annotates one.
//
// "Interacted with" is deliberately the candle's own RANGE, not a proximity
// radius around its close. If price traded through the level during that
// candle, the level is relevant; if it merely sits 20 points away untouched,
// it is not, and saying otherwise would put a level in every single alert and
// train him to ignore the line. A small tolerance band is added on top of the
// range so a level the wick stopped one tick short of still counts.
const PBC_NEAR_LEVEL_TOL = 0.0005;  // 0.05% — same band getSwingLevels dedupes on

function nearbyKeyLevels(bar, levels, tolPct = PBC_NEAR_LEVEL_TOL) {
  if (!bar || !Array.isArray(levels)) return [];
  const out = [];
  for (const lv of levels) {
    if (!lv || typeof lv.price !== 'number' || !Number.isFinite(lv.price) || lv.price <= 0) continue;
    const band = lv.price * tolPct;
    if (bar.low - band <= lv.price && lv.price <= bar.high + band) {
      out.push({ name: lv.name, price: lv.price, dist: Math.abs(lv.price - bar.close) });
    }
  }
  // Nearest to the close first — that is the one the candle finished against.
  out.sort((a, b) => a.dist - b.dist);
  // Deduped by price: PDL and a swing low can be the same line to the tick, and
  // naming it twice reads as two confluences when there is one.
  const seen = [];
  return out.filter(l => {
    if (seen.some(p => Math.abs(p - l.price) / l.price < tolPct)) return false;
    seen.push(l.price); return true;
  }).slice(0, 3);
}

module.exports = {
  nearbyKeyLevels,
  PBC_NEAR_LEVEL_TOL,
  dropFormingBar,
  findPivots,
  validateEngulfPlaybookC,
  STAGE,
  PBC_HISTORY_BARS
};
