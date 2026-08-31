'use strict';
// ── Playbook spec — what A, B and C actually ARE, as executable code ────────
// Written 2026-08-26 against Anoop's own words: "there is a gap in identifying
// playbooks A B and C. i myself do not know the exact playbook."
//
// He is right, and it is not a memory problem — the ambiguity is real and it
// lives in this repo. Three separate definitions of "playbook" existed and
// none of them agreed:
//
//   1. Prop Trading/CLAUDE.md — prose. A = 4H structure + 1H engulf,
//      B = SFP + FVG, C = validity RULES for an engulfing bar.
//   2. The Pine backtests — Playbook_A_C_Backtest_v2.pine treats A and C as
//      ONE strategy (C is applied as a filter on A), which matches the prose.
//   3. The live server — tags a 1H engulf as playbook 'A' and a 30M/15M
//      engulf as playbook 'C' (server.js: `key === '1h' ? 'A' : 'C'`).
//
// Definition 3 is the one writing the ledger, and it is the odd one out.
//
// ── THE CORRECTION THAT MATTERS ────────────────────────────────────────────
// **Playbook C is not a setup. It is a gate.** The rulebook defines C purely
// as validity conditions an engulfing candle must satisfy — swing location,
// HH-HL/LL-LH structure, liquidity not already swept. There is no entry, no
// stop and no target in C because C never proposes a trade; it only ever
// disqualifies one. playbook-c.js implements it correctly as exactly that: a
// `validateEngulfPlaybookC()` returning `{valid, reason}`.
//
// What the live server currently labels "Playbook C" — an engulfing candle on
// 30M or 15M — is a FOURTH thing that appears in no rulebook, no Pine script
// and no session log. It is a lower-timeframe engulf that passed C's gate,
// with no HTF alignment requirement of any kind (Playbook A's 4H check is
// explicitly skipped for anything that is not the 1H monitor). It is named
// here as its own id, `LTF-ENGULF`, so the ledger stops silently attributing
// its results to a rulebook playbook that never sanctioned it. Whether it
// deserves to exist at all is an evidence question — which is precisely what
// the backtest and the outcome ledger are for. It is not deleted, it is
// labelled.
//
// ── WHAT THIS MODULE IS FOR ────────────────────────────────────────────────
// One definition, read by BOTH the live monitors and the backtest harness, of:
//   • the ordered steps a setup must satisfy (STEPS — the "step by step")
//   • where the ENTRY is, where the STOP is, where the TARGET is (planEntry)
//   • whether the entry needs price to come back to it (requiresFill)
//   • a stable identity for the setup (setupId), so one gap is one signal
//
// PURE. No I/O, no TradingView, no clock. Every number it uses comes from
// rules.json via the caller — per this repo's standing convention that a
// trading-rule number lives in rules.json and nowhere else.

// Defaults matching rules.json's `playbooks` block. Present ONLY so this
// module is testable and never throws on a partial config — the live server
// and the backtest both pass the real block. If you find yourself changing a
// number here, change it in rules.json instead; this copy is the fallback,
// not the source.
const SPEC_DEFAULTS = {
  stopBufferPoints: 3,
  targetR: 2,
  fvgFillWindowBars: 8,
  sfpToFvgMaxBars: 3,
  outcomeHorizonBars: 12,
};

