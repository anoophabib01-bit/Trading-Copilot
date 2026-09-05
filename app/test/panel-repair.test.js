'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PR = require('../panel-repair');

const DAY = '2026-09-01';
const T = 1788260000000;
const fresh = () => PR.rollDay(null, DAY);
const healthy = { summaryReadable: true, positionsReadable: true, ordersReadable: true };
const summaryBroken = { summaryReadable: false, positionsReadable: true, ordersReadable: true };

test('THE 2026-09-01 FAULT: an unreadable summary triggers a repair that asks for "summary"', () => {
  // The whole 9.5-hour outage: the tool could fix this, was never asked to,
  // and the app told Anoop to click the tab himself instead.
  const d = PR.decide(summaryBroken, fresh(), T);
  assert.strictEqual(d.action, PR.ACTION.REPAIR);
  assert.deepStrictEqual(d.want, ['summary']);
});

test('only BROKEN tabs are requested — a healthy tab is never clicked away from', () => {
  const d = PR.decide({ summaryReadable: false, positionsReadable: false, ordersReadable: true }, fresh(), T);
  assert.deepStrictEqual(d.want, ['summary', 'positions']);
  assert.ok(!d.want.includes('orders'));
});

test('a healthy panel is left alone', () => {
  const d = PR.decide(healthy, fresh(), T);
  assert.strictEqual(d.action, PR.ACTION.HEALTHY);
  assert.deepStrictEqual(d.want, []);
});

test('cooldown stops the panel being hammered', () => {
  const first = PR.decide(summaryBroken, fresh(), T);
  const second = PR.decide(summaryBroken, first.state, T + 5000);
  assert.strictEqual(second.action, PR.ACTION.COOLING);
});

test('after the cooldown it tries again', () => {
  const first = PR.decide(summaryBroken, fresh(), T);
  const later = PR.decide(summaryBroken, first.state, T + 61000);
  assert.strictEqual(later.action, PR.ACTION.REPAIR);
  assert.strictEqual(later.state.attempts, 2);
});

test('repeated FAILURES escalate instead of looping silently', () => {
  // The rule the oversize guard paid for: an action that is not working must
  // stop and become visible, not keep firing.
  let st = fresh();
  for (let i = 0; i < 3; i++) {
    const d = PR.decide(summaryBroken, st, T + i * 61000);
    assert.strictEqual(d.action, PR.ACTION.REPAIR);
    st = PR.recordResult(d.state, false);
  }
  const d4 = PR.decide(summaryBroken, st, T + 4 * 61000);
  assert.strictEqual(d4.action, PR.ACTION.ESCALATE);
  assert.match(d4.reason, /failed 3 times/);
  assert.match(d4.reason, /instead of looping silently/);
});

test('once escalated it stays escalated rather than quietly resuming', () => {
  let st = fresh();
  for (let i = 0; i < 3; i++) st = PR.recordResult(PR.decide(summaryBroken, st, T + i * 61000).state, false);
  const esc = PR.decide(summaryBroken, st, T + 4 * 61000);
  const again = PR.decide(summaryBroken, esc.state, T + 10 * 61000);
  assert.strictEqual(again.action, PR.ACTION.ESCALATE);
  assert.match(again.reason, /waiting for a human/);
});

test('a SUCCESSFUL repair clears the failure streak', () => {
  let st = fresh();
  st = PR.recordResult(PR.decide(summaryBroken, st, T).state, false);
  st = PR.recordResult(PR.decide(summaryBroken, st, T + 61000).state, true);
  assert.strictEqual(st.consecutiveFailures, 0);
});

