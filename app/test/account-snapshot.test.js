const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const snap = require('../account-snapshot.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acct-snap-'));
}
function writeSlot(dataDir, slotId, files) {
  const dir = path.join(dataDir, 'accounts', slotId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  return dir;
}

// ── The policy ─────────────────────────────────────────────────────────────

test('emptying a full store is destructive', () => {
  const v = snap.isDestructiveSave({ '2026-08-17': [1, 2], '2026-08-18': [3] }, {});
  assert.strictEqual(v.destructive, true);
  assert.strictEqual(v.reason, 'emptied');
  assert.strictEqual(v.before, 2);
  assert.strictEqual(v.after, 0);
});

test('shrinking a store is destructive', () => {
  const v = snap.isDestructiveSave({ a: 1, b: 2, c: 3 }, { a: 1 });
  assert.strictEqual(v.destructive, true);
  assert.strictEqual(v.reason, 'shrank');
});

// This is the case that decides whether the feature is usable at all: dataSave
// runs on every logged trade, and a guard that fires there writes thousands of
// snapshots and buries the handful that matter.
test('a NORMAL growing write is not destructive — this runs on every trade', () => {
  const prev = { '2026-08-17': [1, 2, 3] };
  const next = { '2026-08-17': [1, 2, 3], '2026-08-18': [4] };
  assert.strictEqual(snap.isDestructiveSave(prev, next).destructive, false);
});

test('an unchanged write is not destructive', () => {
  const same = { a: [1], b: [2] };
  assert.strictEqual(snap.isDestructiveSave(same, { ...same }).destructive, false);
});

test('appending to an array store is not destructive; truncating it is', () => {
  assert.strictEqual(snap.isDestructiveSave([1, 2], [1, 2, 3]).destructive, false);
  assert.strictEqual(snap.isDestructiveSave([1, 2, 3], [1]).destructive, true);
  assert.strictEqual(snap.isDestructiveSave([1, 2, 3], []).destructive, true);
});

test('nothing to lose means no snapshot — a fresh slot must not accumulate them', () => {
  assert.strictEqual(snap.isDestructiveSave(null, {}).destructive, false);
  assert.strictEqual(snap.isDestructiveSave({}, {}).destructive, false);
  assert.strictEqual(snap.isDestructiveSave([], [1]).destructive, false);
});

test('uncountable payloads fail toward NOT snapshotting', () => {
  assert.strictEqual(snap.isDestructiveSave('a string', 'another').destructive, false);
  assert.strictEqual(snap.isDestructiveSave(42, 0).destructive, false);
});

test('countEntries handles the store shapes this repo actually uses', () => {
  assert.strictEqual(snap.countEntries({ '2026-08-17': [], '2026-08-18': [] }), 2); // day-keyed
  assert.strictEqual(snap.countEntries([{ date: 'x' }]), 1);                        // gr_history
  assert.strictEqual(snap.countEntries(null), 0);
  assert.strictEqual(snap.countEntries('scalar'), null);
});

// ── Naming and retention ───────────────────────────────────────────────────

test('snapshot dir names are sortable and Windows-legal', () => {
  const n = snap.snapshotDirName(new Date('2026-09-04T18:56:03.123Z'), 'wipe');
  assert.match(n, /^2026-09-04_18-56-03__wipe$/);
  assert.ok(!n.includes(':'), 'a colon makes the path invalid on Windows');
});

test('a reason with path characters cannot escape the snapshot directory', () => {
  const n = snap.snapshotDirName(new Date('2026-09-04T00:00:00Z'), '../../etc/passwd');
  assert.ok(!n.includes('/') && !n.includes('\\') && !n.includes('..'), n);
});

test('pruning keeps the newest N and never returns everything', () => {
  const dirs = ['2026-09-01_a__x', '2026-09-02_a__x', '2026-09-03_a__x', '2026-09-04_a__x'];
  assert.deepStrictEqual(snap.prunePlan(dirs, 2), ['2026-09-01_a__x', '2026-09-02_a__x']);
  assert.deepStrictEqual(snap.prunePlan(dirs, 10), []);
  assert.deepStrictEqual(snap.prunePlan([], 5), []);
});

// The whole point of this module is that it never leaves a slot with zero
// copies, so a bad `keep` must not be able to ask for that.
test('a nonsense keep value falls back to the default rather than deleting all', () => {
  const dirs = ['a', 'b', 'c'];
  assert.deepStrictEqual(snap.prunePlan(dirs, 0), []);
  assert.deepStrictEqual(snap.prunePlan(dirs, -5), []);
  assert.deepStrictEqual(snap.prunePlan(dirs, NaN), []);
});

// ── Filesystem behaviour ───────────────────────────────────────────────────

test('REGRESSION 2026-09-04: a wipe is survivable — snapshot lives OUTSIDE the slot folder', () => {
  const root = tmpDir();
  const slotDir = writeSlot(root, 's1', {
    'day_trades.json': { '2026-08-17': [{ pnl: 18.6 }], '2026-08-28': [{ pnl: -1436.2 }] },
    'gr_history.json': [{ date: '2026-08-17' }],
    'balance_ledger.json': { '2026-08-17': { net: -113.1 } },
    'day_trades.json.bak-protocol-123': 'the old safety net, which lived inside the blast radius',
  });

  const res = snap.snapshotSlot({ dataDir: root, slotId: 's1', reason: 'wipe' });
  assert.strictEqual(res.ok, true);
  assert.ok(res.files.includes('day_trades.json'));

  // Reproduce dataWipeAccount() exactly.
  fs.rmSync(slotDir, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(slotDir), false, 'the slot folder should be gone');

  // The snapshot must have survived it.
  const saved = JSON.parse(fs.readFileSync(path.join(res.dir, 'day_trades.json'), 'utf8'));
  assert.strictEqual(Object.keys(saved).length, 2);
  assert.strictEqual(saved['2026-08-28'][0].pnl, -1436.2);
});

test('only top-level .json is copied — screenshots would make this too expensive to keep on', () => {
  const root = tmpDir();
  writeSlot(root, 's2', { 'day_trades.json': { a: [1] }, 'notes.txt': 'x', 'day_trades.json.bak-1': 'y' });
  fs.mkdirSync(path.join(root, 'accounts', 's2', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 's2', 'screenshots', 'big.png'), 'PNGDATA');

  const res = snap.snapshotSlot({ dataDir: root, slotId: 's2', reason: 'reset' });
  assert.deepStrictEqual(res.files, ['day_trades.json']);
  assert.strictEqual(fs.existsSync(path.join(res.dir, 'screenshots')), false);
});

test('a manifest records why the snapshot was taken', () => {
  const root = tmpDir();
  writeSlot(root, 's1', { 'day_trades.json': { a: [1] } });
  const res = snap.snapshotSlot({
    dataDir: root, slotId: 's1', reason: 'breach', detail: { key: 'day_trades__s1' },
  });
  const m = JSON.parse(fs.readFileSync(path.join(res.dir, '_manifest.json'), 'utf8'));
  assert.strictEqual(m.slotId, 's1');
  assert.strictEqual(m.reason, 'breach');
  assert.strictEqual(m.detail.key, 'day_trades__s1');
  assert.ok(m.files.includes('day_trades.json'));
});

test('snapshotIfDestructive fires on a reset and stays quiet on an append', () => {
  const root = tmpDir();
  writeSlot(root, 's1', { 'day_trades.json': { '2026-08-17': [1], '2026-08-18': [2] } });
  const fp = path.join(root, 'accounts', 's1', 'day_trades.json');

  const quiet = snap.snapshotIfDestructive({
    dataDir: root, slotId: 's1', filePath: fp,
    next: { '2026-08-17': [1], '2026-08-18': [2], '2026-08-19': [3] },
  });
  assert.strictEqual(quiet.ok, false);
  assert.strictEqual(quiet.skipped, 'grew or unchanged');

  const fired = snap.snapshotIfDestructive({
    dataDir: root, slotId: 's1', filePath: fp, next: {}, reason: 'reset',
  });
  assert.strictEqual(fired.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(fired.dir, 'day_trades.json'), 'utf8'));
  assert.strictEqual(Object.keys(saved).length, 2, 'the pre-reset content must be preserved');
});

