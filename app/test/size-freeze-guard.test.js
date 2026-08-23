const test = require('node:test');
const assert = require('node:assert');
const { sizeUpAfterLossViolation } = require('../renderer/size-freeze-guard.js');

test('THE PATTERN THIS CATCHES: size rises right after a loss, even on a net-positive day', () => {
  // Two winning trades first (day is +$50), THEN a loss, THEN a size-up.
  const trades = [
    { size: 2, pnl: 30 },
    { size: 2, pnl: 20 },
    { size: 2, pnl: -30 } // day cumulative is still +$20 here — the OLD day-cumulative check would miss this
  ];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4), true);
});

test('same size after a loss is NOT a violation — only an INCREASE is', () => {
  const trades = [{ size: 2, pnl: -30 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 2), false);
});

test('a size DECREASE after a loss is not a violation', () => {
  const trades = [{ size: 4, pnl: -30 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 2), false);
});

test('a size-up after a WINNING trade is not this violation', () => {
  const trades = [{ size: 2, pnl: 30 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4), false);
});

test('the very first trade of the day can never violate — there is no preceding trade', () => {
  assert.strictEqual(sizeUpAfterLossViolation([], 6), false);
});

test('a scratch trade (pnl exactly 0) does not count as a loss', () => {
  const trades = [{ size: 2, pnl: 0 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4), false);
});

test('only the IMMEDIATELY PRECEDING trade matters, not an earlier loss in the day', () => {
  const trades = [
    { size: 2, pnl: -50 },  // a loss...
    { size: 2, pnl: 10 }    // ...but recovered on the very next trade
  ];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 6), false, 'the loss two trades back must not still be freezing size now');
});

test('garbage/malformed input never throws and never falsely triggers', () => {
  assert.strictEqual(sizeUpAfterLossViolation(null, 4), false);
  assert.strictEqual(sizeUpAfterLossViolation(undefined, 4), false);
  assert.strictEqual(sizeUpAfterLossViolation('nonsense', 4), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 'x', pnl: -10 }], 4), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -10 }], NaN), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -10 }], 0), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -10 }], -4), false);
  assert.doesNotThrow(() => sizeUpAfterLossViolation([null, undefined, { size: 2, pnl: -10 }], 4));
});

test('THE REAL 08-11/08-12 SHAPE (from the trade data): a loss followed by a much bigger revenge size', () => {
  const trades = [{ size: 1, pnl: -449 }]; // the real 2026-08-10 s3 trade
  assert.strictEqual(sizeUpAfterLossViolation(trades, 9), true); // followed by a real 9-lot re-entry that day
});

// ── 2026-08-19: inferred (poll-aliasing) trade handling ──────────────────────

test('inferred trade after a loss: size:0 is NOT trusted, day maxSize substituted, violation fires', () => {
  const trades = [
    { size: 5, pnl: 20 },                          // day maxSize seen so far = 5
    { size: 0, pnl: -30, inferred: true },          // real size unknown, but it was a loss
  ];
  // 6 > 5 (the substituted maxSize), so this must trigger even though prev.size is literally 0
  assert.strictEqual(sizeUpAfterLossViolation(trades, 6), true);
});

test('inferred trade after a loss: newSize below day maxSize does not trigger', () => {
  const trades = [
    { size: 5, pnl: 20 },
    { size: 0, pnl: -30, inferred: true },
  ];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4), false);
});

test('inferred trade with no prior known size falls back to 0 (cannot invent a size)', () => {
  const trades = [{ size: 0, pnl: -30, inferred: true }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 1), true); // 1 > 0, still conservatively flagged
});

test('inferred trade that was a WIN is not a violation regardless of size substitution', () => {
  const trades = [
    { size: 5, pnl: 20 },
    { size: 0, pnl: 40, inferred: true },
  ];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 9), false);
});

test('regression: normal (non-inferred) trade behavior is completely unchanged', () => {
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -30 }], 4), true);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 4, pnl: -30 }], 2), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: 30 }], 4), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: 0 }], 4), false);
});
