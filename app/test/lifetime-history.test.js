'use strict';
const test = require('node:test');
const assert = require('node:assert');
const LH = require('../lifetime-history');

// Shorthand builders — an archive stores its stores as JSON strings under the
// localStorage key names; a live slot hands them over already parsed. Both
// shapes have to work, because both exist on disk.
function archive(label, slot, archivedAt, days, opts) {
  return Object.assign({
    kind: 'archive', slotId: slot, label, archivedAt,
    ls: { copilot_gr_history: JSON.stringify(days || []) },
  }, opts || {});
}
function live(label, slot, days, opts) {
  return Object.assign({ kind: 'live', slot, label, gr_history: days || [] }, opts || {});
}
const day = (date, n, pnl, extra) => Object.assign({ date, n, pnl }, extra || {});

test('the spine is the trading day — one row per real day, never one per snapshot', () => {
  // The exact 2026-08-31 situation: the same 2 days present in live s1 AND in
  // three duplicate archives. Naive concatenation gives 8 rows and 4x the P&L.
  const rows = [day('2026-08-17', 3, -100), day('2026-08-18', 2, 50)];
  const out = LH.mergeLifetime([
    live('Tradify 01', 's1', rows),
    archive('Tradify 01 EVAL', 's1', '2026-08-29T06:36:49Z', rows),
    archive('Tradify 01 EVAL', 's1', '2026-08-29T06:37:08Z', rows),
    archive('Tradify 01 EVAL', 's1', '2026-08-29T09:15:13Z', rows),
  ]);
  assert.strictEqual(out.days.length, 2, 'duplicate snapshots must not multiply days');
  assert.strictEqual(out.stats.net, -50);
  assert.strictEqual(out.stats.trades, 5);
});

test('every source that claimed a day is retained as provenance', () => {
  const rows = [day('2026-08-17', 3, -100)];
  const out = LH.mergeLifetime([
    live('Tradify 01', 's1', rows),
    archive('Tradify 01 EVAL', 's1', '2026-08-29T06:36:49Z', rows),
  ]);
  assert.strictEqual(out.days[0].sources.length, 2, 'both claims recorded');
  assert.ok(out.days[0].sources.some(s => s.kind === 'live'));
  assert.ok(out.days[0].sources.some(s => s.kind === 'archive'));
});

test('a contested day keeps the richest copy and REPORTS the disagreement', () => {
  // Archive record 4 on 2026-08-29 was hollowed out after a reset. A
  // latest-wins merge would have shown the empty version and silently deleted
  // ten trades from the record.
  const out = LH.mergeLifetime([
    archive('A', 's1', '2026-08-29T06:00:00Z', [day('2026-08-17', 10, -300)]),
    archive('A', 's1', '2026-08-29T09:15:28Z', [day('2026-08-17', 0, 0)]),
  ]);
  assert.strictEqual(out.days.length, 1);
  assert.strictEqual(out.days[0].n, 10, 'richest copy wins, not the latest');
  assert.strictEqual(out.days[0].conflict, true);
  assert.strictEqual(out.conflicts.length, 1);
  assert.ok(out.conflicts[0].others.length >= 1, 'the losing version is recorded, not discarded');
});

test('identical duplicates are NOT reported as conflicts', () => {
  const rows = [day('2026-08-17', 3, -100)];
  const out = LH.mergeLifetime([
    archive('A', 's1', '2026-08-29T06:00:00Z', rows),
    archive('A', 's1', '2026-08-29T06:01:00Z', rows),
  ]);
  assert.strictEqual(out.days[0].conflict, false, 'same numbers is a duplicate, not a disagreement');
  assert.strictEqual(out.conflicts.length, 0);
});

