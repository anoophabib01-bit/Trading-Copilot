'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../ai-decision-gate');

const ANS = (eq, sf) => ({ ok: true, answers: Object.assign({},
  eq == null ? {} : { entry_quality: { type: 'noul', noul: eq } },
  sf == null ? {} : { stop_first_risk: { type: 'noul', noul: sf } }) });
const ON = { enabled: true };

// ═══ 1. THE BYPASS — the property the whole file exists for ═══════════════
test('every exit-side action bypasses the gate', () => {
  for (const a of ['exit', 'close', 'flatten', 'stop_hit', 'target_hit', 'emergency', 'reduce', 'partial_exit', 'trailing_stop', 'time_stop', 'kill']) {
    assert.equal(gate.bypassesGate(a).bypass, true, a + ' must bypass');
  }
});

test('the bypass is case- and whitespace-proof — a stop is a stop', () => {
  for (const a of ['EXIT', ' Close ', 'Flatten', 'STOP_HIT']) {
    assert.equal(gate.bypassesGate(a).bypass, true, JSON.stringify(a) + ' must bypass');
  }
});

test('an order that REDUCES size bypasses whatever it is called', () => {
  // Intent is not enough: something named "manage" that shrinks the position is
  // exit-side by construction.
  assert.equal(gate.bypassesGate('manage', { sizeDelta: -2 }).bypass, true);
  assert.match(gate.bypassesGate('manage', { sizeDelta: -2 }).reason, /reduces position size/);
});

test('a caller can mark an exit explicitly, for a path the list never anticipated', () => {
  assert.equal(gate.bypassesGate('some_new_action', { isExit: true }).bypass, true);
});

test('an ENTRY does not bypass', () => {
  for (const a of ['buy', 'sell', 'enter', 'open']) {
    assert.equal(gate.bypassesGate(a).bypass, false, a + ' must NOT bypass');
  }
  assert.equal(gate.bypassesGate('buy', { sizeDelta: 2 }).bypass, false);
});

test('a zero size delta is not an exit', () => {
  assert.equal(gate.bypassesGate('buy', { sizeDelta: 0 }).bypass, false);
});

// ═══ 2. NO LOOKAHEAD ══════════════════════════════════════════════════════
test('a datum available AFTER the decision time is a violation', () => {
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const r = gate.assertNoLookahead({ order: { available_at: '2026-09-21T10:05:00Z' } }, t0);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].path, 'order.available_at');
  assert.equal(r.violations[0].msAhead, 300000);
});

test('data available BEFORE the decision is fine, including exactly at it', () => {
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  assert.equal(gate.assertNoLookahead({ a: { available_at: '2026-09-21T09:59:00Z' } }, t0).ok, true);
  assert.equal(gate.assertNoLookahead({ a: { available_at: '2026-09-21T10:00:00Z' } }, t0).ok, true);
});

test('it walks nested objects AND arrays, so a hidden bar cannot slip through', () => {
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const r = gate.assertNoLookahead({ a: { b: [{ c: { available_at: '2026-09-21T11:00:00Z' } }] } }, t0);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].path, 'a.b[0].c.available_at');
});

test('a state with no timestamps is not a violation', () => {
  assert.equal(gate.assertNoLookahead({ order: { side: 'buy' } }, Date.now()).ok, true);
});

test('the guard never throws on junk — a guard that throws stops being a guard', () => {
  for (const bad of [null, undefined, 42, 'x', []]) assert.doesNotThrow(() => gate.assertNoLookahead(bad, Date.now()));
});

// ═══ 3. THE STATE ═════════════════════════════════════════════════════════
test('the state carries what QuantDinger sends: order, strategy, exposure, budget', () => {
  const s = gate.buildState({ symbol: 'MNQ', side: 'buy', quantity: 2, entry: 30000, stop: 29980, target: 30040 },
    { strategy: { id: 'A' }, exposure: { openPositions: 1 }, budget: { dayPnl: -200, losingStreak: 2 } });
  // The state is snake_case throughout, matching the other states this app sends
  // Jev (typesafe-journal.js uses the same convention). The first version of this
  // test read camelCase keys that the state never had.
  assert.equal(s.order.symbol, 'MNQ');
  assert.equal(s.strategy.id, 'A');
  assert.equal(s.exposure.open_positions, 1);
  assert.equal(s.budget.losing_streak, 2);
  assert.ok(s.assembled_at, 'the assembly time is stamped so a caller cannot forget it');
});

test('absent context is null, never invented', () => {
  const s = gate.buildState({ side: 'buy' }, {});
  assert.equal(s.strategy, null);
  assert.equal(s.exposure, null);
});

