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
    name: 'Engulfing candle (any always-on timeframe)',
    source: 'Prop Trading/CLAUDE.md — Playbook A, as respecified by Anoop 2026-09-01',
    // The watchers that ARE Playbook A. All are always-on and have no
    // supported OFF; the timeframe is an attribute of the signal, not a
    // different playbook. Kept here so one list answers "which watchers are A".
    entryTfs: ['60', '30', '15', '5'],
    entryTf: '60',      // the canonical one, for callers that want a single TF
    biasTf: null,       // bias is NOT A's job — see the note below
    steps: [
      { n: 1, kind: 'gate',    text: 'The higher-timeframe gate must be open: the 1H structure reads cleanly as HH-HL or LL-LH. This sits ABOVE every playbook and is not part of A. The 4H is read too, but since 2026-09-01 it cannot refuse a trade — it is reported as evidence, and every signal states whether it confirmed.' },
      { n: 2, kind: 'trigger', text: 'An engulfing candle CLOSES on any always-on watcher — 1H, 30M, 15M or 5M. The candle takes out BOTH the high and the low of the previous candle, and covers its body. This is timeframe-agnostic: the same shape counts on every chart.' },
      { n: 3, kind: 'gate',    text: 'Playbook C validity gate passes on that candle (swing location, and liquidity not already swept and rejected).' },
      { n: 4, kind: 'gate',    text: 'Its direction matches the higher-timeframe bias. Against it is No Action, never a smaller size.' },
      { n: 5, kind: 'entry',   text: 'Entry at the engulfing candle close; stop beyond the opposite extreme of that same candle.' },
      { n: 6, kind: 'manage',  text: 'Report the TIMEFRAME with every signal — since 2026-09-01 all four watchers are Playbook A, so the timeframe is the only thing distinguishing a 5M engulf from a 1H one.' },
    ],
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

  // ── Playbook C (ADX) — the first candidate with out-of-sample evidence ───
  // Long-only strong-uptrend Donchian breakout, from DSH's six backtest rounds
  // (see "DSH backtesting/" — STRATEGY_V2.md and ROBUSTNESS_GRID.md).
  //
  // ── WHY THE ID IS `C-ADX` AND NOT `C` ──────────────────────────────────
  // Named "Playbook C (ADX)" at Anoop's instruction 2026-09-01. The id stays
  // distinct because `C` is ALREADY TAKEN by the engulf validity gate above,
  // and autonomy-modes.js:221 aliases an incoming 'C' to 'LTF-ENGULF'. Giving
  // this setup the bare id 'C' would make three different things answer to one
  // key and would silently route its orders through the LTF-ENGULF alias.
  // Both DSH documents ask for exactly this split: 'Playbook C (ADX breakout)'
  // vs 'Playbook C (engulf gate)'. `name` is what a human reads; `id` is what
  // the ledger keys on, and those two jobs are not the same job.
  //
  // Rows written before this rename carry `DSH-V2`. That id is kept as an
  // ALIAS (see PLAYBOOK_ALIASES) rather than rewritten in the ledger — a
  // record of what the app actually did is not something to edit after the
  // fact, and a resolver that cannot read its own history resolves nothing.
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
  'C-ADX': {
    id: 'C-ADX',
    name: 'Playbook C (ADX) — long-only strong-uptrend breakout',
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

  // ── LTF-ENGULF — RETIRED 2026-09-01, folded into Playbook A ────────────
  // It existed because the server tagged a 1H engulf 'A' and the identical
  // candle on 30M/15M/5M something else, so results from one detector were
  // filed under two names — neither of which the rulebook sanctioned for the
  // lower timeframes. Anoop settled it: "I want all the monitors which are
  // always on to be part of Playbook A... That is the only Playbook A setup."
  //
  // Not deleted, ALIASED (see PLAYBOOK_ALIASES). Rows written under the old id
  // must keep resolving, and a resolver that cannot read its own history
  // resolves nothing.
};

// ── Historical ids that must keep resolving ────────────────────────────────
// A playbook can be RENAMED; the rows it already wrote cannot. Every id that
// has ever reached disk maps here to its current key, so a ledger row, a
// pending shadow order or an unresolved outcome written under the old name
// still finds its spec. Deleting an entry from this map does not tidy
// anything — it orphans real records.
//
//   DSH-V2 → C-ADX   renamed 2026-09-01 ("name it playbook C (ADX)").
const PLAYBOOK_ALIASES = {
  'DSH-V2': 'C-ADX',
  // Retired 2026-09-01: every always-on engulf watcher is Playbook A. The
  // lower-timeframe engulf is the same setup on a different chart, not a
  // different setup.
  'LTF-ENGULF': 'A',
};

