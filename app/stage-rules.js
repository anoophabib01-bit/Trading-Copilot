// ── Stage rules: the eval/funded risk layer (2026-08-15) ─────────────────────
// Anoop, 2026-08-15: "I want to risk aggressively in evaluation and be very
// secure when I'm creating a funded account... Spend less time in evaluation,
// more time in funded."
//
// WHY THIS IS A SEPARATE AXIS FROM tradingMode
//
// Until now every risk number lived on ONE axis: tradingMode (standard vs
// scalper), with scalperRules overlaying the base. That conflated two
// genuinely independent questions:
//
//   tradingMode  = HOW he trades      → hold time, entry candle, trade count
//   stage        = HOW MUCH he may lose → contract size, contracts/day, day cap
//
// Keeping size on the tradingMode axis meant switching to scalper mode on a
// FUNDED account silently raised his size cap — the single change his own data
// says destroys that account.
//
// WHAT THE DATA SAID (109 de-duplicated trades, 27 Jul – 13 Aug 2026; note the
// report at DATA/trading_strategy_report.html double-counted slot s1 and its
// headline numbers are inflated — these are the corrected figures):
//
//   Contract size, net P&L by stage:
//     1c   eval -$361  funded -$345   ← loses in BOTH. Hence sizeFloor.
//     2c   eval +$535  funded +$264   ← the ONLY size profitable in both.
//     3-4c eval +$2007 funded -$540
//     5-6c eval +$506  funded -$384   ← eval figure is one +$482 trade; fragile.
//     7c+  eval +$128  funded -$449
//
//   Total contracts per day:
//     eval   days >12 contracts: 6 of 6 GREEN, +$2,865
//     funded days >12 contracts: 0 of 3 green, -$1,763
//     → the existing contractsPerDay cap of 12 is exactly right for funded and
//       exactly backwards for eval.
//
//   Intraday daily-loss stop, simulated by walking each day's trades in order:
//     eval   every cap level COSTS money (-$221 at $200, -$582 at $500)
//     funded every cap level SAVES money, monotonically (+$795 at $200)
//     → dailyLossCap 200 on funded only. Matches the dayStop.funded already in
//       rules.json, which was never actually enforced.
//
// THE FAIL-SAFE PROPERTY (the reason funded is the BASE and eval is the overlay)
//
// The base rules in rules.json are the FUNDED (safe) numbers. `eval` PERMITS
// upward from there; `funded` CLAMPS and can only ever tighten. So if the
// stageRules block is ever missing, malformed, or fails to load, the fallthrough
// is funded-strictness on an eval account — annoying and harmless. The inverse
// design (aggressive base, funded tightens) would fail to eval-aggression on a
// funded account, which is precisely the 2026-08-10 shape: 6 trades, sizes up
// to 9 lots, -$855.50.
//
// This mirrors lossRatchet's `mode: "min"` already in rules.json — a one-way
// ratchet that can only tighten — rather than introducing a new concept.
//
// LAYER ORDER: base rules → scalperRules (if scalper) → stageRules (always).
// Stage is applied LAST so nothing downstream can loosen it.

// Which direction counts as "tighter" for the funded clamp. Getting this wrong
// silently inverts the protection, so it is explicit per key rather than
// inferred: a lower cap is tighter, but a HIGHER floor is tighter.
const TIGHTEN_BY_MIN = ['sizeCap', 'tradesPerDay', 'tradesPerSession', 'contractsPerDayMax', 'dailyLossCap', 'scorerTradesPerDayLimit'];
const TIGHTEN_BY_MAX = ['sizeFloor'];

// Keys that stageRules owns but which live under a nested object in rules.json.
// contractsPerDay is {enabled, max, warnAtPct}; only `max` is stage-dependent.
const NESTED = { contractsPerDayMax: ['contractsPerDay', 'max'] };

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function readKey(rules, key) {
  const path = NESTED[key];
  if (!path) return rules[key];
  const parent = rules[path[0]];
  return parent ? parent[path[1]] : undefined;
}

function writeKey(rules, key, val) {
  const path = NESTED[key];
  if (!path) { rules[key] = val; return; }
  // Copy the nested object rather than mutating the caller's — loadRules()
  // returns a fresh top-level object but its nested values are shared.
  rules[path[0]] = Object.assign({}, rules[path[0]] || {});
  rules[path[0]][path[1]] = val;
}

/**
 * Apply the eval/funded layer on top of already-mode-merged rules.
 *
 * @param {object} rules  base rules, already merged with scalperRules if scalper
 * @param {string} stage  'eval' | 'funded'
 * @returns {object} a new rules object; the input is never mutated
 *
 * Fails OPEN in the sense that matters here: any missing/malformed stageRules
 * block returns the input unchanged rather than throwing. Because the base IS
 * the funded ruleset, "unchanged" is already the safe state — this is the one
 * place where failing open and failing safe are the same thing.
 */
