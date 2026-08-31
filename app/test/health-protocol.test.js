'use strict';
// ── PROTOCOL 1 tests ───────────────────────────────────────────────────────
// Each scenario is a real "silent turn off" from this repo's own history — a
// fault that ran for days or weeks with the app looking entirely normal.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, isDue, GUARDS, SEV, THREE_DAYS_MS } = require('../health-protocol.js');

const RULES = {
  requireChecklist: true,
  oneInstrumentPerDay: true,
  lossRatchet: { enabled: true },
  contractsPerDay: { enabled: true },
  biasAdherence: { enabled: true },
  eval: { start: 50378.60 },
};
const healthy = () => ({
  deadRefs: [],
  stress: [{ module: 'detectors.adxSeries', ok: true }],
  timers: [{ name: 'signal-outcome resolver', alive: true }],
  dataIntegrity: { days: [{ day: '2026-08-28', rowsNet: 10, ledgerNet: 10, historyPnl: 10, agree: true }] },
  signalPipeline: { signalsToday: 5, armedToday: 2, outcomesResolved: 2, lastSignalAgeH: 1 },
  accountConfig: { accountSize: '50k', configuredStart: 50378.60 },
  diskWritable: true,
  testSuite: { pass: 1142, fail: 0 },
});
const find = (r, k) => r.checks.find(c => c.key === k);

test('a healthy system passes everything', () => {
  const r = evaluate(healthy(), RULES);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(r.unknown, 0);
  assert.match(r.headline, /all checks passed/);
});

// ── the four kinds of silent turn-off ──────────────────────────────────────
test('catches a DEAD BUTTON — renderer reaching outside its scope', () => {
  // The Standard/Scalper toggle was broken this way from 2026-08-01 and looked
  // perfectly normal, because the config handler set the button state on load.
  const obs = healthy();
  obs.deadRefs = [{ file: 'app.js', line: 694, text: 'if (ws && ws.readyState === 1) ws.send(...)' }];
  const c = find(evaluate(obs, RULES), 'dead-refs');
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.severity, SEV.CRITICAL);
  assert.match(c.impact, /still LOOKS correct/);
});

test('catches a MODULE THAT RUNS AND PRODUCES NOTHING', () => {
  // signal-outcome.js resolved signals for weeks and wrote zero rows.
  const obs = healthy();
  obs.signalPipeline = { signalsToday: 17, armedToday: 17, outcomesResolved: 0, lastSignalAgeH: 2 };
  const c = find(evaluate(obs, RULES), 'signal-pipeline');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /ZERO outcomes resolved/);
});

test('no armed signals and no outcomes is NOT a failure — nothing fired', () => {
  const obs = healthy();
  obs.signalPipeline = { signalsToday: 3, armedToday: 0, outcomesResolved: 0, lastSignalAgeH: 4 };
  assert.strictEqual(find(evaluate(obs, RULES), 'signal-pipeline').verdict, 'pass');
});

test('catches GUARDS SWITCHED OFF and says what each exposes', () => {
  const rules = Object.assign({}, RULES, { requireChecklist: false, lossRatchet: { enabled: false } });
  const c = find(evaluate(healthy(), rules), 'guards');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /checklist/i);
  assert.match(c.impact, /\$855\.50/);          // the incident that made it a hard gate
  assert.match(c.impact, /ratchet/i);
  assert.deepEqual(c.evidence.off, ['requireChecklist', 'lossRatchet.enabled']);
});

test('a disabled guard is NEVER auto-re-enabled', () => {
  // Turning a guard back on behind the user would make "off" impossible to
  // choose. It is reported every cycle instead.
  const rules = Object.assign({}, RULES, { requireChecklist: false });
  const c = find(evaluate(healthy(), rules), 'guards');
  assert.strictEqual(c.rectify, null);
});

test('catches a DRIFTED NUMBER — start balance vs account size', () => {
  // eval.start said 150000 on an account that is actually 50K.
  const obs = healthy();
  obs.accountConfig = { accountSize: '50k', configuredStart: 150000 };
  const c = find(evaluate(obs, RULES), 'account-config');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /drawdown floor and profit target/);
});