// A backup that turns "start fresh" into a crash on a live account is worse
// than the loss it prevents. Every entry point has to be inert on bad input.
test('never throws, whatever it is handed', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(snap.snapshotSlot({}).ok, false);
    assert.strictEqual(snap.snapshotSlot({ dataDir: '/nope', slotId: 's1' }).ok, false);
    assert.strictEqual(snap.snapshotSlot({ dataDir: '/nope', slotId: '../etc' }).skipped, 'bad-slot-id');
    assert.strictEqual(snap.snapshotIfDestructive({}).ok, false);
    assert.strictEqual(snap.snapshotIfDestructive({ filePath: '/nope/x.json' }).skipped, 'no-existing-file');
    snap.pruneSnapshots('/nope', 's1');
  });
});

test('a corrupt existing file is left alone rather than guessed at', () => {
  const root = tmpDir();
  writeSlot(root, 's1', { 'day_trades.json': '{ not json' });
  const r = snap.snapshotIfDestructive({
    dataDir: root, slotId: 's1',
    filePath: path.join(root, 'accounts', 's1', 'day_trades.json'), next: {},
  });
  assert.strictEqual(r.skipped, 'unreadable-prior');
});

test('retention prunes oldest snapshots but keeps the newest', () => {
  const root = tmpDir();
  writeSlot(root, 's1', { 'day_trades.json': { a: [1] } });
  for (let i = 1; i <= 5; i++) {
    snap.snapshotSlot({
      dataDir: root, slotId: 's1', reason: 'r' + i, keep: 3,
      now: new Date(Date.UTC(2026, 8, i, 12, 0, 0)),
    });
  }
  const kept = fs.readdirSync(path.join(root, '_snapshots', 's1')).sort();
  assert.strictEqual(kept.length, 3);
  assert.ok(kept[0].startsWith('2026-09-03'), 'oldest two should be gone, got ' + kept.join(','));
  assert.ok(kept[2].startsWith('2026-09-05'));
});
