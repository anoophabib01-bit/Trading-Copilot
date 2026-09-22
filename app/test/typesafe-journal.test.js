'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const j = require('../typesafe-journal');

const TAXONOMY = {
  options: { 'revenge re-entry': 're-entered inside the cooldown after a loss', 'oversized': 'more than the cap', 'none': 'process held up' },
  stateLevels: ['steady', 'pressured', 'tilted'],
};
const RULES_ON = { typesafe: { enabled: true, model: 'jev-latest', timeoutMs: 1000, maxCallsPerDay: 40, maxStateChars: 6000 }, mistakeTaxonomy: TAXONOMY };
const CFG = { typesafeApiKey: 'k-test' };

// ── buildQuestions ─────────────────────────────────────────────────────────
test('the rubric in rules.json becomes the typed question set', () => {
  const q = j.buildQuestions(TAXONOMY);
  assert.equal(q.mistake.type, 'choice');
  assert.deepEqual(Object.keys(q.mistake.criteria), ['revenge re-entry', 'oversized', 'none']);
  assert.equal(q.state_drift.type, 'score');
  assert.deepEqual(q.state_drift.criteria, ['steady', 'pressured', 'tilted']);
  assert.equal(q.plan_followed.type, 'noul');
  assert.equal(q.entry_was_setup.type, 'noul');
});

test('an unconfigured rubric produces NO questions at all — never a half-classified day', () => {
  // The taxonomy IS this job's contract. Returning only the two boolean
  // questions would record "plan not followed" with no mistake label beside it,
  // i.e. a partial answer stored as if it were a whole one.
  assert.deepEqual(Object.keys(j.buildQuestions({})), []);
  assert.deepEqual(Object.keys(j.buildQuestions({ options: { only: 'one option' } })), [], 'a one-option choice is not a question');
});

test('with a rubric the two boolean questions ride along', () => {
  const q = j.buildQuestions(TAXONOMY);
  assert.ok(q.plan_followed, 'plan adherence is asked whenever a rubric exists');
  assert.ok(q.entry_was_setup, 'so is whether the entry was a real setup');
});

test('his own descriptions are the criteria, verbatim', () => {
  const q = j.buildQuestions(TAXONOMY);
  assert.equal(q.mistake.criteria['revenge re-entry'], 're-entered inside the cooldown after a loss');
});

// ── buildState ─────────────────────────────────────────────────────────────
test('the state carries his words unparaphrased and the day numbers beside them', () => {
  const s = j.buildState(
    { text: 'I entered early because I was bored', mood: 'rushed', stateAtEntry: 'calm', stateNow: 'frustrated', entryCriteria: 'sweep then displacement' },
    { net: -280, trades: 4, maxSize: 5, sizeCap: 4, flags: ['oversize', 'revenge'] },
    '2026-09-19');
  assert.equal(s.date, '2026-09-19');
  assert.equal(s.trader_written.what_happened, 'I entered early because I was bored');
  assert.equal(s.day_numbers.net_pnl, -280);
  assert.deepEqual(s.day_numbers.flags, ['oversize', 'revenge']);
});

test('empty fields are dropped so the model is not reading a wall of blanks', () => {
  const s = j.buildState({ text: 'only this' }, null, '2026-09-19');
  assert.deepEqual(Object.keys(s.trader_written), ['what_happened']);
  assert.equal(s.day_numbers.net_pnl, null);
});

test('a very long note is clipped, never silently dropped', () => {
  const s = j.buildState({ text: 'x'.repeat(5000) }, null, '2026-09-19');
  assert.equal(s.trader_written.what_happened.length, j.MAX_TEXT);
  assert.ok(s.trader_written.what_happened.endsWith('…'));
});

test('only the most recent trades are described', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, size: 2, pnl: i, side: 'long' }));
  const s = j.buildState({ text: 'note' }, { tradesDetail: rows }, '2026-09-19');
  assert.equal(s.trades.length, j.MAX_TRADES);
  assert.equal(s.trades[s.trades.length - 1].n, 30, 'the newest, not the oldest');
});

// ── shapeResult ────────────────────────────────────────────────────────────
test('typed answers become one storable record', () => {
  const r = j.shapeResult({
    mistake: { type: 'choice', choice: 'revenge re-entry', confidence: 0.72, probabilities: { 'revenge re-entry': 0.72, none: 0.28 } },
    state_drift: { type: 'score', score: 1.4, confidence: 0.8 },
    plan_followed: { type: 'noul', noul: 0.2 },
    entry_was_setup: { type: 'noul', noul: 0.9 },
  }, { model: 'jev-1.13.0', latencyMs: 420, stateChars: 300 });
  assert.equal(r.mistake, 'revenge re-entry');
  assert.equal(r.mistakeConfidence, 0.72);
  assert.equal(r.stateDrift, 1.4);
  assert.equal(r.planFollowed, false, 'a noul below 0.5 is a no');
  assert.equal(r.entryWasSetup, true);
  assert.equal(r.model, 'jev-1.13.0');
});

test('missing answers produce nulls, not invented values', () => {
  const r = j.shapeResult({}, {});
  assert.equal(r.mistake, null);
  assert.equal(r.stateDrift, null);
  assert.equal(r.planFollowed, null);
  assert.equal(r.mistakeConfidence, null);
});