function applyStageRules(rules, stage) {
  try {
    if (!rules || typeof rules !== 'object') return rules;
    const out = Object.assign({}, rules);
    const block = rules.stageRules && rules.stageRules[stage];
    if (!block || typeof block !== 'object') {
      // ── FAIL CLOSED (2026-09-05) ─────────────────────────────────────────
      // A missing stageRules block, a malformed one, or an unrecognised stage
      // used to return the base rules untouched. That WAS safe while the base
      // sizeCap was 2 — the base was effectively the funded ruleset, so any
      // failure of this layer landed on the tightest number in the file.
      //
      // On 2026-09-04 the base became Anoop's adjustable 2..6 dial (currently
      // 4), and that assumption silently inverted: the same three failures now
      // hand back 4 while he is on a FUNDED account, where his own record says
      // every size except 2 loses money (-$1,717 over 31 trades).
      //
      // So when the stage cannot be resolved, size clamps DOWN to the tightest
      // value the file can still be trusted to state: the funded block's own
      // cap when it is readable, else the hard floor. Nothing else is touched —
      // this narrows exactly the one rule that can end the account, and the
      // three fail-safe tests in stage-rules.test.js pin it.
      const fundedCap = rules.stageRules
        && rules.stageRules.funded
        && isNum(rules.stageRules.funded.sizeCap)
        ? rules.stageRules.funded.sizeCap
        : SIZE_CAP_HARD_MIN;
      const safest = Math.min(isNum(out.sizeCap) ? out.sizeCap : SIZE_CAP_HARD_MAX, fundedCap);
      if (isNum(safest)) out.sizeCap = safest;
      return out;
    }

    const clamp = stage === 'funded';

    Object.keys(block).forEach(function (key) {
      if (key === 'clampMode' || key.charAt(0) === '_') return;
      const want = block[key];
      if (!isNum(want)) return;

      if (!clamp) {
        // eval: permit. Raise (or lower) to exactly what the block asks for.
        writeKey(out, key, want);
        return;
      }

      // funded: clamp. Never loosen, whatever any earlier layer decided.
      const cur = readKey(out, key);
      if (!isNum(cur)) { writeKey(out, key, want); return; }
      if (TIGHTEN_BY_MAX.indexOf(key) !== -1) writeKey(out, key, Math.max(cur, want));
      else if (TIGHTEN_BY_MIN.indexOf(key) !== -1) writeKey(out, key, Math.min(cur, want));
      else writeKey(out, key, want);
    });

    out.stage = stage;
    return out;
  } catch (e) {
    return rules;
  }
}

// ── User-adjustable size cap, hard-bounded (2026-09-04) ─────────────────────
// Anoop: "the size guard is too small or off which was the reason for account
// to blow up so make size changeable from 2 minimum to 6 as maximum size so
// that i always use it and not go beyond 6 size. i can handle 6 but yesterday
// i took 20 size which was unacceptable."
//
// I OWE HIM THE DISAGREEMENT, because it is his own data: rules.json's
// _sizeCap_comment records the cap being cut from 6 to 2 on 2026-07-28 after
// the 150K breach, and stageRules.funded records every funded size except 2
// losing money — 1c -$345, 3c -$437, 4c -$103, 5-6c -$384, 7c+ -$449,
// -$1,717 across 31 trades. A cap of 6 is looser than what that evidence
// supports.
//
// It is still the right change, for a reason the evidence does not cover: a
// limit he routes around is worth nothing. He went to 20 against a cap of 2.
// A cap of 6 that he actually trades inside is a smaller number than 20 every
// day of the week, and the ceiling below is what makes 20 impossible rather
// than merely discouraged.
//
// TWO SEPARATE THINGS, deliberately:
//   sizeCap    — what he has chosen today. His to move, inside the bounds.
//   HARD_MAX   — what he can never choose. Not his to move from the UI.
// The ceiling is applied in getActiveRules() AFTER every other layer, so no
// stage block, scalper overlay, hand-edit of rules.json or rules-set message
// can produce an effective cap above it. That is the whole point: the old cap
// was enforced by agreement, and agreement is what failed.
const SIZE_CAP_HARD_MIN = 2;
const SIZE_CAP_HARD_MAX = 6;

function sizeCapBounds(rules) {
  const r = rules || {};
  let lo = isNum(r.sizeCapMin) ? r.sizeCapMin : SIZE_CAP_HARD_MIN;
  let hi = isNum(r.sizeCapMax) ? r.sizeCapMax : SIZE_CAP_HARD_MAX;
  // rules.json may tighten the range but never widen it past the hard bounds.
  lo = Math.max(SIZE_CAP_HARD_MIN, Math.floor(lo));
  hi = Math.min(SIZE_CAP_HARD_MAX, Math.floor(hi));
  if (hi < lo) hi = lo;
  return { min: lo, max: hi };
}

/** Clamp a requested cap into the allowed range. Non-numeric input returns
 *  the minimum, never the maximum — a garbled message must fail SAFE. */
function clampSizeCap(want, rules) {
  const b = sizeCapBounds(rules);
  const n = Math.floor(Number(want));
  if (!isFinite(n)) return b.min;
  return Math.min(b.max, Math.max(b.min, n));
}

/** The ceiling nothing may exceed. Applied last, to the merged ruleset. */
function enforceSizeCapCeiling(rules) {
  if (!rules || typeof rules !== 'object') return rules;
  const b = sizeCapBounds(rules);
  if (isNum(rules.sizeCap) && rules.sizeCap <= b.max) return rules;
  const out = Object.assign({}, rules);
  out.sizeCapCeilingApplied = isNum(rules.sizeCap) ? rules.sizeCap : null;
  out.sizeCap = isNum(rules.sizeCap) ? b.max : b.min;
  return out;
}

module.exports = {
  applyStageRules, TIGHTEN_BY_MIN, TIGHTEN_BY_MAX, NESTED,
  clampSizeCap, sizeCapBounds, enforceSizeCapCeiling,
  SIZE_CAP_HARD_MIN, SIZE_CAP_HARD_MAX
};
