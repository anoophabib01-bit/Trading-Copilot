'use strict';
// Tests for pattern-memory-store.js — the append-only episode ledger.
//
// The invariant that matters most: sync() is idempotent. It runs on every
// startup and after every closed trade, so a version that re-appended what it
// already had would inflate every recurrence count in the app — turning the
// one number this feature exists to state ("eleventh time") into a lie.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../pattern-memory-store');
const pm = require('../pattern-memory');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-mem-test-')); }
const T = (over) => Object.assign({ t: 1, x: 2, size: 1, pnl: 0, g: 'A', flags: [] }, over);

test('sync writes the implied episodes and reports what it added', () => {
  const dir = tmpDir();
  const res = store.sync(dir, {
    tradesByDay: { '2026-09-03': [T({ pnl: -100, flags: ['oversize'] }), T({ pnl: 50 })] },
    days: [], rules: {},
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.added.length, 2);
  assert.strictEqual(res.total, 2);
  assert.deepStrictEqual(store.readLedger(dir).map(e => e.kind).sort(), ['clean-winner', 'oversize']);
});

test('sync is IDEMPOTENT — a re-run adds nothing and does not inflate the count', () => {
  const dir = tmpDir();
  const sources = {
    tradesByDay: { '2026-09-03': [T({ pnl: -100, flags: ['oversize'] })] },
    days: [{ date: '2026-09-03', n: 6, pnl: -100, disc: 70, over: 1, revenge: 0, peak: 0 }],
    rules: { tradesPerDay: 5 },
  };
  const first = store.sync(dir, sources);
  assert.ok(first.added.length > 0);

  for (let i = 0; i < 5; i++) {
    const again = store.sync(dir, sources);
    assert.strictEqual(again.added.length, 0, 're-run must add nothing');
  }
  assert.strictEqual(store.readLedger(dir).length, first.added.length);
  assert.strictEqual(store.readRaw(dir).length, first.added.length, 'nothing was re-appended');
});

test('sync appends only the NEW episodes when a day grows', () => {
  const dir = tmpDir();
  store.sync(dir, { tradesByDay: { '2026-09-03': [T({ pnl: 10 })] }, days: [], rules: {} });
  const res = store.sync(dir, {
    tradesByDay: { '2026-09-03': [T({ pnl: 10 }), T({ pnl: -500, flags: ['oversize'] })] },
    days: [], rules: {},
  });
  assert.strictEqual(res.added.length, 1);
  assert.strictEqual(res.added[0].kind, 'oversize');
  assert.strictEqual(store.readLedger(dir).length, 2);
});

test('a repaired trade row re-appends a correction, and the reader folds to it', () => {
  // day_trades rows do get repaired (broker reconciliation,
  // repair-split-exit-rows.js). The same episode id then carries different
  // numbers, and the LATER version has to win.
  const dir = tmpDir();
  store.sync(dir, { tradesByDay: { '2026-09-03': [T({ pnl: -100, flags: ['oversize'] })] }, days: [], rules: {} });
  const fixed = store.sync(dir, { tradesByDay: { '2026-09-03': [T({ pnl: -1718, flags: ['oversize'] })] }, days: [], rules: {} });

  assert.strictEqual(fixed.added.length, 1, 'the correction is appended');
  assert.strictEqual(store.readRaw(dir).length, 2, 'both versions stay on the append-only file');
  const led = store.readLedger(dir);
  assert.strictEqual(led.length, 1, 'the reader sees one episode');
  assert.strictEqual(led[0].cost, -1718, 'and it is the corrected one');
});

test('a torn final line costs one episode, not the ledger', () => {
  const dir = tmpDir();
  store.sync(dir, {
    tradesByDay: { '2026-09-03': [T({ pnl: -10, flags: ['oversize'] }), T({ pnl: 20 })] },
    days: [], rules: {},
  });
  fs.appendFileSync(store.ledgerPath(dir), '{"id":"torn","kind":"over', 'utf8');
  assert.strictEqual(store.readLedger(dir).length, 2);
});

test('the ledger reads back in chronological order across days', () => {
  const dir = tmpDir();
  store.sync(dir, {
    tradesByDay: {
      '2026-09-02': [T({ pnl: -10, flags: ['revenge'] })],
      '2026-09-01': [T({ pnl: 10 })],
      '2026-09-03': [T({ pnl: -20, flags: ['oversize'] })],
    },
    days: [], rules: {},
  });
  assert.deepStrictEqual(store.readLedger(dir).map(e => e.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('episodesForDay scopes to one trading day', () => {
  const dir = tmpDir();
  store.sync(dir, {
    tradesByDay: { '2026-09-02': [T({ pnl: -10, flags: ['revenge'] })], '2026-09-03': [T({ pnl: -20, flags: ['oversize'] })] },
    days: [], rules: {},
  });
  const day = store.episodesForDay(dir, '2026-09-03');
  assert.strictEqual(day.length, 1);
  assert.strictEqual(day[0].kind, 'oversize');
  assert.deepStrictEqual(store.episodesForDay(dir, '2026-01-01'), []);
});

test('reads on a ledger that does not exist yet return empty, not an error', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(store.readLedger(dir), []);
  assert.deepStrictEqual(store.readRaw(dir), []);
  assert.deepStrictEqual(store.episodesForDay(dir, '2026-09-03'), []);
  assert.strictEqual(store.stats(dir).episodes, 0);
});

test('sync never throws — a broken ledger path is reported, not raised', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, store.DIR_NAME), 'not a directory', 'utf8');
  const res = store.sync(dir, { tradesByDay: { '2026-09-03': [T({ pnl: -10, flags: ['oversize'] })] }, days: [], rules: {} });
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
});

test('stats reports the span and the revision count separately', () => {
  const dir = tmpDir();
  store.sync(dir, { tradesByDay: { '2026-09-01': [T({ pnl: -10, flags: ['oversize'] })] }, days: [], rules: {} });
  store.sync(dir, { tradesByDay: { '2026-09-01': [T({ pnl: -99, flags: ['oversize'] })] }, days: [], rules: {} });
  const s = store.stats(dir);
  assert.strictEqual(s.episodes, 1);   // one thing happened
  assert.strictEqual(s.revisions, 2);  // recorded twice, the second a correction
  assert.strictEqual(s.firstDay, '2026-09-01');
  assert.ok(s.bytes > 0);
});

test('recurrence over a synced ledger matches recurrence over the pure build', () => {
  // The store must not change the answer — it only persists it.
  const dir = tmpDir();
  const sources = {
    tradesByDay: {
      '2026-09-01': [T({ pnl: -100, flags: ['oversize'] }), T({ pnl: 200, flags: ['oversize'] })],
      '2026-09-02': [T({ pnl: -300, flags: ['oversize'] })],
    },
    days: [], rules: {},
  };
  store.sync(dir, sources);
  const fromDisk = pm.recurrence(store.readLedger(dir), 'oversize');
  const fromPure = pm.recurrence(pm.buildEpisodes(sources), 'oversize');
  assert.strictEqual(fromDisk.count, fromPure.count);
  assert.strictEqual(fromDisk.totalCost, fromPure.totalCost);
  assert.strictEqual(fromDisk.trend, fromPure.trend);
});
