const test = require('node:test');
const assert = require('node:assert');
const { sizeUpAfterLossViolation, sizeUpAfterLossReading } = require('../renderer/size-freeze-guard.js');

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

// ── 2026-09-21: A SCRATCH IS NOT A LOSS ─────────────────────────────────────
// The guard raised the full-screen "DAILY STOP HIT" on a day that closed
// +$124.30 over 4 trades at a max size of 4/4 — every limit intact. The trigger
// was trade 2: 4 contracts after trade 1 closed -$0.90 on 1 contract.

test('the real 2026-09-21 false stop: 1 lot at -$0.90, then 4 lots, is NOT a violation', () => {
  const trades = [{ size: 1, pnl: -0.9 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4, { breakEvenBandUsd: 100 }), false);
});

test('that same shape is reported as a scratch, with the band named', () => {
  const read = sizeUpAfterLossReading([{ size: 1, pnl: -0.9 }], 4, { breakEvenBandUsd: 100 });
  assert.strictEqual(read.violation, false);
  assert.strictEqual(read.level, 'scratch');
  assert.match(read.reason, /break-even band/);
});

test('a REAL loss followed by a size-up is still a hard violation inside the band rule', () => {
  const trades = [{ size: 2, pnl: -126 }];
  assert.strictEqual(sizeUpAfterLossViolation(trades, 4, { breakEvenBandUsd: 100 }), true);
});

test('the band boundary itself counts as a loss — the band is a strict interior', () => {
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -100 }], 4, { breakEvenBandUsd: 100 }), true);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 2, pnl: -99.99 }], 4, { breakEvenBandUsd: 100 }), false);
});

test('NO BAND SUPPLIED is the old behaviour — every negative close is a loss', () => {
  // Fail SAFE: a missing rules key must not silently arm a permissive band.
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 1, pnl: -0.9 }], 4), true);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 1, pnl: -0.9 }], 4, {}), true);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 1, pnl: -0.9 }], 4, { breakEvenBandUsd: 0 }), true);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 1, pnl: -0.9 }], 4, { breakEvenBandUsd: -5 }), true);
});

test('a scratch still cannot be a violation when the size does NOT rise', () => {
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 4, pnl: -0.9 }], 4, { breakEvenBandUsd: 100 }), false);
  assert.strictEqual(sizeUpAfterLossViolation([{ size: 4, pnl: -0.9 }], 2, { breakEvenBandUsd: 100 }), false);
});

test('the reading quotes the size the decision was made on, not the raw one (inferred case)', () => {
  const trades = [
    { size: 5, pnl: 20 },
    { size: 0, pnl: -300, inferred: true },
  ];
  const read = sizeUpAfterLossReading(trades, 6, { breakEvenBandUsd: 100 });
  assert.strictEqual(read.violation, true);
  assert.strictEqual(read.prevSize, 5, 'must name the substituted day-max, not the literal 0');
  assert.match(read.reason, /after a -300 loss on 5 contracts/);
});

test('a scratch previous trade is excluded regardless of how the size compares', () => {
  const trades = [{ size: 1, pnl: -99 }, { size: 4, pnl: -12 }]; // second is a scratch, and the most recent
  assert.strictEqual(sizeUpAfterLossViolation(trades, 6, { breakEvenBandUsd: 100 }), false);
});

test('reading never throws on garbage, band or no band', () => {
  assert.doesNotThrow(() => sizeUpAfterLossReading(null, 4, { breakEvenBandUsd: 100 }));
  assert.doesNotThrow(() => sizeUpAfterLossReading([{ size: 'x', pnl: -10 }], 4, { breakEvenBandUsd: 100 }));
  assert.doesNotThrow(() => sizeUpAfterLossReading([{ size: 2, pnl: -10 }], NaN, { breakEvenBandUsd: 100 }));
  assert.strictEqual(sizeUpAfterLossReading(null, 4, { breakEvenBandUsd: 100 }).violation, false);
});