// ── classifyAndStore (real client, mocked transport, stub store) ───────────
function stubStore() {
  const data = {};
  return { data, load: (k) => data[k] || null, save: (k, v) => { data[k] = v; return true; } };
}
const okFetch = (answers) => async () => ({ status: 200, json: async () => ({ model: 'jev-1.13.0', answers }) });

test('a disabled classifier does nothing at all — no request, no store, no ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-off-'));
  const store = stubStore();
  let called = 0;
  try {
    const r = await j.classifyAndStore({
      date: '2026-09-19', slotId: 's2', note: { text: 'note' },
      rules: { typesafe: { enabled: false }, mistakeTaxonomy: TAXONOMY }, appCfg: CFG,
      deps: { dataDir: dir, save: store.save, load: store.load },
      fetchImpl: async () => { called++; return { status: 200, json: async () => ({ answers: {} }) }; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(called, 0);
    assert.deepEqual(store.data, {});
    assert.equal(fs.existsSync(path.join(dir, 'typesafe', 'calls.jsonl')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no key means silence, even with the feature switched on', async () => {
  const store = stubStore();
  const r = await j.classifyAndStore({
    date: '2026-09-19', slotId: 's2', note: { text: 'note' },
    rules: RULES_ON, appCfg: {}, env: {}, deps: { save: store.save, load: store.load },
  });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no typesafeApiKey/);
});

test('a missing rubric produces no call', async () => {
  const store = stubStore();
  let called = 0;
  const r = await j.classifyAndStore({
    date: '2026-09-19', slotId: 's2', note: { text: 'note' },
    rules: { typesafe: { enabled: true } }, appCfg: CFG, env: {},
    deps: { save: store.save, load: store.load },
    fetchImpl: async () => { called++; throw new Error('must not be called'); },
  });
  assert.equal(called, 0, 'an unconfigured rubric must not produce a guessed label');
  assert.match(r.reason, /no mistakeTaxonomy/);
  // plan_followed + entry_was_setup always exist, so the guard is the taxonomy check above
  assert.equal(r.ok, false);
});

test('the happy path stores the record beside his note and logs the call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-on-'));
  const store = stubStore();
  try {
    const r = await j.classifyAndStore({
      date: '2026-09-19', slotId: 's2',
      note: { text: 'I sized up after a loss', mood: 'revenge' },
      dayContext: { net: -526, trades: 3, maxSize: 5, sizeCap: 4, flags: ['oversize'] },
      rules: RULES_ON, appCfg: CFG, env: {},
      deps: { dataDir: dir, save: store.save, load: store.load },
      fetchImpl: okFetch({
        mistake: { type: 'choice', choice: 'sized up while losing', confidence: 0.81, probabilities: { 'sized up while losing': 0.81 } },
        plan_followed: { type: 'noul', noul: 0.1 },
        state_drift: { type: 'score', score: 1.9, confidence: 0.7 },
        entry_was_setup: { type: 'noul', noul: 0.2 },
      }),
    });
    assert.equal(r.ok, true);
    const saved = store.data['typesafe_notes__s2']['2026-09-19'];
    assert.equal(saved.mistake, 'sized up while losing');
    assert.equal(saved.planFollowed, false);
    assert.equal(saved.stateDrift, 1.9);
    const ledger = fs.readFileSync(path.join(dir, 'typesafe', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].kind, 'journal');
    assert.equal(ledger[0].ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a provider failure is recorded as a failure and stores nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fail-'));
  const store = stubStore();
  try {
    const r = await j.classifyAndStore({
      date: '2026-09-19', slotId: 's2', note: { text: 'note' },
      rules: RULES_ON, appCfg: CFG, env: {},
      deps: { dataDir: dir, save: store.save, load: store.load },
      fetchImpl: async () => ({ status: 401, json: async () => ({ error: { message: 'invalid key' } }) }),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(store.data, {}, 'a failed classification must not write a record');
    const ledger = fs.readFileSync(path.join(dir, 'typesafe', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledger[0].ok, false);
    assert.match(ledger[0].reason, /HTTP 401/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a throwing store cannot make the classifier throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-store-'));
  try {
    const r = await j.classifyAndStore({
      date: '2026-09-19', slotId: 's2', note: { text: 'note' },
      rules: RULES_ON, appCfg: CFG, env: {},
      deps: { dataDir: dir, save: () => { throw new Error('disk full'); }, load: () => ({}) },
      fetchImpl: okFetch({ plan_followed: { type: 'noul', noul: 0.9 } }),
    });
    assert.equal(r.ok, true, 'the answer still counts as obtained');
    assert.ok(r.record);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the daily cap stops further calls across a day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cap-'));
  const store = stubStore();
  let called = 0;
  try {
    const rules = { typesafe: { enabled: true, maxCallsPerDay: 1 }, mistakeTaxonomy: TAXONOMY };
    const args = {
      date: '2026-09-19', slotId: 's2', note: { text: 'note' }, rules, appCfg: CFG, env: {},
      deps: { dataDir: dir, save: store.save, load: store.load },
      fetchImpl: async () => { called++; return { status: 200, json: async () => ({ answers: { plan_followed: { type: 'noul', noul: 0.5 } } }) }; },
    };
    const first = await j.classifyAndStore(args);
    const second = await j.classifyAndStore(args);
    assert.equal(first.ok, true);
    assert.equal(called, 1);
    assert.equal(second.skipped, true);
    assert.match(second.reason, /cap reached/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
