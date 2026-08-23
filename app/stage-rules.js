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
    if (!block || typeof block !== 'object') return out;

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

module.exports = { applyStageRules, TIGHTEN_BY_MIN, TIGHTEN_BY_MAX, NESTED };
