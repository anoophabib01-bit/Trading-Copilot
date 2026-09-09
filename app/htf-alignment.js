'use strict';
// ── htf-alignment.js — the ONE gate that sits above every playbook ─────────
//
// Anoop, 2026-09-01, settling this after the code had drifted into three
// different answers:
//
//   "Only the higher time frame analysis is completely above all the
//    playbooks. The higher time frame analysis should happen, after which all
//    three playbooks should come under it."
//
// ── WHICH TIMEFRAME READS STRUCTURE — CHANGED 2026-09-03 ──────────────────
// It was 1H, confirmed by 4H. Anoop, 2026-09-03:
//
//   "The structure HH-HL/LL-LH is read in one hour — change it to 15 mins
//    which should agree with 1hr not 4hr. As i am intra day trader and need
//    better reading of smaller time frames... All these playbooks are here to
//    determine the direction of the day at peak hours and 4hrs is too high and
//    cannot do that. i will check 4hr and daily candle manually."
//
// So the whole ladder moves down one rung:
//
//   1. Structure (HH-HL / LL-LH) is read on the 15 MINUTE chart. Only there.
//   2. The 1H is consulted, recorded and reported as EVIDENCE. It cannot veto.
//   3. The result is ONE bias, computed ONCE, above everything.
//   4. The 4H is not read here at all any more — it is his own manual check.
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
// Before it, each playbook carried its own private idea of higher-timeframe
// context and they did not agree:
//
//   • Playbook A checked 4H structure and nothing above it.
//   • Playbook B (SFP/FVG) checked NO higher timeframe at all.
//   • LTF-ENGULF (30M/15M/5M) checked none either, and its Playbook C gate
//     computed HH-HL from the 30M/15M/5M bars themselves.
//   • Playbook C (ADX) used its own ADX/DI regime read.
//
// Four setups, four different notions of "the trend", none of them the one he
// actually trades. Hoisting it here means the answer is computed in one place,
// logged once, and cannot silently differ between playbooks.
//
// ── STRUCTURE IS READ ON 15M, NEVER ON THE TRIGGER TIMEFRAME ──────────────
// This is still the load-bearing rule, one rung lower. A 5M engulf is judged
// against 15M structure, not 5M structure. A 30M Playbook B setup is judged
// against 15M structure. The trigger timeframe decides WHEN, the 15M decides
// WHETHER. Reading HH-HL off a 5M chart produces a "trend" that reverses
// several times an hour, which is what made the lower-timeframe watchers fire
// in conditions his rules disqualify.
//
// ── UNCLEAR 15M IS A REFUSAL, NOT A PASS ──────────────────────────────────
// If the 15M is not cleanly HH-HL or LL-LH, there is no bias. Missing 15M data
// refuses too, with its own distinct reason code, so a rule refusing (the app
// working) is never confused with no bars (the app degraded).
//
// ── THE 1H IS EVIDENCE, NOT PERMISSION ────────────────────────────────────
// "which should agree with 1hr" is the one ambiguous phrase in the
// instruction, and it was settled by measuring rather than guessing. On 300
// real MNQ 15M bars against 1,037 real 1H bars, read at the same instants
// (261 overlapping points, 40-bar windows on both):
//
//   15M reads cleanly                 186   71.3%   <- the gate's open rate
//     of which, the 1H says:
//       1H unclear                    100   53.8% of clean 15M reads
//       1H confirms                    55   29.6%
//       1H disagrees                   31   16.7%
//
// Making the 1H a VETO would drop the gate from 71.3% open to 21.1% — worse
// than the 4H gate he has just thrown out for being too restrictive, and the
// direct cause of the "most of the current watching does not trigger"
// complaint that prompted this change. And note WHAT it would block: 54% of
// the blocks would be 1H AMBIGUITY, not 1H opposition. A veto that fires four
// times out of five on "the 1H has no opinion" is not a filter, it is silence.
//
// So the 15M alone decides WHETHER, and the 1H is read, recorded and attached
// to the signal as `confirmation` — a fact travelling with the alert instead
// of a veto. It never silently changes the verdict; it changes what the alert
// tells him, so he can weigh a 15M-only trigger differently from a fully
// aligned one at the moment he sees it.
//
// TO MAKE THE 1H A HARD VETO (his call, not a side effect): in readHTF below,
// refuse when `confirmation !== CONFIRMATION.CONFIRMED`. Expect the gate to
// open on roughly one check in five.
//
// The four confirmation states stay distinct for the same reason the refusal
// codes do: "1H disagrees" (a real opposing read) and "1H unavailable" (no
// bars) are different facts, and collapsing them would relaunch the exact
// confusion this module exists to prevent.
//
// PURE. No I/O, no clock, no chart — the caller supplies the bars.