test('a live slot outranks an equally-rich archived copy', () => {
  const out = LH.mergeLifetime([
    archive('A', 's1', '2026-08-29T09:00:00Z', [day('2026-08-17', 3, -100, { maxSize: 2 })]),
    live('A', 's1', [day('2026-08-17', 3, -111, { maxSize: 4 })]),
  ]);
  assert.strictEqual(out.days[0].pnl, -111, 'live is the current writer');
  assert.strictEqual(out.days[0].conflict, true, 'and the archive disagreeing is still surfaced');
});

test('separate accounts stay separate and produce a boundary', () => {
  const out = LH.mergeLifetime([
    archive('Account 1 EVAL', 's1', '2026-08-24T11:43:10Z', [day('2026-07-27', 4, 200)], { event: 'cleared' }),
    live('Tradify 02', 's2', [day('2026-08-31', 1, -61.4)]),
  ]);
  assert.strictEqual(out.accounts.length, 2);
  assert.strictEqual(out.boundaries.length, 1);
  const b = out.boundaries[0];
  assert.strictEqual(b.atDate, '2026-08-31');
  assert.strictEqual(b.afterDate, '2026-07-27');
  assert.strictEqual(b.fromLabel, 'Account 1 EVAL');
  assert.strictEqual(b.fromEvent, 'cleared');
  assert.strictEqual(b.toLabel, 'Tradify 02');
});

test('a fresh empty account still appears — it is a chapter, not an absence', () => {
  const out = LH.mergeLifetime([
    archive('Old', 's1', '2026-08-29T06:00:00Z', [day('2026-08-17', 3, -100)]),
    live('Tradify 02', 's2', []),
  ]);
  assert.strictEqual(out.accounts.length, 2, 'the new empty account is listed');
  const fresh = out.accounts.find(a => a.label === 'Tradify 02');
  assert.strictEqual(fresh.days, 0);
  assert.strictEqual(fresh.firstDate, null);
  assert.strictEqual(out.days.length, 1, 'but contributes no phantom day rows');
});

test('the day spine is chronological across account boundaries', () => {
  const out = LH.mergeLifetime([
    live('New', 's2', [day('2026-08-31', 1, -61)]),
    archive('Old', 's1', '2026-08-29T06:00:00Z', [day('2026-08-17', 3, -100), day('2026-08-28', 2, 40)]),
  ]);
  assert.deepStrictEqual(out.days.map(d => d.date), ['2026-08-17', '2026-08-28', '2026-08-31']);
});

test('the terminal event comes from the LATEST archive of that account', () => {
  const out = LH.mergeLifetime([
    archive('A', 's1', '2026-08-24T11:00:00Z', [day('2026-08-17', 1, 10)], { event: 'cleared' }),
    archive('A', 's1', '2026-08-29T09:00:00Z', [day('2026-08-17', 1, 10)], { event: 'breached' }),
  ]);
  assert.strictEqual(out.accounts[0].event, 'breached');
});

test('duplicate archive snapshots are counted, not silently tidied away', () => {
  const rows = [day('2026-08-17', 3, -100)];
  const out = LH.mergeLifetime([
    live('A', 's1', rows),
    archive('A', 's1', '2026-08-29T06:36:49Z', rows),
    archive('A', 's1', '2026-08-29T06:37:08Z', rows),
    archive('A', 's1', '2026-08-29T09:15:13Z', rows),
  ]);
  assert.ok(out.stats.duplicateArchives >= 2, 'a misfiring archive flow must stay visible');
});

test('identity basis is reported as derived when accountId is null (today\'s reality)', () => {
  const out = LH.mergeLifetime([live('A', 's1', [day('2026-08-17', 1, 10)])]);
  assert.strictEqual(out.stats.identityBasis, 'derived');
});

test('a real accountId is preferred over the slot+label heuristic', () => {
  const out = LH.mergeLifetime([
    live('Renamed Later', 's1', [day('2026-08-17', 1, 10)], { accountId: 'ACC-9' }),
    archive('Original Name', 's1', '2026-08-29T06:00:00Z', [day('2026-08-18', 1, 20)], { accountId: 'ACC-9' }),
  ]);
  assert.strictEqual(out.accounts.length, 1, 'same accountId is one account despite the rename');
  assert.strictEqual(out.stats.identityBasis, 'accountId');
});

