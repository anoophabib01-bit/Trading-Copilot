const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sr = require('../stage-rules.js');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));

// 2026-09-03: Anoop traded 20 lots against a cap of 2. The cap was enforced by
// agreement, and agreement failed. These tests pin the ceiling that replaces it.
test('REGRESSION: a request for 20 contracts cannot get past the clamp', () => {
  assert.strictEqual(sr.clampSizeCap(20, RULES), 6);
});

test('the adjustable range really is 2..6 on the shipped rules.json', () => {
  assert.deepStrictEqual(sr.sizeCapBounds(RULES), { min: 2, max: 6 });
  for (const n of [2, 3, 4, 5, 6]) assert.strictEqual(sr.clampSizeCap(n, RULES), n);
});

test('below the floor clamps UP to 2 — 1-lot trading loses in both stages', () => {
  assert.strictEqual(sr.clampSizeCap(1, RULES), 2);
  assert.strictEqual(sr.clampSizeCap(0, RULES), 2);
  assert.strictEqual(sr.clampSizeCap(-9, RULES), 2);
});

// Garbage must fail toward the SAFE end, never the permissive one.
test('unparseable input fails safe to the minimum, never the maximum', () => {
  for (const junk of [null, undefined, NaN, 'lots', {}, [], Infinity]) {
    assert.strictEqual(sr.clampSizeCap(junk, RULES), 2, 'input: ' + String(junk));
  }
});

test('rules.json may tighten the range but can never widen it past 6', () => {
  assert.deepStrictEqual(sr.sizeCapBounds({ sizeCapMin: 2, sizeCapMax: 40 }), { min: 2, max: 6 });
  assert.deepStrictEqual(sr.sizeCapBounds({ sizeCapMin: 1, sizeCapMax: 6 }), { min: 2, max: 6 });
  // a deliberately tighter range is honoured
  assert.deepStrictEqual(sr.sizeCapBounds({ sizeCapMin: 2, sizeCapMax: 3 }), { min: 2, max: 3 });
  assert.strictEqual(sr.clampSizeCap(6, { sizeCapMin: 2, sizeCapMax: 3 }), 3);
});

test('an inverted range does not produce a max below the min', () => {
  const b = sr.sizeCapBounds({ sizeCapMin: 5, sizeCapMax: 3 });
  assert.ok(b.max >= b.min, 'max ' + b.max + ' < min ' + b.min);
});

// The ceiling is the backstop for everything the clamp does not see: a
// hand-edited rules.json, a stage block, a scalper overlay.
test('the ceiling caps a hand-edited rules.json', () => {
  const out = sr.enforceSizeCapCeiling(Object.assign({}, RULES, { sizeCap: 20 }));
  assert.strictEqual(out.sizeCap, 6);
  assert.strictEqual(out.sizeCapCeilingApplied, 20, 'the override must be recorded, not silent');
});

test('the ceiling leaves a legal cap untouched and allocates no new object', () => {
  const legal = Object.assign({}, RULES, { sizeCap: 4 });
  assert.strictEqual(sr.enforceSizeCapCeiling(legal), legal);
});

// applyStageRules writes the stage block's value verbatim in eval, so a cap
// raised only at the top level would be silently reverted on the next read.
test('the eval stage block cannot silently revert a raised cap', () => {
  const raised = JSON.parse(JSON.stringify(RULES));
  raised.sizeCap = 6;
  raised.stageRules.eval.sizeCap = 6;
  raised.stageRules.funded.sizeCap = 6;
  assert.strictEqual(sr.applyStageRules(raised, 'eval').sizeCap, 6);
  assert.strictEqual(sr.applyStageRules(raised, 'funded').sizeCap, 6);
});

test('stage + ceiling together still cannot exceed 6', () => {
  const wild = JSON.parse(JSON.stringify(RULES));
  wild.sizeCap = 50;
  wild.stageRules.eval.sizeCap = 50;
  const out = sr.enforceSizeCapCeiling(sr.applyStageRules(wild, 'eval'));
  assert.strictEqual(out.sizeCap, 6);
});