// ── STRUCTURE IS READ OFF SWING PIVOTS, NOT CONSECUTIVE CANDLES ───────────
// 2026-09-01, corrected the same day it shipped. This first used
// classifyTrendFromBars, which counts bar-to-bar transitions and needs 60% of
// them to be higher highs AND higher lows. That is calibrated for the 5 bars
// get4HTrend feeds it, not for a real structure window, where it demands a run
// of consecutive higher highs that almost nothing real clears. See
// detectors.js's own header note; it is why the gate spent its first day
// reporting "structure unclear" — an app failing to READ, wearing the costume
// of a rule refusing a trade.
const { classifyStructureFromPivots } = require('./detectors');

// ── WHY THE 15M FLOOR IS 24 BARS AND NOT 12 ───────────────────────────────
// classifyStructureFromPivots returns a verdict from 5 bars, but a window that
// holds one swing is a coin flip wearing a label. Measured on the same 300 MNQ
// 15M bars, the clean-read rate by window size is:
//
//   12 bars    1.4%     <- not a strict reading, a structurally impossible one
//   16 bars   18.6%
//   24 bars   59.2%
//   40 bars   71.3%     <- what the caller actually feeds
//
// The 12-bar floor inherited from the 1H version would therefore have admitted
// a "verdict" from a window that produces one 1.4% of the time — i.e. it would
// have turned almost every short-history moment into a refusal indistinguishable
// from a real one. 24 is the point where the read starts being a read.
const MIN_BARS_15M = 24;
// The confirming 1H needs enough to be worth quoting, but it cannot block
// anything, so a thin window costs an UNAVAILABLE label rather than a trade.
const MIN_BARS_1H = 12;

// Refusal codes.
//
// NO_1H_DATA / UNCLEAR_1H / NO_4H_DATA / H4_DISAGREES are RETAINED and
// exported but are no longer reachable from a live read. The signal ledger
// already carries rows stamped with them, and a reader of that history must
// still be able to resolve the code it finds there. Their explain() text says
// out loud that they are historical, so nobody debugging a live gate chases
// one.
const REASONS = {
  OK: 'aligned',
  NO_15M_DATA: 'htf-15m-unavailable',
  UNCLEAR_15M: 'htf-15m-unclear',
  SETUP_DISAGREES: 'setup-against-htf-bias',
  // ── historical rows only, written before 2026-09-03 ──
  NO_1H_DATA: 'htf-1h-unavailable',
  UNCLEAR_1H: 'htf-1h-unclear',
  NO_4H_DATA: 'htf-4h-unavailable',
  H4_DISAGREES: 'htf-4h-disagrees-with-1h',
};

// What the 1H had to say about the 15M bias. Attached to every signal that
// fires; null when there is no bias for it to have an opinion about.
const CONFIRMATION = {
  CONFIRMED: 'confirmed',      // 1H structure matches the 15M bias
  DISAGREES: 'disagrees',      // 1H reads cleanly the OTHER way
  UNCLEAR: 'unclear',          // 1H readable but not a clean HH-HL / LL-LH
  UNAVAILABLE: 'unavailable',  // not enough 1H bars to read at all
};

function dirOf(direction) {
  const d = String(direction || '').toUpperCase();
  if (d === 'BULLISH' || d === 'LONG' || d === 'BUY') return 'bullish';
  if (d === 'BEARISH' || d === 'SHORT' || d === 'SELL') return 'bearish';
  return null;
}

