'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderNowMarkdown, istClock, money, cell, lossTierStatus, RECENT_EVENT_CAP } = require('../live-status.js');

// A fixed instant so every assertion is deterministic: 2026-08-23 17:28:14 UTC
// = 22:58:14 IST. Nothing in this module may call Date.now() itself.
const T = Date.UTC(2026, 7, 23, 17, 28, 14);

const STATE = {
  mode: 'eval',
  feed: { balanceAtLastFlat: 50811.8, dayPnl: 0, tradeCount: 0 },
  rules: { sizeCap: 2, tradesPerDay: 5, dailyLossTiers: { yellow: -250, red: -350, hard: -500 } },
  watchers: { tvConnected: true, rows: [{ id: 'po3', label: 'po3', health: 'healthy' }] },
  recent: [],
};

// ── clock ──────────────────────────────────────────────────────────────────
test('istClock converts to IST wall-clock, zero-padded', () => {
  assert.equal(istClock(T), '22:58:14');
});

test('istClock never throws on garbage', () => {
  assert.equal(istClock(undefined), '--:--:--');
  assert.equal(istClock(NaN), '--:--:--');
});

// ── money ──────────────────────────────────────────────────────────────────
test('money groups thousands and keeps the sign outside the $', () => {
  assert.equal(money(50811.8), '$50,811.80');
  assert.equal(money(-620), '-$620.00');
  assert.equal(money(0), '$0.00');
});

test('money degrades to an em dash rather than printing NaN at a trader', () => {
  assert.equal(money(undefined), '—');
  assert.equal(money(NaN), '—');
});

// ── cell: the highest-probability real corruption path ─────────────────────
test('cell escapes pipes so one reason string cannot break the table', () => {
  assert.equal(cell('size 3 | cap 2'), 'size 3 \\| cap 2');
});

test('cell collapses newlines — a multi-line reason must stay one row', () => {
  // po3-phase-change messages are already multi-line in server.js.
  assert.equal(cell('line one\nline two'), 'line one line two');
  assert.doesNotMatch(cell('a\r\nb'), /[\r\n]/);
});

test('cell truncates so a long Judge rationale cannot blow out the column', () => {
  const long = 'x'.repeat(500);
  assert.ok(cell(long).length <= 62);
  assert.match(cell(long), /…$/);
});

test('cell never throws on null/undefined/objects', () => {
  assert.equal(cell(null), '');
  assert.equal(cell(undefined), '');
  assert.doesNotThrow(() => cell({}));
});

// ── loss tiers: read from rules, never retyped ─────────────────────────────
test('lossTierStatus reports clear when P&L is above every tier', () => {
  const r = lossTierStatus(0, { yellow: -250, red: -350, hard: -500 });
  assert.equal(r.hit, null);
  assert.match(r.line, /\$250/);
});

test('lossTierStatus reports the WORST tier breached, not the first', () => {
  // -600 is past all three; it must say hard, not yellow.
  assert.equal(lossTierStatus(-600, { yellow: -250, red: -350, hard: -500 }).hit, 'hard');
  assert.equal(lossTierStatus(-360, { yellow: -250, red: -350, hard: -500 }).hit, 'red');
  assert.equal(lossTierStatus(-260, { yellow: -250, red: -350, hard: -500 }).hit, 'yellow');
});

test('lossTierStatus sits exactly ON a tier as breached, not clear', () => {
  // The rule is "loss tier reached", so equality counts.
  assert.equal(lossTierStatus(-250, { yellow: -250, red: -350, hard: -500 }).hit, 'yellow');
});

test('lossTierStatus degrades safely with no tiers configured', () => {
  assert.deepEqual(lossTierStatus(0, null), { line: '—', hit: null });
});

// ── the document ───────────────────────────────────────────────────────────
test('renderNowMarkdown shows real account values from state, not invented ones', () => {
  const md = renderNowMarkdown(STATE, T);
  assert.match(md, /\$50,811\.80/);
  assert.match(md, /0 \/ 5/, 'trades must render as count / cap from rules');
  assert.match(md, /Size cap \| 2/);
});

