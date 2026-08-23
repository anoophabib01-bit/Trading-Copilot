const test = require('node:test');
const assert = require('node:assert');
const PSO = require('../post-session-orchestrator.js');

// A real day's shape (adapted from DATA/accounts/s3/CLOSED_breached.json,
// 2026-08-05 — a genuinely clean-ish day: no revenge, no escalation).
function cleanDay() {
  return {
    date: '2026-08-06', n: 6, pnl: 450, gross: 470, contracts: 10, maxSize: 2,
    over: 0, revenge: 0, disc: 90, best: 181.5, worst: -1, avgWin: 111.25, avgLoss: -0.5,
    avgHold: 480, medHold: 460, wins: 4, losses: 2, peak: 450, giveback: 0,
    maxConsecLoss: 1, tradedPast3Losses: false, under5: 0, holdExceeded: 0
  };
}

test('a clean day triggers zero workers', () => {
  const flags = PSO.detectFlags({ gr: cleanDay(), quadrant: 'EARNED_IT', ckToday: { tier: 'GO' }, rules: {} });
  assert.deepStrictEqual(flags, []);
  assert.deepStrictEqual(PSO.selectWorkers(flags), []);
});

test('THE REAL BLOW-UP DAY (2026-08-12, from account_report.html): trips escalation, giveback, revenge', () => {
  // 15 trades, sizes up to 15, several revenge-flagged, day swung from a peak
  // then gave much of it back. Adapted from the real deduped 2026-08-12 s3 data.
  const gr = {
    date: '2026-08-12', n: 15, pnl: -363.5, gross: -320, contracts: 73, maxSize: 15,
    over: 8, revenge: 9, disc: 40, best: 137, worst: -378, avgWin: 47.5, avgLoss: -142.6,
    avgHold: 300, medHold: 90, wins: 6, losses: 9, peak: 320, giveback: 683.5,
    maxConsecLoss: 3, tradedPast3Losses: true, under5: 10, holdExceeded: 2
  };
  const flags = PSO.detectFlags({ gr, quadrant: 'DOUBLE_FAILURE', ckToday: { tier: 'SKIPPED' }, rules: { tradesPerDay: 10, tradesPerSession: 5 } });
  assert.ok(flags.includes('escalation'), 'n=15 >= tradesPerDay=10');
  assert.ok(flags.includes('revenge'));
  assert.ok(flags.includes('invertedRR'), 'avgLoss 142.6 > 2x avgWin 47.5');
  assert.ok(flags.includes('holdingLosers'));
  assert.ok(flags.includes('giveback'));
  assert.ok(flags.includes('fastEntries'), '10/15 under 5 min = 67%');
  assert.ok(flags.includes('biasAdherence'));
  assert.ok(flags.includes('checklistSkip'));

  const workers = PSO.selectWorkers(flags);
  assert.strictEqual(workers.length, flags.length);
  workers.forEach(w => { assert.ok(w.persona && w.persona.length > 20); assert.ok(w.title); });
});

test('escalation triggers on session-count blowout even under the daily cap', () => {
  const gr = Object.assign(cleanDay(), { n: 11 }); // 11 trades, well under a 20 dayCap but > 2x a 5-session cap
  const flags = PSO.detectFlags({ gr, rules: { tradesPerDay: 20, tradesPerSession: 5 } });
  assert.ok(flags.includes('escalation'));
});

test('revenge does not trigger inverted R:R by itself — they are independent checks', () => {
  const gr = Object.assign(cleanDay(), { revenge: 3 });
  const flags = PSO.detectFlags({ gr, rules: {} });
  assert.deepStrictEqual(flags, ['revenge']);
});

test('invertedRR requires actual losses — a day with zero losses cannot be "inverted"', () => {
  const gr = Object.assign(cleanDay(), { avgLoss: -1000, avgWin: 10, losses: 0 });
  const flags = PSO.detectFlags({ gr, rules: {} });
  assert.ok(!flags.includes('invertedRR'), 'avgLoss with zero actual losing trades is not a real signal');
});

test('giveback requires BOTH a real peak and a real giveback — a giveback of 0 must not trigger', () => {
  const gr1 = Object.assign(cleanDay(), { peak: 500, giveback: 0 });
  assert.ok(!PSO.detectFlags({ gr: gr1 }).includes('giveback'));
  const gr2 = Object.assign(cleanDay(), { peak: 0, giveback: 50 });
  assert.ok(!PSO.detectFlags({ gr: gr2 }).includes('giveback'), 'no real peak means no real "up then crashed" story');
});