test('junk dates and malformed stores never become rows', () => {
  const out = LH.mergeLifetime([
    live('A', 's1', [day('2026-08-17', 1, 10), { date: 'not-a-date', n: 9, pnl: 999 }, null, { n: 1 }]),
    { kind: 'archive', slotId: 's9', label: 'Broken', ls: { copilot_gr_history: '{{{not json' } },
  ]);
  assert.strictEqual(out.days.length, 1);
  assert.strictEqual(out.stats.net, 10);
});

test('no sources at all yields an honest empty record rather than a throw', () => {
  const out = LH.mergeLifetime([]);
  assert.deepStrictEqual(out.days, []);
  assert.deepStrictEqual(out.accounts, []);
  assert.deepStrictEqual(out.boundaries, []);
  assert.strictEqual(out.stats.net, 0);
  assert.strictEqual(out.stats.firstDate, null);
});

test('mergeTrades attributes each day\'s trades to the account that owns that day', () => {
  const rows1 = [day('2026-08-17', 2, -100)];
  const rows2 = [day('2026-08-31', 1, -61)];
  const sources = [
    live('Old', 's1', rows1, { day_trades: { '2026-08-17': [{ pnl: -60 }, { pnl: -40 }] } }),
    live('New', 's2', rows2, { day_trades: { '2026-08-31': [{ pnl: -61 }] } }),
  ];
  const merged = LH.mergeLifetime(sources);
  const trades = LH.mergeTrades(sources, merged.days);
  assert.strictEqual(trades['2026-08-17'].length, 2);
  assert.strictEqual(trades['2026-08-17'][0].__slot, 's1');
  assert.strictEqual(trades['2026-08-31'][0].__slot, 's2');
});

test('lifetime totals equal the sum of the deduped spine, not of the snapshots', () => {
  const rows = [day('2026-08-17', 2, -100), day('2026-08-18', 3, 250)];
  const out = LH.mergeLifetime([
    live('A', 's1', rows),
    archive('A', 's1', '2026-08-29T06:00:00Z', rows),
    archive('A', 's1', '2026-08-29T07:00:00Z', rows),
    live('B', 's2', [day('2026-08-31', 1, -61.4)]),
  ]);
  assert.strictEqual(out.stats.net, 88.6);
  assert.strictEqual(out.stats.trades, 6);
  assert.strictEqual(out.stats.tradedDays, 3);
});

test('the live name and the archive label of one account do not split into two', () => {
  // Real 2026-08-31 data: meta.json says "Tradify 01", the archive says
  // "Tradify 01 EVAL". Keyed raw, the breach event landed on a phantom 0-day
  // account while the real one still read "active".
  const out = LH.mergeLifetime([
    live('Tradify 01', 's1', [day('2026-08-17', 3, -100), day('2026-08-28', 2, -50)]),
    archive('Tradify 01 EVAL', 's1', '2026-08-29T09:15:28Z', [], { event: 'breached' }),
  ]);
  assert.strictEqual(out.accounts.length, 1, 'one real account, not two');
  assert.strictEqual(out.accounts[0].days, 2);
  assert.strictEqual(out.accounts[0].event, 'breached', 'the breach attaches to the account that has the days');
});

test('stage is not identity — an eval that converts to funded stays one account', () => {
  const out = LH.mergeLifetime([
    archive('Tradify 09 EVAL', 's3', '2026-08-01T00:00:00Z', [day('2026-07-01', 1, 10)], { event: 'cleared' }),
    live('Tradify 09 FUNDED', 's3', [day('2026-07-05', 1, 20)]),
  ]);
  assert.strictEqual(out.accounts.length, 1);
  assert.strictEqual(out.accounts[0].days, 2);
});

