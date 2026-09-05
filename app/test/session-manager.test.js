'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { insertTradeRow, todayStr } = require('../session-manager.js');

// The trade table exactly as startSession() writes it.
const BLANK = `# Session — 2026-08-20 | NY 7:00 PM IST

## Trades
| # | Time (IST) | Direction | Entry | Stop | Target | Exit | P&L | 15m break? | Notes |
|---|---|---|---|---|---|---|---|---|---|

## Session Verdict
- System compliance:
`;

const rowN = (n, note) => `| ${n} | 19:1${n}:00 | BUY | ? | ? | ? | ? | $10 | No | ${note} |`;

// ── H7 (2026-08-20 review) ────────────────────────────────────────────────
test('todayStr uses the IST day boundary, not UTC', () => {
  // These disagree for the 5.5 hours between 00:00 and 05:30 IST, which
  // straddles the NY close — a 01:00 IST trade used to append to yesterday's
  // file while the live feed's own IST day had already rolled over.
  const expected = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(todayStr(), expected);
});

// ── H6 (2026-08-20 review) ────────────────────────────────────────────────
test('rows append in chronological order, so numbering matches reading order', () => {
  // The old code inserted every row directly after the header while numbering
  // ascending, so the NEWEST trade sat at the TOP carrying the HIGHEST number.
  let c = BLANK;
  c = insertTradeRow(c, rowN(1, 'first'));
  c = insertTradeRow(c, rowN(2, 'second'));
  c = insertTradeRow(c, rowN(3, 'third'));
  assert.ok(c.indexOf('first') < c.indexOf('second'), 'trade 1 before trade 2');
  assert.ok(c.indexOf('second') < c.indexOf('third'), 'trade 2 before trade 3');
});

test('appended rows stay inside the Trades table, above Session Verdict', () => {
  let c = insertTradeRow(BLANK, rowN(1, 'only'));
  c = insertTradeRow(c, rowN(2, 'second'));
  assert.ok(c.indexOf('second') < c.indexOf('## Session Verdict'), 'must not spill past the table');
  assert.ok(c.includes('## Session Verdict'), 'the rest of the file survives intact');
  assert.ok(c.includes('- System compliance:'));
});

test('the first row lands immediately under the separator, not before it', () => {
  const c = insertTradeRow(BLANK, rowN(1, 'only'));
  const lines = c.split('\n');
  const sep = lines.findIndex(l => l.startsWith('|---'));
  assert.match(lines[sep + 1], /only/, 'row goes directly after the header separator');
});

test('a hand-edited header REFUSES the write instead of silently succeeding', () => {
  // The old implementation used String.replace: a non-matching regex returned
  // the content unchanged, the file was rewritten identically, and logTrade
  // still reported {num, path} as success. The trade vanished with no throw,
  // so the caller's try/catch never fired.
  const mangled = BLANK.replace('| # | Time (IST) |', '| No. | Clock |');
  assert.equal(insertTradeRow(mangled, rowN(1, 'lost')), null);
  assert.equal(insertTradeRow('no table here at all', rowN(1, 'lost')), null);
});

test('tolerates a reformatted separator row (alignment colons, extra spaces)', () => {
  const aligned = BLANK.replace('|---|---|---|---|---|---|---|---|---|---|', '|:--- | :---: | --- | --- | --- | --- | --- | --- | --- | --- |');
  const c = insertTradeRow(aligned, rowN(1, 'kept'));
  assert.ok(c && c.includes('kept'), 'a cosmetically reformatted separator must not drop the trade');
});

test('garbage input never throws inside the live poll', () => {
  assert.equal(insertTradeRow(null, 'x'), null);
  assert.equal(insertTradeRow(BLANK, null), null);
  assert.equal(insertTradeRow(undefined, undefined), null);
});

// ── 2026-08-23 review fixes ───────────────────────────────────────────────
// Three defects found by the /autoplan review of task 7.1, all pre-existing
// and all visible in sessions/2026-08-21.md on disk.
const { countTradeRows, formatTradeRow } = require('../session-manager.js');

const TABLE = (rows) => `# Session — 2026-08-23

## Trades
| # | Time (IST) | Direction | Entry | Stop | Target | Exit | P&L | 15m break? | Notes |
|---|---|---|---|---|---|---|---|---|---|
${rows}
## Session Verdict
- System compliance:
`;

test('breakTaken: unobserved renders "?" — never a false compliance record', () => {
  // The live feed never sets breakTaken. The old code rendered undefined as
  // 'No', asserting a discipline failure that was never measured, in the one
  // column the post-session review grades compliance on.
  const row = formatTradeRow(1, { pnl: 11.6 }, '12:57:19');
  assert.match(row, /\| \? \|/, 'undefined breakTaken must render "?"');
  assert.doesNotMatch(row, /\| No \|/, 'undefined breakTaken must NOT render "No"');
});

test('breakTaken: an explicit false still renders "No"', () => {
  // The fix must not swallow a real observation — only an absent one.
  assert.match(formatTradeRow(1, { breakTaken: false }, '12:00:00'), /\| No \|/);
  assert.match(formatTradeRow(1, { breakTaken: true }, '12:00:00'), /\| Yes \|/);
});

test('formatTradeRow tolerates a null/absent trade without throwing', () => {
  assert.doesNotThrow(() => formatTradeRow(1, null, '12:00:00'));
  assert.doesNotThrow(() => formatTradeRow(1, undefined, '12:00:00'));
});

test('countTradeRows counts only rows inside the trades table', () => {
  assert.equal(countTradeRows(TABLE('')), 0);
  assert.equal(countTradeRows(TABLE(rowN(1, 'a') + '\n')), 1);
  assert.equal(countTradeRows(TABLE(rowN(1, 'a') + '\n' + rowN(2, 'b') + '\n')), 2);
});

test('countTradeRows ignores a numbered-row lookalike elsewhere in the file', () => {
  // The old `content.match(/^\|\s*\d+\s*\|/gm)` counted the WHOLE file, so any
  // other pipe-digit-pipe line — a second table, a pasted log line, a future
  // event row — silently inflated every subsequent trade number.
  const withDecoy = TABLE(rowN(1, 'real') + '\n') + `
## Some other section
| 7 | this is not a trade row |
| 8 | neither is this |
`;
  assert.equal(countTradeRows(withDecoy), 1, 'only the real table row counts');
});

test('countTradeRows returns 0 when the table header is missing', () => {
  // Must not fall back to a file-wide tally when the table cannot be found.
  assert.equal(countTradeRows('# Session\n\n| 4 | stray |\n'), 0);
  assert.equal(countTradeRows(''), 0);
  assert.equal(countTradeRows(null), 0);
});
