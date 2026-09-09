const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SR = require('../stage-rules.js');

// The real shipped config — several tests below assert against THIS rather than
// a fixture, because the whole point of the stage layer is what the live file
// actually produces. A fixture that drifts from rules.json would pass while the
// app misbehaves.
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));

// Mirrors getActiveRules() in server.js: base -> scalperRules -> stageRules.
function effective(stage, mode) {
  let merged = RULES;
  if (mode === 'scalper') {
    merged = Object.assign({}, RULES, RULES.scalperRules || {});
    merged.tradingMode = 'scalper';
  }
  return SR.applyStageRules(merged, stage);
}

// ── The four combinations ────────────────────────────────────────────────────

test('normal + eval: eval permits 4, trade count stays at the mode\'s base', () => {
  const r = effective('eval', 'standard');
  assert.strictEqual(r.sizeCap, 4, 'SUPERSEDED AGAIN 2026-09-04/05 — see the decision-history test below');
  assert.strictEqual(r.sizeFloor, 2);
  // RAISED 5 -> 10 (2026-09-10, Anoop's own instruction, root rules.json
  // tradesPerDay). eval's stageRules block carries no tradesPerDay override,
  // so this passes through unclamped — proving the same invariant the old
  // '5' proved ('eval must NOT raise the trade count — count is owned by
  // tradingMode'), just at the new base value.
  assert.strictEqual(r.tradesPerDay, 10, 'eval must NOT raise the trade count — count is owned by tradingMode');
  assert.strictEqual(r.contractsPerDay.max, 36);
  assert.strictEqual(r.maxHoldSeconds, 1800);
});

test('normal + funded: everything clamps to the safe base', () => {
  const r = effective('funded', 'standard');
  assert.strictEqual(r.sizeCap, 2);
  assert.strictEqual(r.sizeFloor, 2);
  // RAISED base 5 -> 10 (2026-09-10). funded's OWN tradesPerDay (6) is still
  // the tighter side of the clamp either way — min(10, 6) = 6, same as
  // min(5, 6) = 5 was before. The invariant this test protects (funded wins
  // when it's tighter) is unchanged; only the losing side of the min moved.
  assert.strictEqual(r.tradesPerDay, 6, 'min(mode 10, funded 6) = 6');
  assert.strictEqual(r.contractsPerDay.max, 12);
  assert.strictEqual(r.dailyLossCap, 200);
});

test('scalper + eval: fast holds, eval size 4, 10 trades', () => {
  const r = effective('eval', 'scalper');
  assert.strictEqual(r.sizeCap, 4, 'scalper must not change SIZE — only speed and count');
  assert.strictEqual(r.tradesPerDay, 10);
  assert.strictEqual(r.maxHoldSeconds, 900, 'scalper tightens the hold ceiling to 15 min');
  assert.strictEqual(r.contractsPerDay.max, 36);
});

test('scalper + funded: scalper speed, funded size and count', () => {
  const r = effective('funded', 'scalper');
  assert.strictEqual(r.sizeCap, 2);
  assert.strictEqual(r.tradesPerDay, 6, 'min(scalper 10, funded 6) = 6');
  assert.strictEqual(r.maxHoldSeconds, 900, 'hold time is a MODE concern — funded must not undo it');
  assert.strictEqual(r.contractsPerDay.max, 12);
  assert.strictEqual(r.dailyLossCap, 200);
});

// ── The regression this whole module exists to prevent ───────────────────────

test('THE BUG THIS PREVENTS: scalper mode can never raise the size cap on a funded account', () => {
  // Before 2026-08-15, scalperRules carried sizeCap:4 and there was no stage
  // layer at all — so flipping the scalper toggle on the funded account
  // doubled the size cap from 2 to 4 with no other action and no warning.
  // Funded is the account where every size except 2 loses money.
  const hostile = Object.assign({}, RULES, { sizeCap: 4 }); // as if a mode layer had raised it
  const r = SR.applyStageRules(hostile, 'funded');
  assert.strictEqual(r.sizeCap, 2, 'the funded clamp must win over any upstream layer');
});