test('genuinely different accounts in the same slot still stay separate', () => {
  const out = LH.mergeLifetime([
    archive('Account 1 EVAL', 's1', '2026-08-24T11:43:10Z', [day('2026-07-27', 4, 200)], { event: 'cleared' }),
    live('Tradify 01', 's1', [day('2026-08-17', 3, -100)]),
  ]);
  assert.strictEqual(out.accounts.length, 2, 'different names are different accounts');
});

test('mergeLedger follows the same day-ownership rule as trades', () => {
  const sources = [
    live('Old', 's1', [day('2026-08-17', 2, -100)], { balance_ledger: { '2026-08-17': { net: -100 } } }),
    live('New', 's2', [day('2026-08-31', 1, -61)], { balance_ledger: { '2026-08-31': { net: -61 } } }),
  ];
  const merged = LH.mergeLifetime(sources);
  const led = LH.mergeLedger(sources, merged.days);
  assert.strictEqual(led['2026-08-17'].net, -100);
  assert.strictEqual(led['2026-08-31'].net, -61);
});

test('mergeChecks keeps TWO checklists completed on the same day', () => {
  // 2026-08-31: one pre-session check on the old account, another after
  // switching. Keying on date alone would delete the evidence he re-checked.
  const sources = [
    live('Old', 's1', [], { ck_history: [{ date: '2026-08-31', score: 7, completedAtMs: 111 }] }),
    live('New', 's2', [], { ck_history: [{ date: '2026-08-31', score: 9, completedAtMs: 222 }] }),
  ];
  const merged = LH.mergeLifetime(sources);
  const checks = LH.mergeChecks(sources, merged.days);
  assert.strictEqual(checks.length, 2);
  assert.deepStrictEqual(checks.map(c => c.score).sort(), [7, 9]);
});

test('mergeChecks drops exact duplicates carried in overlapping snapshots', () => {
  const row = { date: '2026-08-17', score: 8, completedAtMs: 555 };
  const sources = [
    live('A', 's1', [], { ck_history: [row] }),
    archive('A EVAL', 's1', '2026-08-29T06:00:00Z', [], { ls: { copilot_ck_history: JSON.stringify([row]) } }),
  ];
  const merged = LH.mergeLifetime(sources);
  assert.strictEqual(LH.mergeChecks(sources, merged.days).length, 1);
});

test('normalizeLabel strips stage words but keeps the account name', () => {
  assert.strictEqual(LH.normalizeLabel('Tradify 01 EVAL'), 'tradify 01');
  assert.strictEqual(LH.normalizeLabel('Tradify 01'), 'tradify 01');
  assert.strictEqual(LH.normalizeLabel('Account 1 EVAL'), 'account 1');
  assert.notStrictEqual(LH.normalizeLabel('Tradify 02'), LH.normalizeLabel('Tradify 01'));
});

test('accountEvent marks ONLY the day an account ended, never the whole account', () => {
  const out = LH.mergeLifetime([
    archive('Old', 's1', '2026-08-29T06:00:00Z',
      [day('2026-08-17', 3, -100), day('2026-08-28', 2, -50)], { event: 'breached' }),
  ]);
  const first = out.days.find(d => d.date === '2026-08-17');
  const last = out.days.find(d => d.date === '2026-08-28');
  assert.strictEqual(first.accountEvent, undefined, 'a mid-life day is not a breach day');
  assert.strictEqual(last.accountEvent, 'breached');
  assert.strictEqual(last.accountEventLabel, 'Old');
});

test('a cleared account marks its last day cleared, not breached', () => {
  const out = LH.mergeLifetime([
    archive('Won', 's1', '2026-08-24T11:00:00Z', [day('2026-07-31', 4, 584)], { event: 'cleared' }),
  ]);
  assert.strictEqual(out.days[0].accountEvent, 'cleared');
});

test('a still-active account marks no day at all', () => {
  const out = LH.mergeLifetime([live('Current', 's2', [day('2026-08-31', 1, -61)])]);
  assert.strictEqual(out.days[0].accountEvent, undefined);
});
