'use strict';
/**
 * armed-detectors.js tests.
 *
 * 2026-08-25. These are guardrails Anoop arms himself, firing on a live-money
 * account with no code review between him typing a number and the check
 * running. So the bar here is not "the happy path works" — it is that a
 * detector cannot be armed into a state that is always-on, never-on, or
 * silently wrong about which trade tripped it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const AD = require('../armed-detectors.js');

// His real 2026-08-25 session, from DATA/accounts/s1/day_trades.json.
const REAL = [
  { t: 1787573060000, at: 1787573283000, size: 5, pnl: -280 },
  { t: 1787573941000, at: 1787574773000, size: 2, pnl: -2.8 },
  { t: 1787578586000, at: 1787578688000, size: 6, pnl: -291.4 },
  { t: 1787578812000, at: 1787578844000, size: 2, pnl: -25.8 },
  { t: 1787578950000, at: 1787578980000, size: 8, pnl: -15.6 },
  { t: 1787579144000, at: 1787579396000, size: 6, pnl: -26.4 },
  { t: 1787584493000, at: 1787584822000, size: 8, pnl: 20.3 },
  { t: 1787585617000, at: 1787585663000, size: 12, pnl: 23.2 },
  { t: 1787585668000, at: 1787585754000, size: 1, pnl: 5.6 },
  { t: 1787587194000, at: 1787587229000, size: 2, pnl: -0.8 },
  { t: 1787587294000, at: 1787587329000, size: 8, pnl: 907.8 },
];
const lesson = (template, params, over) => Object.assign(
  { id: 1, text: 'a lesson', promoted: true, detector: { template, params } }, over || {});

// ── Arming safety ───────────────────────────────────────────────────────────

test('validate: a param outside the template bounds is REFUSED', () => {
  // "re-enter within 9999 minutes" would match nearly every second trade,
  // forever. The bounds are the thing that stops an always-on detector.
  const r = AD.validate(lesson('fast-reentry', { minutes: 9999, times: 2 }));
  assert.strictEqual(r.ok, false);
  assert.ok(/between 1 and 240/.test(r.errors.join(' ')), r.errors.join(' '));
});

test('validate: a threshold low enough to always match is REFUSED', () => {
  const r = AD.validate(lesson('total-contracts', { max: 0 }));
  assert.strictEqual(r.ok, false);
});

test('validate: a missing number is refused, not defaulted at arm time', () => {
  const r = AD.validate(lesson('fast-reentry', { times: 2 }));
  assert.strictEqual(r.ok, false);
  assert.ok(/needs a number/.test(r.errors.join(' ')));
});

test('validate: an unknown template cannot be armed', () => {
  assert.strictEqual(AD.validate(lesson('rm -rf', {})).ok, false);
});

test('validate: a detector with no lesson text is refused', () => {
  // The sentence is what he reads when it fires; a bare condition teaches
  // nothing at the moment it matters.
  const r = AD.validate(lesson('total-contracts', { max: 12 }, { text: '   ' }));
  assert.strictEqual(r.ok, false);
});

test('validate: a good config passes', () => {
  assert.strictEqual(AD.validate(lesson('total-contracts', { max: 12 })).ok, true);
});

test('armed: promotion WITHOUT a detector stays a plain note', () => {
  const list = [{ id: 1, text: 'just a note', promoted: true }];
  assert.strictEqual(AD.armed(list).length, 0);
  assert.strictEqual(AD.evaluateAll(list, { trades: REAL }).length, 0);
});

test('armed: an un-promoted lesson with a valid detector does NOT fire', () => {
  const list = [lesson('total-contracts', { max: 1 }, { promoted: false })];
  assert.strictEqual(AD.armed(list).length, 0);
  assert.strictEqual(AD.evaluateAll(list, { trades: REAL }).length, 0);
});

test('armed: an INVALID detector is silently inert, never evaluated', () => {
  const list = [lesson('fast-reentry', { minutes: 9999, times: 1 })];
  assert.strictEqual(AD.armed(list).length, 0);
  assert.strictEqual(AD.evaluateAll(list, { trades: REAL }).length, 0);
});

test('armed: capped at MAX_ARMED so the alert channel cannot be flooded', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    lesson('total-contracts', { max: 12 }, { id: i }));
  assert.strictEqual(AD.armed(many).length, AD.MAX_ARMED);
  assert.strictEqual(AD.evaluateAll(many, { trades: REAL }).length, AD.MAX_ARMED);
});

test('evaluateAll: a throwing template is contained, not fatal', () => {
  // This runs inside the live broker poll loop. One bad detector must not
  // take down the process that is holding his session together.
  const broken = AD.getTemplate('total-contracts');
  const orig = broken.evaluate;
  broken.evaluate = () => { throw new Error('boom'); };
  try {
    const out = AD.evaluateAll([lesson('total-contracts', { max: 1 })], { trades: REAL });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].matched, false);
    assert.strictEqual(out[0].error, 'boom');
  } finally { broken.evaluate = orig; }
});

// ── Each template, against his real day ─────────────────────────────────────

test('trades-after-wins: counts trades AFTER the Nth win, not total', () => {
  const [hit] = AD.evaluateAll([lesson('trades-after-wins', { wins: 2, extra: 1 })], { trades: REAL });
  // Wins are at index 6 (20.3) and 7 (23.2); 3 trades follow index 7.
  assert.ok(hit.message.includes('3 more trades'), hit.message);
  assert.ok(hit.message.includes('11 total'), hit.message);
});

test('trades-after-wins: does not fire before the Nth win exists', () => {
  const few = [{ at: 1, pnl: 50, size: 1 }, { at: 2, pnl: -10, size: 1 }];
  assert.strictEqual(AD.evaluateAll([lesson('trades-after-wins', { wins: 2, extra: 1 })], { trades: few }).length, 0);
});

test('size-while-red: judges the size by what he knew BEFORE that trade', () => {
  // Adding the trade's own P&L first would judge the decision by its outcome.
  const t = [{ at: 1, pnl: -100, size: 1 }, { at: 2, pnl: 500, size: 9 }];
  const [hit] = AD.evaluateAll([lesson('size-while-red', { size: 2, below: 0 })], { trades: t });
  assert.ok(hit, 'a 9-lot opened while -$100 is a breach even though it won');
  assert.ok(hit.message.includes('-$100'), hit.message);
});

test('size-while-red: a big trade opened while GREEN is not a breach', () => {
  const t = [{ at: 1, pnl: 500, size: 1 }, { at: 2, pnl: -100, size: 9 }];
  assert.strictEqual(AD.evaluateAll([lesson('size-while-red', { size: 2, below: 0 })], { trades: t }).length, 0);
});

test('fast-reentry: measures the gap from the LOSS exit to the next open', () => {
  const [hit] = AD.evaluateAll([lesson('fast-reentry', { minutes: 15, times: 2 })], { trades: REAL });
  assert.ok(hit.message.includes('5 times'), hit.message);
});

test('fast-reentry: a gap after a WIN does not count', () => {
  const t = [{ t: 0, at: 0, pnl: 100, size: 1 }, { t: 60000, at: 60000, pnl: -10, size: 1 }];
  assert.strictEqual(AD.evaluateAll([lesson('fast-reentry', { minutes: 15, times: 1 })], { trades: t }).length, 0);
});

test('pnl-band-churn: 8 of his 11 landed inside +/-$100', () => {
  const [hit] = AD.evaluateAll([lesson('pnl-band-churn', { band: 100, count: 5 })], { trades: REAL });
  assert.ok(hit.message.includes('8 of your 11'), hit.message);
});

test('giveback: fires on the percentage of the PEAK, not of the final number', () => {
  const t = [{ at: 1, pnl: 400, size: 1 }, { at: 2, pnl: -250, size: 1 }];
  const [hit] = AD.evaluateAll([lesson('giveback', { peak: 300, pct: 50 })], { trades: t });
  assert.ok(hit.message.includes('up $400'), hit.message);
  assert.ok(hit.message.includes('63%'), hit.message);
});

test('giveback: a day that never reached the peak cannot give it back', () => {
  const t = [{ at: 1, pnl: 100, size: 1 }, { at: 2, pnl: -90, size: 1 }];
  assert.strictEqual(AD.evaluateAll([lesson('giveback', { peak: 300, pct: 50 })], { trades: t }).length, 0);
});

test('total-contracts: sums the day and says so when sizes were unobserved', () => {
  const t = [{ at: 1, pnl: 10, size: 0 }, { at: 2, pnl: 10, size: 20 }];
  const [hit] = AD.evaluateAll([lesson('total-contracts', { max: 12 })], { trades: t });
  assert.ok(hit.message.includes('at 20'), hit.message);
  assert.ok(/real number is higher/.test(hit.message), 'size 0 means NOT OBSERVED, so the total under-counts');
});

test('hold-too-long: a trade with NO hold recorded is not evidence of a short hold', () => {
  const t = [{ at: 1, pnl: 10, size: 1 }];  // no hold, no holdSec
  assert.strictEqual(AD.evaluateAll([lesson('hold-too-long', { minutes: 5 })], { trades: t }).length, 0);
  const t2 = [{ at: 1, pnl: 10, size: 1, holdSec: 600 }];
  assert.strictEqual(AD.evaluateAll([lesson('hold-too-long', { minutes: 5 })], { trades: t2 }).length, 1);
});

test('red-day-streak: ABSTAINS when history is missing rather than saying "clear"', () => {
  const l = [lesson('red-day-streak', { days: 2 })];
  assert.strictEqual(AD.evaluateAll(l, { trades: REAL }).length, 0);
  assert.strictEqual(AD.evaluateAll(l, { trades: REAL, priorDays: [{ date: 'x', pnl: -1 }] }).length, 0);
});

test('red-day-streak: fires on N consecutive red days, and only if he traded', () => {
  const prior = [{ date: '2026-08-22', pnl: -100 }, { date: '2026-08-21', pnl: -200 }];
  const [hit] = AD.evaluateAll([lesson('red-day-streak', { days: 2 })], { trades: REAL, priorDays: prior });
  assert.ok(hit.message.includes('$300'), hit.message);
  // No trades today = nothing to warn about yet.
  assert.strictEqual(AD.evaluateAll([lesson('red-day-streak', { days: 2 })], { trades: [], priorDays: prior }).length, 0);
});

test('red-day-streak: a GREEN day breaks the streak', () => {
  const prior = [{ date: '2026-08-22', pnl: 100 }, { date: '2026-08-21', pnl: -200 }];
  assert.strictEqual(AD.evaluateAll([lesson('red-day-streak', { days: 2 })], { trades: REAL, priorDays: prior }).length, 0);
});

// ── Shared invariants ───────────────────────────────────────────────────────

test('every template: an empty day fires nothing', () => {
  AD.TEMPLATES.forEach((tpl) => {
    const l = [lesson(tpl.id, AD.withDefaults(tpl.id, {}))];
    assert.strictEqual(AD.evaluateAll(l, { trades: [], priorDays: [] }).length, 0,
      tpl.id + ' fired on an empty day');
  });
});

test('every template: pnlUnknown rows never trip a P&L-based detector', () => {
  const unknown = REAL.map((t) => Object.assign({}, t, { pnlUnknown: true }));
  ['trades-after-wins', 'size-while-red', 'fast-reentry', 'pnl-band-churn', 'giveback'].forEach((id) => {
    const l = [lesson(id, AD.withDefaults(id, {}))];
    assert.strictEqual(AD.evaluateAll(l, { trades: unknown }).length, 0, id + ' trusted an unknown P&L');
  });
});

test('every template: fires with REAL NUMBERS in the message, never a bare scold', () => {
  AD.TEMPLATES.forEach((tpl) => {
    const l = [lesson(tpl.id, AD.withDefaults(tpl.id, {}))];
    const out = AD.evaluateAll(l, {
      trades: REAL.map((t) => Object.assign({}, t, { holdSec: 7200 })),
      priorDays: [{ date: 'a', pnl: -1 }, { date: 'b', pnl: -1 }, { date: 'c', pnl: -1 },
                  { date: 'd', pnl: -1 }, { date: 'e', pnl: -1 }, { date: 'f', pnl: -1 },
                  { date: 'g', pnl: -1 }, { date: 'h', pnl: -1 }, { date: 'i', pnl: -1 },
                  { date: 'j', pnl: -1 }],
    });
    if (out.length) assert.ok(/\d/.test(out[0].message), tpl.id + ' fired with no numbers');
  });
});

test('every template: unsorted input gives the same answer as sorted', () => {
  const shuffled = [REAL[5], REAL[0], REAL[9], REAL[2], REAL[7], REAL[1],
                    REAL[10], REAL[3], REAL[8], REAL[4], REAL[6]];
  AD.TEMPLATES.forEach((tpl) => {
    const l = [lesson(tpl.id, AD.withDefaults(tpl.id, {}))];
    const a = AD.evaluateAll(l, { trades: REAL });
    const b = AD.evaluateAll(l, { trades: shuffled });
    assert.deepStrictEqual(b.map((x) => x.message), a.map((x) => x.message), tpl.id);
  });
});

// ── The "silently never fires" guard ────────────────────────────────────────

test('describeArmed: says NEVER FIRED out loud instead of implying coverage', () => {
  const now = Date.UTC(2026, 7, 25);
  const [d] = AD.describeArmed([lesson('total-contracts', { max: 12 })], now);
  assert.ok(/never fired/.test(d.summary), d.summary);
  assert.ok(d.summary.includes('12'), 'the armed numbers must be visible: ' + d.summary);
});

test('describeArmed: reports how long ago it last fired', () => {
  const now = Date.UTC(2026, 7, 25);
  const l = lesson('total-contracts', { max: 12 }, { fireCount: 3, lastFiredAt: now - 2 * 86400000 });
  const [d] = AD.describeArmed([l], now);
  assert.ok(/fired 3x, last 2 days ago/.test(d.summary), d.summary);
});