test('recovery clears escalation so a LATER fault gets fresh attempts', () => {
  let st = fresh();
  for (let i = 0; i < 3; i++) st = PR.recordResult(PR.decide(summaryBroken, st, T + i * 61000).state, false);
  st = PR.decide(summaryBroken, st, T + 4 * 61000).state;      // escalated
  const ok = PR.decide(healthy, st, T + 5 * 61000);            // fault went away
  assert.strictEqual(ok.state.escalated, false);
  const nextFault = PR.decide(summaryBroken, ok.state, T + 6 * 61000);
  assert.strictEqual(nextFault.action, PR.ACTION.REPAIR, 'a new fault is not punished for an old one');
});

test('the daily ceiling caps a runaway loop', () => {
  let st = PR.rollDay(null, DAY);
  st.attempts = 20;
  const d = PR.decide(summaryBroken, st, T + 999999);
  assert.strictEqual(d.action, PR.ACTION.CAPPED);
});

test('a new trading day resets the budget', () => {
  let st = PR.rollDay(null, DAY);
  st.attempts = 20;
  const rolled = PR.rollDay(st, '2026-09-02');
  assert.strictEqual(rolled.attempts, 0);
  assert.strictEqual(PR.decide(summaryBroken, rolled, T).action, PR.ACTION.REPAIR);
});

test('undefined readability is not treated as broken', () => {
  // A field the caller could not determine must not trigger a click. Unknown is
  // not the same as false — the same rule the oversize guard states in its header.
  const d = PR.decide({ summaryReadable: undefined, positionsReadable: undefined }, fresh(), T);
  assert.strictEqual(d.action, PR.ACTION.HEALTHY);
});

// ── The orders fault (2026-09-02) ──────────────────────────────────────────
// decide() has accepted `ordersReadable` since this module shipped and NOTHING
// EVER PASSED ONE — server.js wired only the summary tab. That gap ran the feed
// on the balance-delta fold for two sessions, writing nine trades with xp:null,
// which is what left the post-exit drift panel anchored on a two-day-old price.
// These tests exist so the orders route cannot go unwired again unnoticed.
test('an unrendered orders table asks for the orders tab, and only that tab', () => {
  const d = PR.decide({ summaryReadable: true, positionsReadable: true, ordersReadable: false }, fresh(), T);
  assert.equal(d.action, PR.ACTION.REPAIR);
  assert.deepEqual(d.want, ['orders']);
});

test('orders recovering clears the streak so a later fault gets fresh attempts', () => {
  let st = fresh();
  st = PR.recordResult(st, false);
  st = PR.recordResult(st, false);
  assert.equal(st.consecutiveFailures, 2);
  const d = PR.decide({ ordersReadable: true }, st, T);
  assert.equal(d.action, PR.ACTION.HEALTHY);
  assert.equal(d.state.consecutiveFailures, 0);
  assert.equal(d.state.escalated, false);
});

test('orders repair escalates rather than looping — the 9.5-hour lesson', () => {
  let st = fresh();
  for (let i = 0; i < 3; i++) st = PR.recordResult(st, false);
  const d = PR.decide({ ordersReadable: false }, st, T);
  assert.equal(d.action, PR.ACTION.ESCALATE);
  assert.match(d.reason, /orders/);
});

// WHY server.js KEEPS TWO SEPARATE STATES. Escalation is a latch and the
// recovery branch clears it. Sharing one ledger across the summary and orders
// faults means a summary escalation blocks the orders repair, and a summary
// recovery un-escalates an orders fault that is still broken. This asserts the
// coupling those two ledgers exist to prevent is real, not hypothetical.
test('one shared state would let a summary recovery un-escalate a live orders fault', () => {
  let shared = fresh();
  for (let i = 0; i < 3; i++) shared = PR.recordResult(shared, false);
  shared = PR.decide({ ordersReadable: false }, shared, T).state;
  assert.equal(shared.escalated, true);
  const afterSummaryOk = PR.decide({ summaryReadable: true }, shared, T);
  assert.equal(afterSummaryOk.action, PR.ACTION.HEALTHY);
  assert.equal(afterSummaryOk.state.escalated, false, 'this is the coupling — hence two ledgers in server.js');
});
