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

test('normal + eval: size opens to 4, trade count stays at the mode\'s 5', () => {
  const r = effective('eval', 'standard');
  assert.strictEqual(r.sizeCap, 4);
  assert.strictEqual(r.sizeFloor, 2);
  assert.strictEqual(r.tradesPerDay, 5, 'eval must NOT raise the trade count — count is owned by tradingMode');
  assert.strictEqual(r.contractsPerDay.max, 36);
  assert.strictEqual(r.maxHoldSeconds, 1800);
});

test('normal + funded: everything clamps to the safe base', () => {
  const r = effective('funded', 'standard');
  assert.strictEqual(r.sizeCap, 2);
  assert.strictEqual(r.sizeFloor, 2);
  assert.strictEqual(r.tradesPerDay, 5, 'min(mode 5, funded 6) = 5');
  assert.strictEqual(r.contractsPerDay.max, 12);
  assert.strictEqual(r.dailyLossCap, 200);
});

test('scalper + eval: fast holds AND the bigger size, 10 trades', () => {
  const r = effective('eval', 'scalper');
  assert.strictEqual(r.sizeCap, 4);
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
  assert.strictEqual(r.sizeCap, 2, 'min(base 2, funded 8) = 2');
  assert.strictEqual(r.tradesPerDay, 5, 'min(base 5, funded 50) = 5');
});

test('sizeFloor clamps by MAX, not MIN — a higher floor is the tighter one', () => {
  // Getting this direction wrong would silently re-allow the 1-contract trades
  // that lose money in both stages (-$706 combined over 25 trades).
  const r = SR.applyStageRules(Object.assign({}, RULES, { sizeFloor: 1 }), 'funded');
  assert.strictEqual(r.sizeFloor, 2);
});

// ── Fail-safe behaviour ──────────────────────────────────────────────────────

test('a missing stageRules block leaves the rules untouched — and untouched IS safe', () => {
  const bare = Object.assign({}, RULES);
  delete bare.stageRules;
  const r = SR.applyStageRules(bare, 'eval');
  assert.strictEqual(r.sizeCap, RULES.sizeCap, 'falls back to the base, which is the FUNDED ruleset');
  assert.strictEqual(r.sizeCap, 2);
});

test('a malformed stageRules block does not throw and does not loosen', () => {
  for (const junk of [null, 'nonsense', 42, [], { eval: 'not-an-object' }, { eval: { sizeCap: 'huge' } }]) {
    const bad = Object.assign({}, RULES, { stageRules: junk });
    let r;
    assert.doesNotThrow(() => { r = SR.applyStageRules(bad, 'eval'); });
    assert.strictEqual(r.sizeCap, 2, 'garbage config must never raise the cap above the safe base');
  }
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

test('DECIDED 2026-08-15: eval caps at 4, NOT the 6 from the handwritten note', () => {
  // 5-6 contracts in eval is +$506 that becomes +$24 once its single best
  // trade is removed — one lucky trade, not an edge.
  assert.strictEqual(effective('eval', 'standard').sizeCap, 4);
  assert.strictEqual(effective('eval', 'scalper').sizeCap, 4);
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