test('a deliberately corrected start balance is still plausible', () => {
  const obs = healthy();
  obs.accountConfig = { accountSize: '50k', configuredStart: 50378.60 };
  assert.strictEqual(find(evaluate(obs, RULES), 'account-config').verdict, 'pass');
});

// ── the rest ───────────────────────────────────────────────────────────────
test('catches the three stores disagreeing', () => {
  const obs = healthy();
  obs.dataIntegrity = { days: [
    { day: '2026-08-26', rowsNet: -498.80, ledgerNet: -673.60, historyPnl: -673.60, agree: false },
    { day: '2026-08-27', rowsNet: -55.56, ledgerNet: -55.56, historyPnl: -55.56, agree: true },
  ] };
  const c = find(evaluate(obs, RULES), 'data-integrity');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /one fact stored three ways/);
  assert.strictEqual(c.evidence.disagreeing.length, 1);
});

test('catches a stopped background timer and restarts it', () => {
  const obs = healthy();
  obs.timers = [{ name: 'signal-outcome resolver', alive: false }, { name: 'shadow resolver', alive: true }];
  const r = evaluate(obs, RULES);
  const c = find(r, 'timers');
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.rectify, 'restart-timers');
  assert.deepEqual(c.evidence.stopped, ['signal-outcome resolver']);
});

test('catches a module that INVENTS a number from bad input', () => {
  // chart-reads.js once produced an EMA of 65,750,116.55 from one malformed
  // bar — a plausible wrong number, not an obvious NaN.
  const obs = healthy();
  obs.stress = [{ module: 'chart-reads.ema', ok: false, error: 'returned a non-finite number' }];
  const c = find(evaluate(obs, RULES), 'stress');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /confident wrong read/);
});

test('catches an unwritable data directory', () => {
  const obs = healthy();
  obs.diskWritable = false;
  const c = find(evaluate(obs, RULES), 'disk');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /lost on restart/);
});

test('catches a red test suite', () => {
  const obs = healthy();
  obs.testSuite = { pass: 1100, fail: 3 };
  assert.strictEqual(find(evaluate(obs, RULES), 'tests').verdict, 'fail');
});

// ── the discipline ─────────────────────────────────────────────────────────
test('UNKNOWN is never counted as a pass', () => {
  const r = evaluate({}, RULES);
  assert.strictEqual(find(r, 'dead-refs').verdict, 'unknown');
  assert.ok(r.unknown >= 1);
  assert.match(r.headline, /unverifiable/);
});

test('every failing check states an impact and carries evidence', () => {
  const obs = healthy();
  obs.deadRefs = [{ file: 'a.js', line: 1, text: 'ws.send()' }];
  obs.diskWritable = false;
  obs.timers = [{ name: 't', alive: false }];
  for (const c of evaluate(obs, Object.assign({}, RULES, { requireChecklist: false })).checks.filter(x => x.verdict === 'fail')) {
    assert.ok(c.impact && c.impact.length > 20, `${c.key} has no usable impact statement`);
    assert.ok(c.evidence, `${c.key} has no evidence`);
  }
});

// ── the 3-day cadence ──────────────────────────────────────────────────────
test('never run before means due now', () => {
  assert.strictEqual(isDue(0, Date.now()), true);
  assert.strictEqual(isDue(null, Date.now()), true);
});

test('due exactly at three days, not before', () => {
  const now = 1000000000000;
  assert.strictEqual(isDue(now - THREE_DAYS_MS + 1000, now), false);
  assert.strictEqual(isDue(now - THREE_DAYS_MS, now), true);
});

test('the cadence survives restarts — it is measured from the LAST RUN, not from boot', () => {
  // A 3-day timer reset on every launch would, for an app restarted daily,
  // never fire. This is why the last-run stamp is persisted.
  const now = 1000000000000;
  assert.strictEqual(isDue(now - 2 * 24 * 3600 * 1000, now), false, 'two days in: not yet');
  assert.strictEqual(isDue(now - 4 * 24 * 3600 * 1000, now), true, 'four days in: overdue');
});

test('every guard names what it exposes', () => {
  for (const g of GUARDS) {
    assert.ok(g.exposes && g.exposes.length > 30, `${g.path} does not say what it exposes`);
  }
});