function getPlaybook(id) {
  const raw = String(id || '');
  const up = raw.toUpperCase();
  const key = PLAYBOOK_ALIASES[up] || PLAYBOOK_ALIASES[raw] || up;
  return PLAYBOOKS[key] || PLAYBOOKS[raw] || null;
}

// Current canonical id for a possibly-historical one. Callers that key their
// OWN maps on a playbook id (the resolver, the outcome ledger) need this so
// old and new rows for the same strategy land in one bucket instead of two.
function canonicalId(id) {
  const raw = String(id || '');
  const up = raw.toUpperCase();
  return PLAYBOOK_ALIASES[up] || PLAYBOOK_ALIASES[raw] || (PLAYBOOKS[up] ? up : raw);
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
    case 'FVG-ONLY':
      // A displacement gap with NO raid behind it. Not a playbook and not a
      // setup — it is deliberately absent from PLAYBOOKS so planEntry refuses
      // it. It still needs a stable id because the FVG watcher logs it, and
      // it must be keyed on the GAP: falling through to the default (which
      // keys on `level`, always null here) would collapse every same-direction
      // gap in a session into one id.
      return `FVG-ONLY:${dir}:${px(s.gapLow)}-${px(s.gapHigh)}`;
    case 'A':
    case 'C':
    case 'LTF-ENGULF':   // retired id — kept so historical setupIds still match
    case 'C-ADX':
    case 'DSH-V2':   // historical alias — see PLAYBOOK_ALIASES
      // An engulf is identified by the candle itself: its own open time is
      // unique and never repaints once closed.
      return `${playbookId}:${dir}:${s.barTime != null ? s.barTime : 'na'}:${px(s.entryRef)}`;
    default:
      return `${playbookId}:${dir}:${px(s.level)}`;
  }
}

// ── riskGate — the shared risk ceiling, G8/G11 ────────────────────────────
// Was declared inside backtest.js; moved here so the LIVE path and the backtest
// price a setup with the SAME two ceilings. Returns {ok, riskUsd} or
// {ok:false, code:'risk-too-small'|'risk-too-big', reason}. Pure — every number
// comes from rules.json via the caller.
function riskGate(plan, rules, contracts, pointValue) {
  const minPts = (rules && rules.playbooks && rules.playbooks.minRiskPoints) || 0;
  const maxUsd = (rules && rules.perTradeMaxLoss) || Infinity;
  const riskUsd = plan.riskPoints * pointValue * contracts;
  if (minPts && plan.riskPoints < minPts) {
    return { ok: false, code: 'risk-too-small', reason: `stop is only ${plan.riskPoints.toFixed(2)}pt (min ${minPts}) — raid and displacement are likely the same bar` };
  }
  if (riskUsd > maxUsd) {
    return { ok: false, code: 'risk-too-big', reason: `${plan.riskPoints.toFixed(2)}pt = $${riskUsd.toFixed(0)} risk at ${contracts} contracts, over the $${maxUsd} per-trade max loss` };
  }
  return { ok: true, riskUsd };
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
function planEntry(playbookId, setup, rules, risk) {
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

  // G11: minRiskPoints is a HARD refusal for Playbook B — a 3.00pt stop means the
  // raid candle and the displacement FVG candle are the same bar, so there is no
  // displacement leg and it is not the playbook. Surfaced by the caller, not
  // silently swallowed.
  const minPts = (rules && rules.playbooks && rules.playbooks.minRiskPoints) || 0;
  if (playbookId === 'B' && minPts && riskPoints < minPts) {
    return { plannable: false, riskPoints, riskTooSmall: true,
      reason: `risk ${riskPoints.toFixed(2)}pt under minRiskPoints ${minPts} — raid and displacement are likely the same bar` };
  }

  const target = bull ? entry + riskPoints * rr : entry - riskPoints * rr;

  const out = {
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

  // G8: flag, do not skip. riskUsd is computed only when the caller supplies the
  // traded size + point value; `riskBlocked` flags an over-cap setup without
  // refusing it (a hard skip would stop arming ~1/3 of A and 3/4 of B and break
  // forward-test comparability).
  if (risk && Number.isFinite(risk.contracts) && Number.isFinite(risk.pointValue)) {
    const riskUsd = riskPoints * risk.pointValue * risk.contracts;
    const maxUsd = (rules && rules.perTradeMaxLoss) || Infinity;
    out.riskUsd = riskUsd;
    out.riskBlocked = riskUsd > maxUsd ? 'over-per-trade-max' : null;
  } else {
    out.riskUsd = null;
    out.riskBlocked = null;
  }
  return out;
}

module.exports = { PLAYBOOKS, PLAYBOOK_ALIASES, SPEC_DEFAULTS, getPlaybook, canonicalId, planEntry, setupId, riskGate };
