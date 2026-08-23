const test = require('node:test');
const assert = require('node:assert');
const VG = require('../verdict-grounding.js');

test('extractDollarAmounts finds positive, negative, and comma-grouped figures', () => {
  const text = 'Down -$180 today. Started at $50,000. Best trade was $721.50.';
  const found = VG.extractDollarAmounts(text).map(m => m.raw);
  assert.deepStrictEqual(found, ['-$180', '$50,000', '$721.50']);
});

test('parseDollarAmount normalizes formatting to a comparable number', () => {
  assert.strictEqual(VG.parseDollarAmount('$1,234.50'), 1234.5);
  assert.strictEqual(VG.parseDollarAmount('-$50'), -50);
  assert.strictEqual(VG.parseDollarAmount('$1234.00'), 1234);
});

test('extractDollarAmounts on empty/garbage input returns []', () => {
  assert.deepStrictEqual(VG.extractDollarAmounts(''), []);
  assert.deepStrictEqual(VG.extractDollarAmounts(null), []);
  assert.deepStrictEqual(VG.extractDollarAmounts('no money mentioned here'), []);
});

// ── knownAmountsFromRules ────────────────────────────────────────────────

test('knownAmountsFromRules flattens nested config numbers, both signs', () => {
  const rules = { sizeCap: 2, dailyLossTiers: { yellow: -250, red: -350, hard: -500 }, dayStop: { eval: 300, funded: 200 } };
  const known = VG.knownAmountsFromRules(rules);
  assert.ok(known.has(200) && known.has(-200));
  assert.ok(known.has(-500) && known.has(500));
  assert.ok(known.has(2) && known.has(-2));
});

test('knownAmountsFromRules on garbage input does not throw', () => {
  assert.doesNotThrow(() => VG.knownAmountsFromRules(null));
  assert.doesNotThrow(() => VG.knownAmountsFromRules('nonsense'));
  assert.doesNotThrow(() => VG.knownAmountsFromRules(42));
});

// ── checkGrounding — the actual defect this module exists to catch ────────

test('THE 2026-08-10 INCIDENT, replayed: a fabricated trade table is caught', () => {
  // Jessi's real fabrication that day: a 5-row P&L table invented from
  // nothing. Analysis, given the same real data, reported it correctly.
  const verdict = 'NO-GO — Jessi cites a losing streak of -$312, -$245, -$180, -$95, -$47 today.';
  const source = 'ANALYSIS ARGUMENT: real trades today were -$142 and +$66. No other trades logged.';
  const res = VG.checkGrounding(verdict, source, {});
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.ungrounded.sort(), ['-$180', '-$245', '-$312', '-$47', '-$95'].sort());
});

test('a figure that genuinely appears in the source arguments is grounded', () => {
  const verdict = 'GO — best trade of the day was $721.50, aligned with the setup.';
  const source = 'JESSI ARGUMENT: today\'s best trade was $721.50, a clean 4-lot entry.';
  const res = VG.checkGrounding(verdict, source, {});
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.ungrounded, []);
});

test('formatting drift (comma vs no comma, .00 vs bare) still counts as grounded', () => {
  const verdict = 'Balance is $50000 after today.';
  const source = 'ACCOUNT DATA: balance $50,000.00 as of close.';
  const res = VG.checkGrounding(verdict, source, {});
  assert.strictEqual(res.ok, true, 'same numeric value, different formatting, must not false-flag');
});

test('a static rule threshold not repeated by any sub-agent is grounded via rules.json, not flagged', () => {
  const verdict = 'RED FLAG — approaching the $200 funded hard stop.';
  const source = 'JESSI ARGUMENT: discipline looks fine so far today.'; // never mentions $200
  const rules = { dayStop: { funded: 200 } };
  const res = VG.checkGrounding(verdict, source, rules);
  assert.strictEqual(res.ok, true, 'a real config threshold must not be flagged just because no sub-agent happened to restate it');
});

test('an invented figure with NO match anywhere — not in source, not a rule — is flagged', () => {
  const verdict = 'GO — his account is up $9,999 today.';
  const source = 'ANALYSIS ARGUMENT: structure looks aligned.\nJESSI ARGUMENT: on track, +$150 so far.';
  const rules = { dayStop: { funded: 200 }, perTradeMaxLoss: 300 };
  const res = VG.checkGrounding(verdict, source, rules);
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.ungrounded, ['$9,999']);
});

test('a verdict with no dollar figures at all is trivially grounded', () => {
  const res = VG.checkGrounding('GO — structure and discipline both align.', 'irrelevant source', {});
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.ungrounded, []);
});

test('checkGrounding tolerates missing/garbage source or rules without throwing', () => {
  assert.doesNotThrow(() => VG.checkGrounding('lost $50 today', null, null));
  assert.doesNotThrow(() => VG.checkGrounding('lost $50 today', undefined, undefined));
  const res = VG.checkGrounding('lost $50 today', '', {});
  assert.strictEqual(res.ok, false); // no source at all → genuinely ungrounded, correctly flagged
});

// ── groundingWarningBlock ────────────────────────────────────────────────

test('groundingWarningBlock renders every ungrounded figure and is empty when nothing to flag', () => {
  assert.strictEqual(VG.groundingWarningBlock([]), '');
  assert.strictEqual(VG.groundingWarningBlock(null), '');
  const block = VG.groundingWarningBlock(['$9,999', '-$47']);
  assert.match(block, /\$9,999/);
  assert.match(block, /-\$47/);
  assert.match(block, /DATA CHECK/);
});

test('the warning wording hedges rather than accuses — false positives must not read as certain fabrication', () => {
  const block = VG.groundingWarningBlock(['$200']);
  assert.match(block, /may be/i);
  assert.doesNotMatch(block, /fabricated|invented by the model|lied/i);
});