// ── The playbooks, step by step ────────────────────────────────────────────
// `steps` is the checklist in execution order. `gate` steps disqualify;
// `trigger` steps are the event you act on; `manage` steps happen after fill.
// This is the text the UI can render next to a live signal so a fired setup
// says WHICH step it is on, instead of just a candle name.
const PLAYBOOKS = {
  A: {
    id: 'A',
    name: '4H Engulfing + TF Alignment',
    source: 'Prop Trading/CLAUDE.md — Playbook A',
    entryTf: '60',
    biasTf: '240',
    steps: [
      { n: 1, kind: 'prep',    text: 'Mark all levels on the chart (PDH/PDL, prior swings, session ranges) before the session.' },
      { n: 2, kind: 'gate',    text: '4H structure must be clean: HH-HL for longs, LL-LH for shorts. Mixed/ranging = no trade.' },
      { n: 3, kind: 'trigger', text: 'Wait for a full-range engulfing candle to CLOSE on the 1H.' },
      { n: 4, kind: 'gate',    text: 'Engulf direction must AGREE with 4H structure. Against it = No Action, not a smaller size.' },
      { n: 5, kind: 'gate',    text: 'Playbook C validity gate must pass on that engulfing candle (see playbook C).' },
      { n: 6, kind: 'entry',   text: 'Entry 1 at the engulfing candle close, stop beyond the engulfing candle extreme.' },
      { n: 7, kind: 'manage',  text: 'If entry 1 goes into profit: add entry 2 and move the combined stop to breakeven.' },
      { n: 8, kind: 'manage',  text: 'Exit at the marked levels from step 1 — not at an arbitrary point count.' },
    ],
    // Entry is at the close of the trigger candle, so it is always reachable:
    // it is the price that just printed. Nothing to wait for.
    requiresFill: false,
  },

  B: {
    id: 'B',
    name: 'JadeCap 3-Step (SFP + FVG)',
    source: 'Prop Trading/CLAUDE.md — Playbook B',
    entryTf: '30',
    biasTf: '240',
    steps: [
      { n: 1, kind: 'prep',    text: 'Establish daily bias from HTF (Weekly/Daily/4H); mark PH/PL, PDH/PDL and equal highs/lows.' },
      { n: 2, kind: 'gate',    text: 'Skip neutral/range days, trades against the major trend, and days with equal liquidity BOTH sides.' },
      { n: 3, kind: 'trigger', text: 'Liquidity raid (SFP): price pushes through a key level and CLOSES BACK INSIDE it — the trap candle.' },
      { n: 4, kind: 'trigger', text: 'Displacement: a strong impulsive move away from the raid leaves a Fair Value Gap, in the raid direction, within a few bars.' },
      { n: 5, kind: 'entry',   text: 'Entry on the RETRACE back into the gap — not on the displacement candle itself.' },
      { n: 6, kind: 'manage',  text: 'Stop beyond the SFP wick (the extreme of the trap candle, not the level it swept).' },
      { n: 7, kind: 'manage',  text: 'Target the next liquidity pool; if the retrace never comes, the setup expires unfired — do not chase.' },
    ],
    // The defining feature of B and the one the live ledger has never
    // modelled: the entry is a LIMIT back inside the gap. Price has to come
    // to you. A B signal that never retraces is not a losing trade, it is
    // NO trade — and counting it as either is what makes a backtest lie.
    requiresFill: true,
  },

  C: {
    id: 'C',
    name: 'Engulfing Bar Validity (a GATE, not a setup)',
    source: 'Prop Trading/CLAUDE.md — Playbook C',
    entryTf: null,
    biasTf: null,
    isGate: true,
    steps: [
      { n: 1, kind: 'gate', text: 'Bullish engulf must form AT a swing low, inside an HH-HL structure.' },
      { n: 2, kind: 'gate', text: 'Bearish engulf must form AT a swing high, inside an LL-LH structure.' },
      { n: 3, kind: 'gate', text: 'The candle must take out BOTH the high AND the low of the previous candle.' },
      { n: 4, kind: 'gate', text: 'NEVER take a bullish engulf after buy-side liquidity has already been swept and rejected. Mirror for bearish.' },
    ],
    requiresFill: false,
  },

  // ── DSH-V2 — the first candidate with out-of-sample evidence ─────────────
  // Long-only strong-uptrend Donchian breakout, from DSH's six backtest rounds
  // (see "DSH backtesting/" — STRATEGY_V2.md and ROBUSTNESS_GRID.md).
  //
  // WHY IT IS HERE AND THE OTHERS ARE NOT: it is the only rule in this repo
  // that stayed positive across four HELD-OUT market regimes and a 16-cell
  // parameter grid, and it stayed positive when re-verified independently at
  // 2 contracts (scripts/verify-dsh-strategy.js). Registered as a playbook so
  // SHADOW mode can record it and build the track record the autonomy gate
  // requires — NOT because it is approved to trade.
  //
  // THE SIZE CAVEAT THAT MUST TRAVEL WITH IT: every number DSH published is
  // at 1 contract, a size rules.json forbids (sizeFloor = sizeCap = 2). At 2
  // contracts `perTradeMaxLoss` caps the stop at 75 points instead of 150,
  // which refuses 33 of 76 setups and drops profit factor 2.83 -> 1.95 and
  // consistency 31% -> 40%, i.e. onto the eval's limit rather than under it.
  // The edge survives the size change; the recommended PARAMETERS do not —
  // ADX>=35 was the consistency-safe choice at 1 contract and is borderline
  // at 2, where ADX>=25 reads better. Do not copy the published config
  // without re-deriving it at the size actually being traded.
  'DSH-V2': {
    id: 'DSH-V2',
    name: 'Long-only strong-uptrend breakout (ADX-gated)',
    source: 'DSH backtesting/STRATEGY_V2.md — verified at 2 contracts 2026-08-26',
    entryTf: '60',
    biasTf: '60',
    longOnly: true,
    evidence: 'positive across 4 held-out regimes and 16/16 grid cells at 2 contracts; NOT forward-tested',
    steps: [
      { n: 1, kind: 'gate',    text: 'Regime: ADX(14) must confirm a strong trend. Stand aside in ranges — this is mandatory, not optional.' },
      { n: 2, kind: 'gate',    text: 'Direction: +DI > -DI (confirmed uptrend). LONG ONLY — shorting breakdowns lost in every regime tested, including clean downtrends.' },
      { n: 3, kind: 'trigger', text: 'Close breaks above the highest high of the prior N bars (bar itself excluded) AND closes green.' },
      { n: 4, kind: 'entry',   text: 'Enter at that bar close.' },
      { n: 5, kind: 'manage',  text: 'Stop beyond the entry candle low. If the resulting risk exceeds the per-trade max loss at the traded size, SKIP — do not widen or size down.' },
      { n: 6, kind: 'manage',  text: 'Target 2R. Flat by 03:00 IST regardless.' },
      { n: 7, kind: 'gate',    text: 'Daily cap: no new trades once the day is up by the consistency-rule ceiling.' },
    ],
    requiresFill: false,
  },

  // See the header. Named rather than deleted, so its results stop being
  // filed under a rulebook playbook that never authorised it.
  'LTF-ENGULF': {
    id: 'LTF-ENGULF',
    name: 'Lower-timeframe engulf (30M/15M) — UNSANCTIONED, under evaluation',
    source: 'server.js behaviour only — appears in no rulebook or Pine script',
    entryTf: '30',
    biasTf: null,
    unsanctioned: true,
    steps: [
      { n: 1, kind: 'trigger', text: 'Full-range engulfing candle closes on 30M or 15M.' },
      { n: 2, kind: 'gate',    text: 'Playbook C validity gate passes.' },
      { n: 3, kind: 'gate',    text: 'NO higher-timeframe alignment requirement — this is what separates it from Playbook A, and why it is not Playbook A.' },
      { n: 4, kind: 'entry',   text: 'Entry at the engulfing candle close (assumed — never specified anywhere).' },
    ],
    requiresFill: false,
  },
};

