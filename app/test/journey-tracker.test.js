const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JT = require('../journey-tracker.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journey-tracker-test-'));
}

// ── The core lifecycle ────────────────────────────────────────────────────

test('a fresh journey starts in phase EVAL', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k', startBalance: 50000 });
  assert.strictEqual(JT.phaseOf(j), 'EVAL');
  assert.strictEqual(j.funded, null);
  assert.strictEqual(j.eval.status, 'active');
});

test('eval breach ends the journey — phase EVAL_BREACHED, funded never opens', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const res = JT.recordEvalBreach(dir, j.id, { finalBalance: 48000 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(JT.phaseOf(res.journey), 'EVAL_BREACHED');
  assert.strictEqual(res.journey.funded, null);
  assert.strictEqual(res.journey.eval.finalBalance, 48000);
  assert.ok(res.journey.eval.endedAt);
});

test('eval cleared opens funded ON THE SAME RECORD — this is the whole point', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const res = JT.recordEvalCleared(dir, j.id, { finalBalance: 53200, fundedStartBalance: 50000 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.journey.eval.status, 'cleared');
  assert.ok(res.journey.funded, 'funded phase must open in the SAME journey, not a new record');
  assert.strictEqual(res.journey.funded.status, 'active');
  assert.strictEqual(res.journey.id, j.id, 'still one journey, one id — no second record');
  assert.strictEqual(JT.phaseOf(res.journey), 'FUNDED');
});

test('funded breach ends the journey — phase FUNDED_BREACHED', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalCleared(dir, j.id, {});
  const res = JT.recordFundedBreach(dir, j.id, { finalBalance: 44000 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(JT.phaseOf(res.journey), 'FUNDED_BREACHED');
  assert.ok(JT.isTerminal(res.journey));
});

// ── Multiple payouts (Anoop: "multiple payouts can be achieved") ──────────

test('a payout does NOT close the journey — funded stays active for the next one', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalCleared(dir, j.id, {});
  const p1 = JT.recordFundedPayout(dir, j.id, { amount: 1500, date: '2026-09-01' });
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.journey.funded.status, 'active', 'a payout is not a breach — the account keeps trading');
  const p2 = JT.recordFundedPayout(dir, j.id, { amount: 2200, date: '2026-10-01' });
  assert.strictEqual(p2.ok, true);
  assert.strictEqual(p2.journey.funded.payouts.length, 2);
  assert.strictEqual(JT.summarize(p2.journey).payoutTotal, 3700);
});

test('a payout after a funded breach is rejected — cannot pay out a dead account', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalCleared(dir, j.id, {});
  JT.recordFundedBreach(dir, j.id, {});
  const res = JT.recordFundedPayout(dir, j.id, { amount: 500 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'funded-not-active');
});

test('a non-positive or garbage payout amount is rejected, not silently recorded as 0', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalCleared(dir, j.id, {});
  for (const bad of [0, -100, NaN, undefined, 'lots']) {
    const res = JT.recordFundedPayout(dir, j.id, { amount: bad });
    assert.strictEqual(res.ok, false, `amount ${bad} must be rejected`);
  }
});

// ── THE GUARDS: this is what prevents the s1/s3 cross-contamination shape ──

test('THE BUG THIS PREVENTS: cannot breach an eval phase twice (no duplicate archive record)', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const first = JT.recordEvalBreach(dir, j.id, { finalBalance: 48000 });
  assert.strictEqual(first.ok, true);
  const second = JT.recordEvalBreach(dir, j.id, { finalBalance: 40000 });
  assert.strictEqual(second.ok, false, 'a second breach on the same journey must be rejected');
  assert.strictEqual(second.reason, 'eval-not-active');
  // and the original record is untouched by the rejected attempt
  const [reread] = JT.readJourneys(dir).filter(x => x.id === j.id);
  assert.strictEqual(reread.eval.finalBalance, 48000);
});

test('cannot clear an already-breached eval — the state machine has no path from EVAL_BREACHED to FUNDED', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalBreach(dir, j.id, {});
  const res = JT.recordEvalCleared(dir, j.id, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'eval-not-active');
});

test('cannot breach funded before eval has cleared — funded phase does not exist yet', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const res = JT.recordFundedBreach(dir, j.id, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'funded-not-active');
  assert.strictEqual(j.funded, null);
});

test('a transition on an unknown journey id fails cleanly, not silently', () => {
  const dir = tmpDir();
  const res = JT.recordEvalBreach(dir, 'j999', {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no-such-journey');
});

// ── activeJourneyForSlot: how the existing breach/clear UI addresses a journey without tracking ids ──

test('activeJourneyForSlot finds the open journey for a slot, and only non-terminal ones', () => {
  const dir = tmpDir();
  const j1 = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  assert.strictEqual(JT.activeJourneyForSlot(dir, 's1').id, j1.id);
  JT.recordEvalBreach(dir, j1.id, {});
  assert.strictEqual(JT.activeJourneyForSlot(dir, 's1'), null, 'a terminal journey must not be handed back for further transitions');
});

test('activeJourneyForSlot picks the MOST RECENT attempt when a slot has been through multiple journeys', () => {
  const dir = tmpDir();
  const j1 = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.recordEvalBreach(dir, j1.id, {});
  const j2 = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' }); // second attempt, same slot
  const found = JT.activeJourneyForSlot(dir, 's1');
  assert.strictEqual(found.id, j2.id, 'must return the newer attempt, not the breached one');
});

test('activeJourneyForSlot never crosses slots — the exact failure mode found on 2026-08-16', () => {
  const dir = tmpDir();
  JT.startEvalJourney(dir, { slotId: 's3', size: '50k' }); // s3's own journey
  assert.strictEqual(JT.activeJourneyForSlot(dir, 's1'), null,
    's1 must never see s3\'s journey — this is the exact cross-slot contamination that corrupted account_archives.json');
});

// ── Persistence shape ────────────────────────────────────────────────────

test('the file is a single JSON array — "a single dataset", not per-slot files', () => {
  const dir = tmpDir();
  JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  JT.startEvalJourney(dir, { slotId: 's3', size: '150k' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'account_journeys.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk));
  assert.strictEqual(onDisk.length, 2);
});

test('journey ids are stable and monotonically assigned even after reload', () => {
  const dir = tmpDir();
  const j1 = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const j2 = JT.startEvalJourney(dir, { slotId: 's2', size: '50k' });
  assert.notStrictEqual(j1.id, j2.id);
  const reread = JT.readJourneys(dir);
  assert.strictEqual(reread.length, 2);
  assert.deepStrictEqual(reread.map(j => j.id).sort(), [j1.id, j2.id].sort());
});

test('readJourneys on a missing or corrupt file returns [] rather than throwing', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(JT.readJourneys(dir), []);
  fs.writeFileSync(path.join(dir, 'account_journeys.json'), 'not json{{{');
  assert.deepStrictEqual(JT.readJourneys(dir), []);
  fs.writeFileSync(path.join(dir, 'account_journeys.json'), '{"not":"an array"}');
  assert.deepStrictEqual(JT.readJourneys(dir), []);
});

test('summarize() totals payouts correctly and reports null-safe on a bare eval journey', () => {
  const dir = tmpDir();
  const j = JT.startEvalJourney(dir, { slotId: 's1', size: '50k' });
  const s = JT.summarize(j);
  assert.strictEqual(s.phase, 'EVAL');
  assert.strictEqual(s.payoutCount, 0);
  assert.strictEqual(s.payoutTotal, 0);
});