test('renderNowMarkdown marks TV offline in the header when it is', () => {
  assert.match(renderNowMarkdown(STATE, T), /● LIVE/);
  const down = Object.assign({}, STATE, { watchers: { tvConnected: false, rows: [] } });
  assert.match(renderNowMarkdown(down, T), /○ TV OFFLINE/);
});

test('renderNowMarkdown says plainly it is not a record', () => {
  // The whole safety argument depends on nobody treating this file as data.
  assert.match(renderNowMarkdown(STATE, T), /\*\*Not a record\*\*/);
});

test('renderNowMarkdown caps the recent list so the file cannot grow', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ts: T, kind: 'signal', label: 'sig' + i, detail: 'd' }));
  const md = renderNowMarkdown(Object.assign({}, STATE, { recent: many }), T);
  const rows = md.split('\n').filter(l => /^\| \d{2}:\d{2}:\d{2} \|/.test(l));
  assert.equal(rows.length, RECENT_EVENT_CAP, 'must render at most RECENT_EVENT_CAP rows');
});

test('renderNowMarkdown puts the NEWEST event first — Obsidian does not auto-scroll', () => {
  const recent = [
    { ts: T - 60000, kind: 'signal', label: 'older', detail: 'a' },
    { ts: T, kind: 'block', label: 'newer', detail: 'b' },
  ];
  const md = renderNowMarkdown(Object.assign({}, STATE, { recent }), T);
  assert.ok(md.indexOf('newer') < md.indexOf('older'), 'newest must appear above oldest');
});

test('renderNowMarkdown renders a guardrail block with the block glyph', () => {
  const recent = [{ ts: T, kind: 'block', label: 'BLOCK', detail: 'size 3 > cap 2' }];
  assert.match(renderNowMarkdown(Object.assign({}, STATE, { recent }), T), /🛑/);
});

test('renderNowMarkdown never throws on empty/garbage state', () => {
  // It runs on a timer inside a live-money process; a throw here must be
  // impossible, not merely caught upstream.
  assert.doesNotThrow(() => renderNowMarkdown(undefined, T));
  assert.doesNotThrow(() => renderNowMarkdown({}, T));
  assert.doesNotThrow(() => renderNowMarkdown({ recent: [null, undefined] }, T));
  assert.doesNotThrow(() => renderNowMarkdown({ feed: null, rules: null, watchers: null }, T));
});

test('renderNowMarkdown always returns a complete document', () => {
  // The caller writes atomically; a partial projection is worse than a stale one.
  for (const st of [undefined, {}, STATE]) {
    const md = renderNowMarkdown(st, T);
    assert.match(md, /^# /, 'starts with the header');
    assert.match(md, /## Account/);
    assert.match(md, /## Watchers/);
    assert.match(md, /## Recent/);
  }
});

// ── header clock resolution: the write-suppression depends on this ─────────
const { istClockShort } = require('../live-status.js');

test('istClockShort omits seconds so the file is not rewritten every tick', () => {
  // The caller skips the write when the text is byte-identical to the last.
  // With seconds in the header that check can never fire and Obsidian
  // re-renders every 5s all session — flicker for no information.
  assert.equal(istClockShort(T), '22:58');
  assert.equal(istClockShort(undefined), '--:--');
});

test('two renders within the same minute are byte-identical', () => {
  // This is the property the write-suppression relies on. If it ever breaks,
  // the file starts rewriting on every tick again.
  const a = renderNowMarkdown(STATE, T);
  const b = renderNowMarkdown(STATE, T + 30000); // +30s, same minute-ish
  assert.equal(a, b, 'same state within the same minute must render identically');
});

test('a new event changes the render immediately, minute or not', () => {
  // Suppression must never delay a real change — only a clock tick.
  const withEvent = Object.assign({}, STATE, {
    recent: [{ ts: T, kind: 'block', label: 'BLOCK', detail: 'size 3 > cap 2' }],
  });
  assert.notEqual(renderNowMarkdown(STATE, T), renderNowMarkdown(withEvent, T));
});

test('event rows keep seconds — they correlate against the trades table', () => {
  const withEvent = Object.assign({}, STATE, {
    recent: [{ ts: T, kind: 'block', label: 'BLOCK', detail: 'x' }],
  });
  assert.match(renderNowMarkdown(withEvent, T), /22:58:14/);
});