/**
 * The higher-timeframe read, independent of any setup.
 *
 * Call this ONCE per check cycle and hand the result to every playbook, rather
 * than recomputing it per playbook — two playbooks disagreeing about the bias
 * in the same minute is the exact failure this module replaces.
 *
 * @param {Array} bars15m  15M bars, oldest first, forming bar already dropped.
 * @param {Array} bars1h   1H bars, same convention. Evidence only.
 * @returns {{bias:string|null, reason:string, structure15m:string|null,
 *            structure1h:string|null, confirmation:string|null, ok:boolean}}
 *   `bias` is 'bullish' | 'bearish' when ok, otherwise null. Never a guess.
 *   `confirmation` is a CONFIRMATION value when ok (what the 1H said about the
 *   bias), and null when there is no bias for it to have an opinion about.
 */
function readHTF(bars15m, bars1h) {
  const out = {
    bias: null, reason: REASONS.NO_15M_DATA,
    structure15m: null, structure1h: null,
    confirmation: null, ok: false,
  };

  if (!Array.isArray(bars15m) || bars15m.length < MIN_BARS_15M) return out;
  // THE structure read. HH-HL / LL-LH, on 15M, and nowhere else.
  const s15 = classifyStructureFromPivots(bars15m);
  out.structure15m = s15;

  // The 1H is read whatever the 15M said, because it is reported either way —
  // but it is read as evidence and can no longer refuse anything.
  const has1h = Array.isArray(bars1h) && bars1h.length >= MIN_BARS_1H;
  const s1 = has1h ? classifyStructureFromPivots(bars1h) : null;
  if (has1h) out.structure1h = s1;

  // The 15M alone decides whether there is a bias at all.
  if (s15 !== 'bullish' && s15 !== 'bearish') {
    out.reason = REASONS.UNCLEAR_15M;
    return out;   // confirmation stays null: no bias for the 1H to confirm
  }

  out.bias = s15;
  out.ok = true;
  out.reason = REASONS.OK;
  out.confirmation = !has1h ? CONFIRMATION.UNAVAILABLE
    : s1 === s15 ? CONFIRMATION.CONFIRMED
    : (s1 === 'bullish' || s1 === 'bearish') ? CONFIRMATION.DISAGREES
    : CONFIRMATION.UNCLEAR;
  return out;
}

/**
 * Does a setup survive the gate? Takes the ALREADY-COMPUTED htf read, so every
 * playbook in a cycle is judged against the identical bias.
 *
 * NOTE (2026-09-03): Playbook A no longer calls this as a VETO — Anoop wants
 * every closed engulfing reported in both directions and picks the side
 * himself. It still gates Playbook B and Playbook C (ADX), and A still carries
 * its answer as evidence on the alert. See server.js's engulf monitor.
 *
 * @param {object} htf        result of readHTF()
 * @param {string} direction  the setup's direction
 */
function checkSetup(htf, direction, unclearPolicy) {
  const policy = unclearPolicy || 'refuse';
  const setup = dirOf(direction);
  const h = htf || {};
  const base = {
    allowed: false,
    reason: h.reason || REASONS.NO_15M_DATA,
    bias: h.bias || null,
    setup,
    structure15m: h.structure15m || null,
    structure1h: h.structure1h || null,
    // carried through so the caller can attach it to the signal without
    // re-reading the higher timeframe and risking a different answer
    confirmation: h.confirmation || null,
    // G4: marks a 15M-UNCLEAR trade that was ALLOWED by an explicit policy,
    // so the shadow row can never be mistaken for a clean-bias setup.
    htfConfirmation: null,
  };
  if (!h.ok || !h.bias) {
    // Gate never opened on the 15M. G4: an UNCLEAR 15M may be relaxed per-policy
    // (shadow-only C-ADX), but a direction mismatch is NEVER relaxed under any
    // policy value — "refuse-unless-1h-clean" only admits a setup whose side the
    // 1H cleanly agrees with, and only when the 15M was merely unclear.
    if (h.reason === REASONS.UNCLEAR_15M) {
      if (policy === 'refuse-unless-1h-clean') {
        const s1 = h.structure1h;
        if (s1 === 'bullish' || s1 === 'bearish') {
          if (setup === s1) {
            base.allowed = true;
            base.reason = REASONS.OK;
            base.bias = s1;                 // the 1H is the only clean read
            base.htfConfirmation = 'unclear';
            return base;
          }
          base.reason = REASONS.SETUP_DISAGREES;  // 1H clean but the OTHER way
          return base;
        }
        return base;  // 1H unclear or unavailable -> refuse
      }
      if (policy === 'alert-unlabelled') {
        base.allowed = true;
        base.reason = REASONS.OK;
        base.htfConfirmation = 'unclear';
        return base;
      }
    }
    return base;
  }
  if (setup !== h.bias) {
    base.reason = REASONS.SETUP_DISAGREES;
    return base;
  }
  base.allowed = true;
  base.reason = REASONS.OK;
  return base;
}