test('the funded clamp is one-way: a LOOSER funded block still cannot loosen', () => {
  // Guards against a future edit to rules.json raising the funded numbers by
  // mistake — the clamp takes the tighter of the two, never the config value
  // on faith.
  const loose = JSON.parse(JSON.stringify(RULES));
  loose.stageRules.funded.sizeCap = 8;
  loose.stageRules.funded.tradesPerDay = 50;
  const r = SR.applyStageRules(loose, 'funded');
  // 2026-09-05: this asserted a literal 2, which was only true while the BASE
  // sizeCap was also 2. The base is now Anoop's adjustable 2..6 dial, so the
  // guarantee this test actually protects is the INVARIANT, not the number:
  // a loosened funded block can never produce a cap looser than the base.
  assert.strictEqual(r.sizeCap, RULES.sizeCap, 'min(base, funded 8) = base — never the 8');
  assert.ok(r.sizeCap < 8, 'the loosened config value must never win');
  // RAISED 5 -> 10 (2026-09-10) with the base itself — this test's fake
  // funded override (50) is still far looser than the base on either number,
  // so the invariant it protects (funded can never LOOSEN past the base) is
  // exercised identically; only the literal moved with the base.
  assert.strictEqual(r.tradesPerDay, 10, 'min(base 10, funded 50) = 10');
});

test('sizeFloor clamps by MAX, not MIN — a higher floor is the tighter one', () => {
  // Getting this direction wrong would silently re-allow the 1-contract trades
  // that lose money in both stages (-$706 combined over 25 trades).
  const r = SR.applyStageRules(Object.assign({}, RULES, { sizeFloor: 1 }), 'funded');
  assert.strictEqual(r.sizeFloor, 2);
});

// ── Fail-safe behaviour ──────────────────────────────────────────────────────

test('a missing stageRules block FAILS CLOSED to the tightest cap', () => {
  // REWRITTEN 2026-09-05. This used to assert "untouched IS safe", which held
  // only while the base sizeCap was 2 — the base was effectively the funded
  // ruleset, so any failure of the stage layer landed on the tightest number in
  // the file. Once the base became the adjustable 2..6 dial (currently 4) that
  // assumption inverted, and a missing block handed back 4 on a FUNDED account.
  // The module now clamps DOWN instead of passing the base through.
  const bare = Object.assign({}, RULES);
  delete bare.stageRules;
  const r = SR.applyStageRules(bare, 'eval');
  assert.strictEqual(r.sizeCap, 2, 'no stageRules at all → the hard floor, not the base');
  assert.ok(r.sizeCap <= RULES.sizeCap, 'a failure of this layer may only ever tighten');
});

test('a malformed stageRules block does not throw and does not loosen', () => {
  // Two different kinds of malformed, and they are NOT the same failure:
  //   - the block cannot be resolved at all  → fail closed to the hard floor
  //   - the block exists but carries a junk VALUE → the junk is ignored and the
  //     base stands (nothing was loosened, which is the property that matters)
  // In neither case may the cap end up looser than the base.
  const unusable = [null, 'nonsense', 42, [], { eval: 'not-an-object' }];
  for (const junk of unusable) {
    const bad = Object.assign({}, RULES, { stageRules: junk });
    let r;
    assert.doesNotThrow(() => { r = SR.applyStageRules(bad, 'eval'); });
    assert.strictEqual(r.sizeCap, 2, 'an unusable stageRules block must fail closed: ' + JSON.stringify(junk));
  }
  const junkValue = Object.assign({}, RULES, { stageRules: { eval: { sizeCap: 'huge' } } });
  let r2;
  assert.doesNotThrow(() => { r2 = SR.applyStageRules(junkValue, 'eval'); });
  assert.strictEqual(r2.sizeCap, RULES.sizeCap, 'a junk value is ignored, the base stands');
  assert.ok(r2.sizeCap <= RULES.sizeCap, 'garbage config must never RAISE the cap');
});

test('an unknown stage falls through to the base rules rather than guessing', () => {
  const r = SR.applyStageRules(RULES, 'not-a-stage');
  assert.strictEqual(r.sizeCap, 2);
  assert.strictEqual(r.contractsPerDay.max, 12);
});

test('null/garbage rules input is returned as-is instead of throwing', () => {
  assert.strictEqual(SR.applyStageRules(null, 'eval'), null);
  assert.strictEqual(SR.applyStageRules(undefined, 'funded'), undefined);
  assert.doesNotThrow(() => SR.applyStageRules('nope', 'eval'));
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the input rules object is never mutated, including its nested objects', () => {
  const before = JSON.parse(JSON.stringify(RULES));
  const src = JSON.parse(JSON.stringify(RULES));
  SR.applyStageRules(src, 'eval');
  SR.applyStageRules(src, 'funded');
  assert.deepStrictEqual(src, before,
    'applyStageRules must be pure — getActiveRules() calls it on every request');
});