// ═══ 4. FAIL-OPEN — the rule that protects a live position ════════════════
test('a disabled gate allows and says so', () => {
  const r = gate.decide(ANS(0.1, 0.1), { enabled: false });
  assert.equal(r.allow, true);
  assert.equal(r.decision, 'disabled');
});

test('a failed call FAILS OPEN and records the reason', () => {
  const r = gate.decide({ ok: false, reason: 'HTTP 503' }, ON);
  assert.equal(r.allow, true);
  assert.match(r.reason, /503/);
  assert.match(r.reason, /ALLOWED and this is logged/);
});

test('an answer with neither check fails open, it does not refuse', () => {
  const r = gate.decide({ ok: true, answers: {} }, ON);
  assert.equal(r.allow, true);
  assert.match(r.reason, /neither check/);
});

test('a malformed answer fails open', () => {
  for (const bad of [{ ok: true }, { ok: true, answers: { entry_quality: { type: 'noul' } } }, null, undefined, 42]) {
    assert.doesNotThrow(() => gate.decide(bad, ON));
    assert.equal(gate.decide(bad, ON).allow, true);
  }
});

// ═══ 5. THE TWO CHECKS, AND WHICH ONE REFUSES ═════════════════════════════
test('both checks passing allows the entry', () => {
  const r = gate.decide(ANS(0.9, 0.1), ON);
  assert.equal(r.allow, true);
  assert.equal(r.decision, 'allowed');
  assert.equal(r.checks.entry_quality.passed, true);
  assert.equal(r.checks.stop_first_risk.passed, true);
});

test('stop_first_risk is INVERTED — a high probability of stop-first is a REFUSAL', () => {
  // This is the one place an inversion happens, and it is why the two questions
  // are asked separately: the dangerous answer to this one is YES.
  const r = gate.decide(ANS(0.9, 0.9), ON);
  assert.equal(r.allow, false);
  assert.equal(r.decision, 'refused');
  assert.equal(r.checks.stop_first_risk.passed, false);
  assert.match(r.reason, /stop_first_risk/);
});

test('a stop-first refusal is honoured even when the entry check is happy', () => {
  // Refusing a good entry costs an opportunity. Missing that the stop gets hit
  // first costs the full position.
  assert.equal(gate.decide(ANS(0.99, 0.8), ON).allow, false);
});

test('a failing entry check alone does NOT refuse unless requireBoth is set', () => {
  assert.equal(gate.decide(ANS(0.1, 0.1), ON).allow, true, 'stop-first is the only refusal that stands alone');
  assert.equal(gate.decide(ANS(0.1, 0.1), { enabled: true, requireBoth: true }).allow, false);
});

test('the refusal says it is an ENTRY refusal and that exits are unaffected', () => {
  const r = gate.decide(ANS(0.9, 0.9), ON);
  assert.match(r.reason, /ENTRY refusal only/);
  assert.match(r.reason, /exit side is affected|nothing on the exit side/);
});

test('a missing check is recorded as missing, not as a pass', () => {
  const r = gate.decide(ANS(0.9, null), ON);
  // Explicit null, not undefined: a caller reading the audit trail should be able
  // to see the check was absent, rather than find the key missing entirely.
  assert.equal(r.checks.stop_first_risk, null);
  assert.equal(r.checks.entry_quality.passed, true);
  assert.match(r.reason, /only one check answered/);
});

test('the floor is configurable and applied to both checks', () => {
  assert.equal(gate.decide(ANS(0.6, 0.1), ON, { floor: 0.7 }).allow, true, 'entry below floor, but only stop-first refuses');
  assert.equal(gate.decide(ANS(0.9, 0.6), ON, { floor: 0.7 }).allow, false, 'stop-first below floor refuses');
});

// ═══ 6. THE AUDIT LINE ════════════════════════════════════════════════════
test('the decision line names the checks, the outcome, the latency and the reason', () => {
  const line = gate.describeDecision(gate.decide(ANS(0.9, 0.9), ON, { latencyMs: 412, provider: 'typesafe' }));
  assert.match(line, /REFUSED/);
  assert.match(line, /entry_quality=pass/);
  assert.match(line, /stop_first_risk=FAIL/);
  assert.match(line, /412ms/);
  assert.match(line, /via typesafe/);
});

test('the line never claims a probability of profit', () => {
  const line = gate.describeDecision(gate.decide(ANS(0.9, 0.1), ON));
  assert.equal(/%|chance|probability of/i.test(line), false);
});
