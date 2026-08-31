'use strict';
/**
 * mind-log.test.js — Alignment + Lessons merged.
 *
 * 2026-08-25. The migration reads his real align_notes.json, which holds long
 * irreplaceable entries he typed by hand. So the bar here is not just "the
 * merge works" — it is that nothing he wrote can be dropped, doubled, or
 * quietly reclassified, and that a mood from three weeks ago can never be
 * handed to an agent as a standing rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ML = require('../mind-log.js');
const AD = require('../armed-detectors.js');

const ALIGN = [
  { id: 1755500000000, ts: '2026-08-18T10:00:00Z', text: 'bigger size is confusing me and I cannot hold the trade' },
  { id: 1755400000000, ts: '2026-08-17T10:00:00Z', text: 'drained, trading on adrenaline' },
];
const LESSONS = [
  { id: 1756000000000, ts: '2026-08-24T10:00:00Z', text: 'Never size up while red', promoted: true, fireCount: 2,
    detector: { template: 'size-while-red', params: { size: 2, below: 0 } } },
  { id: 1756100000000, ts: '2026-08-25T10:00:00Z', text: 'trading should be my main goal, not building the app', promoted: false },
];

// ── Migration safety ────────────────────────────────────────────────────────

test('migrate: keeps EVERY entry from both stores', () => {
  const m = ML.migrate(ALIGN, LESSONS);
  assert.strictEqual(m.length, 4);
  ALIGN.concat(LESSONS).forEach(src => {
    assert.ok(m.some(e => e.text === src.text), 'lost: ' + src.text);
  });
});

test('migrate: text is preserved BYTE FOR BYTE, never trimmed or reflowed', () => {
  const long = { id: 1, ts: '2026-08-18T00:00:00Z', text: '  line one\n\nline two  ' };
  const [e] = ML.migrate([long], []);
  assert.strictEqual(e.text, '  line one\n\nline two  ');
});

test('migrate: running it twice cannot double his history', () => {
  // Both the server and the tab can find no mind_log and migrate at once.
  const once = ML.migrate(ALIGN, LESSONS);
  const twice = ML.migrate(ALIGN.concat(ALIGN), LESSONS.concat(LESSONS));
  assert.strictEqual(twice.length, once.length);
});

test('migrate: alignment entries become state, lessons become lessons', () => {
  const m = ML.migrate(ALIGN, LESSONS);
  assert.strictEqual(m.find(e => /bigger size/.test(e.text)).kind, 'state');
  assert.strictEqual(m.find(e => /main goal/.test(e.text)).kind, 'lesson');
});

test('migrate: an armed lesson keeps its detector AND its fire history', () => {
  const e = ML.migrate(ALIGN, LESSONS).find(x => /Never size up/.test(x.text));
  assert.strictEqual(e.promoted, true);
  assert.strictEqual(e.fireCount, 2);
  assert.deepStrictEqual(e.detector, LESSONS[0].detector);
});

test('migrate: empty / missing stores are safe', () => {
  assert.deepStrictEqual(ML.migrate(null, null), []);
  assert.deepStrictEqual(ML.migrate([], []), []);
  assert.deepStrictEqual(ML.migrate(undefined, LESSONS).length, 2);
});

test('migrate: an entry with no text is dropped, not stored blank', () => {
  assert.strictEqual(ML.migrate([{ id: 1, text: '   ' }], []).length, 0);
});

test('load: newest first regardless of input order', () => {
  const m = ML.load(ML.migrate(ALIGN, LESSONS));
  const ids = m.map(e => e.id);
  assert.deepStrictEqual(ids, ids.slice().sort((a, b) => b - a));
});

// ── The kinds stay separate ─────────────────────────────────────────────────

test('a STATE entry can never carry a detector', () => {
  // Arming a mood would mean the app enforcing how he feels.
  const e = ML.normalize({ id: 1, text: 'feeling rushed', detector: { template: 'giveback', params: {} }, promoted: true }, 'state');
  assert.strictEqual(e.detector, undefined);
  assert.strictEqual(e.promoted, undefined);
});

test('armable: only lessons with a detector reach armed-detectors', () => {
  const m = ML.migrate(ALIGN, LESSONS);
  const a = ML.armable(m);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].text, 'Never size up while red');
  // And it must be armable by the real evaluator, not just shaped like it.
  assert.strictEqual(AD.armed(a).length, 1);
});

test('armable: the un-armed lesson is excluded from watches but NOT from context', () => {
  const m = ML.migrate(ALIGN, LESSONS);
  assert.ok(!ML.armable(m).some(e => /main goal/.test(e.text)), 'no detector, nothing to arm');
  assert.ok(/main goal/.test(ML.formatContext(m)), 'but agents must still read it — this was THE gap');
});

// ── Agent context ───────────────────────────────────────────────────────────

test('formatContext: closes the gap — an un-armed lesson now reaches agents', () => {
  const out = ML.formatContext(ML.migrate(ALIGN, LESSONS));
  assert.ok(out.includes('trading should be my main goal'), out);
});

test('formatContext: state and lessons are labelled differently', () => {
  const out = ML.formatContext(ML.migrate(ALIGN, LESSONS));
  assert.ok(/WHERE HIS HEAD IS/.test(out));
  assert.ok(/STANDING LESSONS/.test(out));
  assert.ok(/they expire/.test(out), 'an agent must know a mood is not a rule');
  assert.ok(/do NOT expire/.test(out));
});

test('formatContext: state entries are capped, lessons are not dropped by that cap', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ id: 2000 + i, ts: '2026-08-0' + (i % 9 + 1) + 'T00:00:00Z', text: 'state ' + i, kind: 'state' });
  many.push({ id: 1, ts: '2026-01-01T00:00:00Z', text: 'an ancient but standing lesson', kind: 'lesson' });
  const out = ML.formatContext(ML.load(many), { stateLimit: 2 });
  assert.strictEqual((out.match(/^- \[/gm) || []).filter(x => x).length, 3, out);
  assert.ok(out.includes('ancient but standing lesson'), 'a lesson never ages out of context');
});

test('formatContext: standing lessons ARE capped, or context grows forever', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ id: 3000 + i, ts: '2026-08-01T00:00:00Z', text: 'lesson ' + i, kind: 'lesson' });
  const out = ML.formatContext(ML.load(many), { stateLimit: 3 });
  assert.strictEqual((out.match(/^- \[/gm) || []).length, ML.LESSON_CONTEXT_CAP);
});

test('formatContext: marks armed lessons, including the never-fired ones', () => {
  const armed = ML.formatContext(ML.migrate([], LESSONS));
  assert.ok(/\[ARMED — the app checks this live, has caught him 2x\]/.test(armed), armed);
  const never = ML.formatContext(ML.migrate([], [Object.assign({}, LESSONS[0], { fireCount: 0 })]));
  assert.ok(/never fired yet/.test(never), never);
});

test('formatContext: a lesson with a detector but NOT armed is not marked armed', () => {
  const unarmed = [Object.assign({}, LESSONS[0], { promoted: false })];
  assert.ok(!/ARMED/.test(ML.formatContext(ML.migrate([], unarmed))));
});

test('formatContext: empty when nothing is written', () => {
  assert.strictEqual(ML.formatContext([]), '');
  assert.strictEqual(ML.formatContext(null), '');
});

test('dateOf: falls back to the id when ts is missing, never prints Invalid Date', () => {
  // Date.UTC, not a hand-typed epoch — the first version of this test used a
  // 2025 millisecond value while claiming 2026 and failed on its own fixture.
  assert.strictEqual(ML.dateOf({ id: Date.UTC(2026, 7, 18) }), '2026-08-18');
  assert.strictEqual(ML.dateOf({}), '?');
  assert.strictEqual(ML.dateOf({ ts: 'nonsense' }), '?');
});

test('UMD: exposed to both the renderer and the server', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'mind-log.js'), 'utf8');
  assert.ok(/root\.MindLog = factory\(\)/.test(src));
  assert.ok(/module\.exports = factory\(\)/.test(src));
});