function getPlaybook(id) {
  return PLAYBOOKS[String(id || '').toUpperCase()] || PLAYBOOKS[id] || null;
}

// Stable identity for a setup, so the SAME gap or the SAME engulfing candle
// is one signal no matter how many times a 30-second poll re-sees it.
//
// This is the fix for a measurement bug visible in the live ledger: the FVG
// monitor deduped on `direction + tf + floor(now / 15min)` — a WALL-CLOCK
// bucket. A 30M gap stays the newest 3-bar pattern for a full 30 minutes,
// which spans at least two buckets, so every 30M FVG fired at least twice.
// DATA/signals/2026-08-24.jsonl shows gap 29204.00–29205.75 logged at 11:30
// and again at 11:45, and gap 29137.50–29156.75 logged four times between
// 16:30 and 16:56. Ten of that day's eleven armed signals are re-fires of
// four underlying setups.
//
// Left uncorrected this does not merely inflate a count — it corrupts every
// per-playbook statistic downstream, because a setup that happened to work
// gets counted as many times as it was re-seen. Identity is derived from the
// PRICES that define the setup, which do not change as the poll re-runs.
function setupId(playbookId, setup) {
  const s = setup || {};
  const px = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'na');
  const dir = s.direction || 'na';
  switch (String(playbookId)) {
    case 'B':
      // A B setup is identified by the gap it will be entered in, plus the
      // raid that authorised it. Same gap + same sweep = same setup.
      return `B:${dir}:${px(s.gapLow)}-${px(s.gapHigh)}:sw${px(s.level)}`;
    case 'A':
    case 'C':
    case 'LTF-ENGULF':
    case 'DSH-V2':
      // An engulf is identified by the candle itself: its own open time is
      // unique and never repaints once closed.
      return `${playbookId}:${dir}:${s.barTime != null ? s.barTime : 'na'}:${px(s.entryRef)}`;
    default:
      return `${playbookId}:${dir}:${px(s.level)}`;
  }
}