test('nested contractsPerDay.max is rewritten without dropping its siblings', () => {
  const r = SR.applyStageRules(RULES, 'eval');
  assert.strictEqual(r.contractsPerDay.max, 36);
  assert.strictEqual(r.contractsPerDay.enabled, RULES.contractsPerDay.enabled);
  assert.strictEqual(r.contractsPerDay.warnAtPct, RULES.contractsPerDay.warnAtPct);
});

test('the stage is stamped on the output so downstream code can report it', () => {
  assert.strictEqual(SR.applyStageRules(RULES, 'eval').stage, 'eval');
  assert.strictEqual(SR.applyStageRules(RULES, 'funded').stage, 'funded');
});

test('_comment keys inside a stage block are ignored, not promoted over the file\'s own', () => {
  // rules.json carries a top-level _comment of its own, and every stage block
  // carries a different one. The stage block's must not clobber it — and more
  // importantly, no `_`-prefixed key may ever be treated as a live rule.
  assert.ok(typeof RULES.stageRules.eval._comment === 'string', 'fixture sanity: the block really does carry a comment');
  const r = SR.applyStageRules(RULES, 'eval');
  assert.strictEqual(r._comment, RULES._comment, 'the file\'s own top-level comment survives untouched');
  assert.notStrictEqual(r._comment, RULES.stageRules.eval._comment);
});

// ── Guards on the shipped numbers themselves ─────────────────────────────────
// These assert Anoop's decisions of 2026-08-15, so a later casual edit to
// rules.json has to consciously break a named test rather than slip through.

test('DECIDED 2026-08-15: funded size is fixed at exactly 2, floor and cap', () => {
  const r = effective('funded', 'standard');
  assert.strictEqual(r.sizeCap, 2);
  assert.strictEqual(r.sizeFloor, 2);
});

test('SUPERSEDED 2026-08-31: eval caps at 2, not 4 — "its 2 everything"', () => {
  // HISTORY, kept deliberately. On 2026-08-15 eval was allowed 4 on the
  // evidence that 3-4 contracts made +$2,007 in eval while 5-6 made only +$506
  // (and +$24 with its single best trade removed) — so 4 looked like the honest
  // ceiling and 6 did not.
  //
  // OVERRIDDEN by Anoop on 2026-08-31, verbatim: "its 2 everything".
  //
  // What changed his mind was not the backtest, it was the 2026-08-31 oversize
  // incident: the guard read the eval cap as 4, so a LONG 5 was reduced by 1
  // instead of 3 — six times, on a frozen read, ending SHORT 1. Two definitions
  // of "his size cap" existed in one file (base 2, stageRules.eval 4), and the
  // guard enforced the looser one while the Week tab, mind_log, day-rollup and
  // CLAUDE.md all called anything over 2 oversize.
  //
  // The lesson is not "4 was wrong on the numbers" — it is that a stage layer
  // permitted to LOOSEN the single most dangerous rule gives the app two
  // answers to the one question that can end the account.
  // SUPERSEDED AGAIN on 2026-09-04, and this time it is not a reversal of the
  // lesson above — it is the lesson applied. Anoop, verbatim: "make size
  // changeable from 2 minimum to 6 as maximum size so that i always use it and
  // not go beyond 6 size. i can handle 6 but yesterday i took 20 size which was
  // unacceptable." On 2026-09-03 he traded 20 lots against a cap of 2, so the
  // cap of 2 was not being enforced by agreement at all. A ceiling he trades
  // inside beats a lower one he ignores.
  //
  // What did NOT change is the thing the 2026-08-31 incident was actually
  // about: there is still exactly ONE answer to "what is his size cap", it is
  // still bounded in code (2..6), and no layer may raise it above the base.
  // Those assertions live below and must never be relaxed.
  //
  // FUNDED was pulled back to 2 on 2026-09-05 (Anoop, asked directly: "No,
  // funded stays at 2"). It had been raised to 4 as a side effect of making the
  // top-level cap adjustable, against his own funded record of -$1,717 across
  // every size except 2.
  assert.strictEqual(effective('eval', 'standard').sizeCap, 4, 'eval permits 4');
  assert.strictEqual(effective('eval', 'scalper').sizeCap, 4, 'scalper does not change size');
  assert.strictEqual(effective('funded', 'standard').sizeCap, 2, 'funded stays at 2 — 2026-09-05');
  assert.strictEqual(effective('funded', 'scalper').sizeCap, 2, 'funded stays at 2 in every mode');
});