// The 1H's verdict as a phrase for the alert. Every branch says out loud that
// the trade is 15M-only when the 1H did not confirm — the alert is where he
// actually decides, so the evidence has to be IN it, not merely in a log line.
// Guards on `confirmation` rather than `ok` so it accepts BOTH shapes: a
// readHTF() result (which has `ok`) and a checkSetup() result (which has
// `allowed`). confirmation is non-null exactly when a bias exists, which is
// exactly when there is something for the 1H to have confirmed or not.
function confirmationNote(res) {
  if (!res || !res.confirmation) return '';
  switch (res.confirmation) {
    case CONFIRMATION.CONFIRMED:
      return 'WITH the higher timeframe (15M ' + res.structure15m + ', 1H ' + res.structure1h + ')';
    case CONFIRMATION.DISAGREES:
      return '15M ONLY — 1H DISAGREES (15M ' + res.structure15m + ', 1H ' + res.structure1h + ')';
    case CONFIRMATION.UNCLEAR:
      return '15M ONLY — 1H unclear, it did not confirm (15M ' + res.structure15m + ')';
    case CONFIRMATION.UNAVAILABLE:
      return '15M ONLY — 1H unavailable, not read (15M ' + res.structure15m + ')';
    default:
      return '15M ' + res.structure15m;
  }
}

// One human-readable line naming the values that produced the decision, not
// just the verdict — a rejection nobody can audit is a rejection nobody trusts.
function explain(res) {
  if (!res) return 'HTF: no result';
  switch (res.reason) {
    case REASONS.OK:
      return 'HTF OK — bias ' + res.bias + '; ' + confirmationNote(res);
    case REASONS.NO_15M_DATA:
      return 'HTF UNAVAILABLE — no usable 15M bars. Refusing rather than guessing.';
    case REASONS.UNCLEAR_15M:
      return 'NO TRADE — 15M structure is ' + (res.structure15m || 'unclear')
        + ', not a clean HH-HL or LL-LH. No bias, so nothing gated may fire.';
    case REASONS.SETUP_DISAGREES:
      return 'NO TRADE — setup is ' + res.setup + ' against a ' + res.bias + ' higher-timeframe bias.';
    // Retained for reading BACK ledger rows written before 2026-09-03. None of
    // these is reachable from a live read any more.
    case REASONS.NO_1H_DATA:
      return 'HTF (historical row) — refused when structure was read on the 1H and no usable 1H bars existed.';
    case REASONS.UNCLEAR_1H:
      return 'HTF (historical row) — 1H structure read ' + (res.structure1h || 'unclear')
        + ' when the 1H was the deciding timeframe.';
    case REASONS.NO_4H_DATA:
      return 'HTF (historical row) — 1H read ' + res.structure1h + ' with no usable 4H bars.';
    case REASONS.H4_DISAGREES:
      return 'HTF (historical row) — 1H was ' + res.structure1h + ', 4H was ' + res.structure4h
        + '; refused when the 4H still had a veto.';
    default:
      return 'HTF: ' + res.reason;
  }
}

module.exports = {
  readHTF, checkSetup, explain, confirmationNote, dirOf,
  REASONS, CONFIRMATION, MIN_BARS_15M, MIN_BARS_1H,
};