// ── planEntry — where the trade actually is ────────────────────────────────
// Returns { plannable:true, entry, stop, target, riskPoints, requiresFill,
// fillWindowBars, stopSource } or { plannable:false, reason }.
//
// RULE 1 COMPLIANCE (TRUST-PROTOCOL.md): this refuses rather than guesses.
// A plan is only returned when every price it needs is a finite number and
// the resulting risk is positive. A stop on the wrong side of the entry, or
// a zero-width risk, yields `plannable:false` — never a number that looks
// like a plan. A missing plan is recoverable; a confidently wrong stop is
// what sizes a trade that cannot be survived.
//
// `setup` fields by playbook:
//   A / LTF-ENGULF : { direction, bar:{open,high,low,close,time} }
//   B              : { direction, gapLow, gapHigh, wick, level }
function planEntry(playbookId, setup, rules) {
  const cfg = Object.assign({}, SPEC_DEFAULTS, (rules && rules.playbooks) || {});
  const pb = getPlaybook(playbookId);
  if (!pb) return { plannable: false, reason: `unknown playbook "${playbookId}"` };
  if (pb.isGate) return { plannable: false, reason: 'Playbook C is a validity gate, not a setup — it proposes no entry' };

  const s = setup || {};
  const bull = String(s.direction || '').toUpperCase() === 'BULLISH';
  const bear = String(s.direction || '').toUpperCase() === 'BEARISH';
  if (!bull && !bear) return { plannable: false, reason: 'setup has no usable direction' };

  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const buf = fin(cfg.stopBufferPoints) ? cfg.stopBufferPoints : SPEC_DEFAULTS.stopBufferPoints;
  const rr = fin(cfg.targetR) && cfg.targetR > 0 ? cfg.targetR : SPEC_DEFAULTS.targetR;

  let entry, stop, stopSource, requiresFill, fillWindowBars;

  if (playbookId === 'B') {
    // ENTRY — the NEAR edge of the gap: the first price a retrace touches.
    //
    // Deliberately not mid-gap and not the far edge, both of which are common
    // ICT conventions and both of which flatter a backtest. The near edge is
    // the only one of the three that is reachable on every retrace that
    // reaches the gap at all; scoring from a deeper fill credits the setup
    // with entries it would not have received, and that optimism is exactly
    // how a backtest manufactures an edge that evaporates live. Same
    // reasoning as signal-outcome.js resolving same-bar stop/target ambiguity
    // as the stop, always.
    if (!fin(s.gapLow) || !fin(s.gapHigh)) return { plannable: false, reason: 'Playbook B needs both gap edges' };
    const lo = Math.min(s.gapLow, s.gapHigh);
    const hi = Math.max(s.gapLow, s.gapHigh);
    entry = bull ? hi : lo;

    // STOP — beyond the SFP wick, per the rulebook. Falls back to the swept
    // LEVEL only when the wick was not captured, and says so in stopSource:
    // the level sits inside the trap the setup is built on, so a stop there
    // is materially tighter than the playbook asks for and will show a worse
    // hit rate than the real rule. A result computed on the fallback must be
    // readable as such, not silently mixed in with the real thing.
    if (fin(s.wick)) {
      stop = bull ? s.wick - buf : s.wick + buf;
      stopSource = 'sfp-wick';
    } else if (fin(s.level)) {
      stop = bull ? s.level - buf : s.level + buf;
      stopSource = 'swept-level (WICK NOT CAPTURED — tighter than the rulebook stop)';
    } else {
      return { plannable: false, reason: 'Playbook B needs the SFP wick or at least the swept level for a stop' };
    }
    requiresFill = true;
    fillWindowBars = fin(cfg.fvgFillWindowBars) ? cfg.fvgFillWindowBars : SPEC_DEFAULTS.fvgFillWindowBars;
  } else {
    // A and LTF-ENGULF: entry at the trigger candle's close, stop beyond its
    // opposite extreme. This is the rulebook's "entry 1 with 1H SL".
    const bar = s.bar || {};
    if (!fin(bar.close) || !fin(bar.high) || !fin(bar.low)) {
      return { plannable: false, reason: 'engulf playbooks need the trigger bar OHLC' };
    }
    entry = bar.close;
    stop = bull ? bar.low - buf : bar.high + buf;
    stopSource = 'engulf-bar-extreme';
    requiresFill = false;
    fillWindowBars = 0;
  }

  const riskPoints = bull ? entry - stop : stop - entry;
  if (!fin(entry) || !fin(stop) || !(riskPoints > 0)) {
    return { plannable: false, reason: `stop is not beyond entry (entry ${entry}, stop ${stop}) — refusing to return a plan` };
  }

  const target = bull ? entry + riskPoints * rr : entry - riskPoints * rr;

  return {
    plannable: true,
    playbook: pb.id,
    direction: bull ? 'BULLISH' : 'BEARISH',
    entry,
    stop,
    target,
    riskPoints,
    targetR: rr,
    stopSource,
    requiresFill,
    fillWindowBars,
  };
}

module.exports = { PLAYBOOKS, SPEC_DEFAULTS, getPlaybook, planEntry, setupId };