// The bound that replaced the flat "always 2": whatever any layer does, the
// effective cap must land inside the 2..6 range Anoop set for himself.
test('DECIDED 2026-09-04: the effective cap is always within 2..6, in every combination', () => {
  for (const stage of ['eval', 'funded']) {
    for (const mode of ['standard', 'scalper']) {
      const cap = effective(stage, mode).sizeCap;
      assert.ok(cap >= 2 && cap <= 6, stage + '+' + mode + ' cap ' + cap + ' escaped the 2..6 bound');
    }
  }
});

test('NO stage or mode may ever raise the size cap above the base', () => {
  // The structural version of the rule above: whatever else the layers do,
  // size may only ever be clamped DOWN. This is the assertion that would have
  // caught the incident config before it reached a live account.
  for (const stage of ['eval', 'funded']) {
    for (const mode of ['standard', 'scalper']) {
      const r = effective(stage, mode);
      assert.ok(r.sizeCap <= RULES.sizeCap,
        `${mode}+${stage}: sizeCap ${r.sizeCap} must never exceed the base ${RULES.sizeCap}`);
    }
  }
});

test('DECIDED 2026-08-15: no 1-contract trades in either stage', () => {
  assert.strictEqual(effective('eval', 'standard').sizeFloor, 2);
  assert.strictEqual(effective('funded', 'standard').sizeFloor, 2);
  assert.strictEqual(effective('eval', 'scalper').sizeFloor, 2);
  assert.strictEqual(effective('funded', 'scalper').sizeFloor, 2);
});

test('the size cap is never below the size floor in any of the four combinations', () => {
  // A config edit that inverted these would make every trade illegal and lock
  // him out mid-session.
  for (const stage of ['eval', 'funded']) {
    for (const mode of ['standard', 'scalper']) {
      const r = effective(stage, mode);
      assert.ok(r.sizeCap >= r.sizeFloor,
        `${mode}+${stage}: sizeCap ${r.sizeCap} must be >= sizeFloor ${r.sizeFloor}`);
    }
  }
});

test('scalper never holds longer than normal, in either stage', () => {
  for (const stage of ['eval', 'funded']) {
    assert.ok(effective(stage, 'scalper').maxHoldSeconds <= effective(stage, 'standard').maxHoldSeconds,
      `${stage}: scalper hold ceiling must be the tighter one`);
  }
});

// ── The Cap control must never raise the FUNDED cap (2026-09-08) ─────────────
// Anoop was asked directly on 2026-09-05 and said "No, funded stays at 2". The
// file was changed. At 21:05 the same day a nudge of the titlebar Cap control
// put it straight back to 4, because the rules-set handler forced BOTH stage
// blocks to the dial value. He was never told, and the funded block is not
// shown anywhere in the UI.
//
// This reproduces the handler's own logic (server.js `case 'rules-set'`) rather
// than importing it — server.js starts a live server on require. If that
// handler is ever rewritten to touch the funded block again, this fails.
test('the size dial moves EVAL only — funded is never raised by the UI', () => {
  const chosen = 6;
  const next = JSON.parse(JSON.stringify(RULES));
  next.stageRules.funded.sizeCap = 2;

  // …the handler, as it must behave:
  const cap = SR.clampSizeCap(chosen, next);
  next.sizeCap = cap;
  if (next.stageRules && next.stageRules.eval) next.stageRules.eval.sizeCap = cap;
  // (and deliberately NOTHING for funded)

  assert.strictEqual(next.stageRules.funded.sizeCap, 2, 'the dial must not rewrite the funded block');
  assert.strictEqual(SR.applyStageRules(next, 'funded').sizeCap, 2,
    'funded clamps by MIN, so his dial may lower funded but never raise it');
  assert.strictEqual(SR.applyStageRules(next, 'eval').sizeCap, cap, 'eval follows the dial');
});

test('the dial CAN still tighten funded below its own block value', () => {
  // The ratchet is one-way, not frozen: turning the dial down to 2 while the
  // funded block says 4 must give 2, or "tighten everything now" would silently
  // not apply to the account that matters most.
  const next = JSON.parse(JSON.stringify(RULES));
  next.stageRules.funded.sizeCap = 4;
  const cap = SR.clampSizeCap(2, next);
  next.sizeCap = cap;
  if (next.stageRules && next.stageRules.eval) next.stageRules.eval.sizeCap = cap;
  assert.strictEqual(SR.applyStageRules(next, 'funded').sizeCap, 2, 'min(dial 2, funded 4) = 2');
});