test('biasAdherence only fires on the three bad quadrants, not EARNED_IT or UNJUDGED', () => {
  assert.ok(!PSO.detectFlags({ quadrant: 'EARNED_IT' }).includes('biasAdherence'));
  assert.ok(!PSO.detectFlags({ quadrant: 'UNJUDGED' }).includes('biasAdherence'));
  assert.ok(PSO.detectFlags({ quadrant: 'GOT_AWAY_WITH_IT' }).includes('biasAdherence'));
  assert.ok(PSO.detectFlags({ quadrant: 'HONEST_MISS' }).includes('biasAdherence'));
  assert.ok(PSO.detectFlags({ quadrant: 'DOUBLE_FAILURE' }).includes('biasAdherence'));
});

test('checklistSkip only fires on an explicit SKIPPED tier, never on an absent record', () => {
  assert.deepStrictEqual(PSO.detectFlags({ ckToday: null }), []);
  assert.deepStrictEqual(PSO.detectFlags({ ckToday: { tier: 'GO' } }), []);
  assert.deepStrictEqual(PSO.detectFlags({ ckToday: { tier: 'SKIPPED' } }), ['checklistSkip']);
});

// ── Fail-open behaviour: a bad review must never be the thing that breaks ──

test('detectFlags on completely empty/garbage input returns [] rather than throwing', () => {
  assert.doesNotThrow(() => PSO.detectFlags());
  assert.doesNotThrow(() => PSO.detectFlags({}));
  assert.doesNotThrow(() => PSO.detectFlags({ gr: 'nonsense', quadrant: 42, ckToday: 'x', rules: null }));
  assert.deepStrictEqual(PSO.detectFlags({ gr: 'nonsense' }), []);
});

test('a malformed gr field does not prevent OTHER fields from being checked', () => {
  const gr = { n: 20, revenge: 'not-a-number', giveback: 200, peak: 300 };
  const flags = PSO.detectFlags({ gr, rules: { tradesPerDay: 10 } });
  assert.ok(flags.includes('escalation'), 'a bad revenge field must not suppress the escalation check');
  assert.ok(flags.includes('giveback'));
  assert.ok(!flags.includes('revenge'), 'a non-numeric revenge count is correctly not flagged');
});

test('selectWorkers ignores unknown flag keys instead of crashing on a typo', () => {
  const workers = PSO.selectWorkers(['revenge', 'not-a-real-topic', 'giveback']);
  assert.deepStrictEqual(workers.map(w => w.topic), ['revenge', 'giveback']);
});

test('selectWorkers on empty/garbage input returns []', () => {
  assert.deepStrictEqual(PSO.selectWorkers([]), []);
  assert.deepStrictEqual(PSO.selectWorkers(null), []);
  assert.deepStrictEqual(PSO.selectWorkers(undefined), []);
});

// ── deterministicSummary ─────────────────────────────────────────────────

test('deterministicSummary formats a real day without an LLM call', () => {
  const s = PSO.deterministicSummary(cleanDay());
  assert.match(s, /2026-08-06/);
  assert.match(s, /\$470/);
  assert.match(s, /\$450/);
  assert.match(s, /67%/); // 4W/2L
});

test('deterministicSummary handles a negative net day with correct sign', () => {
  const gr = Object.assign(cleanDay(), { pnl: -363.5, gross: -320 });
  const s = PSO.deterministicSummary(gr);
  assert.match(s, /-\$320/);
  assert.match(s, /-\$363\.5/);
});

test('deterministicSummary on missing gr returns null, not a throw or a fabricated line', () => {
  assert.strictEqual(PSO.deterministicSummary(null), null);
  assert.strictEqual(PSO.deterministicSummary(undefined), null);
  assert.strictEqual(PSO.deterministicSummary('nonsense'), null);
});

test('every TOPICS entry has both a title and a persona, and every worker in selectWorkers carries both', () => {
  Object.keys(PSO.TOPICS).forEach(k => {
    assert.ok(PSO.TOPICS[k].title, `${k} missing a title`);
    assert.ok(PSO.TOPICS[k].persona && PSO.TOPICS[k].persona.length > 20, `${k} persona too short/missing`);
  });
});
