const test = require('node:test');
const assert = require('node:assert');
const { isGoVerdict } = require('../go-verdict-detect.js');

test('a plain GO verdict is detected', () => {
  assert.strictEqual(isGoVerdict('GO — all three agents align on the long setup.'), true);
  assert.strictEqual(isGoVerdict('**GO**\nStrong confluence across the board.'), true);
});

test('NO-GO is never mistaken for GO, hyphenated or spaced', () => {
  assert.strictEqual(isGoVerdict('NO-GO — Jessi flagged a revenge cluster.'), false);
  assert.strictEqual(isGoVerdict('NO GO — accumulation phase, wait.'), false);
  assert.strictEqual(isGoVerdict('no-go, discipline violation present.'), false);
});

test('CAUTION is not treated as a GO', () => {
  assert.strictEqual(isGoVerdict('CAUTION — partial alignment, reduce size.'), false);
});

test('only the opening matters — a stray "go" deep in the reasoning does not retroactively flip a NO-GO', () => {
  const text = 'NO-GO — do not go long here, the structure is broken.';
  assert.strictEqual(isGoVerdict(text), false);
});

test('a GO mentioned only much later in the text (past the head window) is not detected — verdict must be at the top', () => {
  const text = 'x'.repeat(90) + ' GO now that structure confirms.';
  assert.strictEqual(isGoVerdict(text), false);
});

test('empty/garbage input is never a GO', () => {
  assert.strictEqual(isGoVerdict(''), false);
  assert.strictEqual(isGoVerdict(null), false);
  assert.strictEqual(isGoVerdict(undefined), false);
  assert.strictEqual(isGoVerdict(42), false);
});
