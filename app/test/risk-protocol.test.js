const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RP = require('../risk-protocol.js');

const APP = path.join(__dirname, '..');
const rules = JSON.parse(fs.readFileSync(path.join(APP, 'rules.json'), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(APP, rel));
const hasSymbol = (rel, sym) => {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  return new RegExp('\\b' + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(src);
};

// ── The whole point: a rule that cannot be verified is an intention ─────────
// Prop Trading/CLAUDE.md said "Max 2 contracts. Hard cap. No exceptions" while
// rules.json said 6 and nothing enforced either, for months. These tests exist
// so that cannot silently happen again.

test('every rule points at a number that really exists in rules.json', () => {
  for (const r of RP.PROTOCOL) {
    for (const p of [r.number].concat(r.bounds || []).filter(Boolean)) {
      const v = RP.resolveNumber(rules, p);
      assert.ok(v !== undefined && v !== null, `${r.id}: rules.json has no "${p}"`);
    }
  }
});

test('every rule names an enforcement site that still exists', () => {
  for (const r of RP.PROTOCOL) {
    assert.ok(r.enforcedIn, `${r.id}: no enforcement site declared`);
    assert.ok(exists(r.enforcedIn.file), `${r.id}: missing ${r.enforcedIn.file}`);
    assert.ok(hasSymbol(r.enforcedIn.file, r.enforcedIn.symbol),
      `${r.id}: ${r.enforcedIn.file} no longer contains ${r.enforcedIn.symbol}`);
  }
});

test('every rule has a test file, and every declared module exists', () => {
  for (const r of RP.PROTOCOL) {
    assert.ok(r.test, `${r.id}: no test declared`);
    assert.ok(exists(r.test), `${r.id}: missing test ${r.test}`);
    if (r.module) assert.ok(exists(r.module), `${r.id}: missing module ${r.module}`);
  }
});

test('no rule hardcodes its number in the registry instead of rules.json', () => {
  for (const r of RP.PROTOCOL) {
    if (r.number === null) continue;   // structural rules legitimately have none
    assert.strictEqual(typeof r.number, 'string',
      `${r.id}: number must be a rules.json PATH, not a literal value`);
  }
});

// ── Honesty about strength ──────────────────────────────────────────────────
test('strength is one of the three honest words, never invented', () => {
  const ok = new Set(Object.values(RP.STRENGTH));
  for (const r of RP.PROTOCOL) {
    assert.ok(ok.has(r.strength), `${r.id}: unknown strength "${r.strength}"`);
  }
});

// A guard that only reacts must never be filed as prevention. Six months of
// treating ADVISORY guards as if they BLOCKED is how a cap of 2 and a trade of
// 20 coexisted.
test('the per-trade stop is filed as REACTS, not BLOCKS', () => {
  assert.strictEqual(RP.byId('per-trade-max-loss').strength, RP.STRENGTH.REACTS,
    'it acts on an open position; it cannot stop the entry');
});

test('the oversize guard is filed as REACTS', () => {
  assert.strictEqual(RP.byId('oversize-reduce').strength, RP.STRENGTH.REACTS);
});

test('rules that only display are filed as ADVISORY and say so', () => {
  for (const r of RP.advisory()) {
    assert.ok(r.limits, `${r.id}: an advisory rule must state what it cannot do`);
  }
});

test('every REACTS and every rule with a caveat states its limits', () => {
  for (const r of RP.PROTOCOL.filter((x) => x.strength === RP.STRENGTH.REACTS)) {
    assert.ok(r.limits && r.limits.length > 20, `${r.id}: must state what it cannot do`);
  }
});

test('ids are unique — two rules cannot claim the same slot', () => {
  const ids = RP.PROTOCOL.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// ── The named invariants ────────────────────────────────────────────────────
test('the size cap the protocol reports is the one the engine will enforce', () => {
  const stageRules = require('../stage-rules.js');
  const declared = RP.resolveNumber(rules, 'sizeCap');
  const bounds = stageRules.sizeCapBounds(rules);
  assert.ok(declared >= bounds.min && declared <= bounds.max,
    `sizeCap ${declared} is outside the enforced band ${bounds.min}-${bounds.max}`);
  assert.strictEqual(stageRules.enforceSizeCapCeiling({ ...rules, sizeCap: 999 }).sizeCap, bounds.max,
    'the ceiling must hold whatever the config says');
});

test('the blocking set contains the rules that failed on 2026-09-03', () => {
  const blocking = new Set(RP.blocking().map((r) => r.id));
  for (const id of ['size-cap', 'size-up-after-loss', 'daily-loss-hard-tier', 'order-gateway']) {
    assert.ok(blocking.has(id), `${id} must be a BLOCKS rule`);
  }
});

test('resolveNumber walks dotted paths and fails safe on nonsense', () => {
  assert.strictEqual(RP.resolveNumber(rules, 'dailyLossTiers.hard'), -500);
  assert.strictEqual(RP.resolveNumber(rules, 'nope.not.here'), undefined);
  assert.strictEqual(RP.resolveNumber(rules, null), undefined);
});
