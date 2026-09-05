'use strict';
// Tests for chat-archive.js — the append-only chat record (2026-09-03).
//
// The invariant worth pinning above all others: NOTHING IS EVER TRIMMED OR
// REWRITTEN. The store this replaces (DATA/chat_transcript.json) lost every
// message past the newest 40 because a renderer-side context cap leaked into
// the disk mirror. If a future change reintroduces a cap here, the
// "never drops old rows" test is the one that should fail.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ca = require('../chat-archive');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-test-'));
}

const IST_OFF = 330 * 60 * 1000;
// Build an epoch ms for a given IST wall-clock time.
function istMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - IST_OFF;
}

test('tradingDayStamp uses the 03:45 IST rollover, not the calendar date', () => {
  // 00:40 IST on the 4th belongs to the session that started on the 3rd.
  assert.strictEqual(ca.tradingDayStamp(istMs(2026, 9, 4, 0, 40)), '2026-09-03');
  // 03:44 IST still the previous day; 03:45 flips.
  assert.strictEqual(ca.tradingDayStamp(istMs(2026, 9, 4, 3, 44)), '2026-09-03');
  assert.strictEqual(ca.tradingDayStamp(istMs(2026, 9, 4, 3, 45)), '2026-09-04');
  assert.strictEqual(ca.tradingDayStamp(istMs(2026, 9, 4, 19, 30)), '2026-09-04');
});

test('resolveTs trusts a plausible client clock and rejects a broken one', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  // Captured 90s ago while the socket was down — keep the real time.
  assert.strictEqual(ca.resolveTs(now - 90000, now), now - 90000);
  // Machine clock stuck in 1970 / jumped to 2049 — fall back to server-now,
  // so a wrong clock cannot scatter today's conversation across the archive.
  assert.strictEqual(ca.resolveTs(0, now), now);
  assert.strictEqual(ca.resolveTs(now + 5 * 24 * 3600 * 1000, now), now);
  assert.strictEqual(ca.resolveTs('not a number', now), now);
  assert.strictEqual(ca.resolveTs(undefined, now), now);
});

test('buildRecord stamps server-owned fields and never lets the client assert them', () => {
  const rec = ca.buildRecord(
    { id: 'x1', seq: 2, role: 'user', text: 'hi', slot: 'HACKED', tradingDay: 'HACKED' },
    { nowMs: istMs(2026, 9, 3, 19, 39), slot: 's2', mode: 'eval' }
  );
  assert.strictEqual(rec.slot, 's2');
  assert.strictEqual(rec.mode, 'eval');
  assert.strictEqual(rec.tradingDay, '2026-09-03');
  assert.strictEqual(rec.id, 'x1');
  assert.strictEqual(rec.seq, 2);
  assert.strictEqual(rec.v, ca.SCHEMA_VERSION);
});

test('append then readDay round-trips in chronological order', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 10, 0);
  ca.appendRecords(dir, [
    { id: 'a', seq: 0, role: 'user', text: 'first', clientTs: base },
    { id: 'b', seq: 0, role: 'assistant', text: 'second', clientTs: base + 1000 }
  ], { nowMs: base, slot: 's2', mode: 'eval' });
  ca.appendRecords(dir, [
    { id: 'c', seq: 0, role: 'system', text: 'third', clientTs: base + 2000 }
  ], { nowMs: base + 2000, slot: 's2', mode: 'eval' });

  const day = ca.readDay(dir, '2026-09-03');
  assert.deepStrictEqual(day.map(r => r.text), ['first', 'second', 'third']);
  assert.deepStrictEqual(day.map(r => r.role), ['user', 'assistant', 'system']);
});

test('revisions of one row fold to the highest seq, and every revision stays on disk', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 11, 0);
  const ctx = { nowMs: base, slot: 's2', mode: 'eval' };
  // An assistant bubble as it streams: partial, then final.
  ca.appendRecords(dir, [{ id: 'm1', seq: 0, role: 'assistant', text: 'VERD', clientTs: base }], ctx);
  ca.appendRecords(dir, [{ id: 'm1', seq: 1, role: 'assistant', text: 'VERDICT: NO-GO', clientTs: base }], ctx);

  // Reader sees it once, finished.
  const folded = ca.readDay(dir, '2026-09-03');
  assert.strictEqual(folded.length, 1);
  assert.strictEqual(folded[0].text, 'VERDICT: NO-GO');

  // The append-only file still holds both — nothing was rewritten.
  const raw = ca.readDayRaw(dir, '2026-09-03');
  assert.strictEqual(raw.length, 2);
  assert.deepStrictEqual(raw.map(r => r.text), ['VERD', 'VERDICT: NO-GO']);
});

test('a torn final line costs one row, not the day', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 12, 0);
  ca.appendRecords(dir, [
    { id: 'a', seq: 0, role: 'user', text: 'kept', clientTs: base },
    { id: 'b', seq: 0, role: 'user', text: 'also kept', clientTs: base + 1 }
  ], { nowMs: base });
  // Simulate a crash mid-append: half a JSON line at the tail.
  fs.appendFileSync(ca.dayPath(dir, '2026-09-03'), '{"id":"c","text":"tor', 'utf8');

  const rows = ca.readDay(dir, '2026-09-03');
  assert.deepStrictEqual(rows.map(r => r.text), ['kept', 'also kept']);
});

test('a batch spanning the 03:45 rollover splits across both day files', () => {
  const dir = tmpDir();
  const late = istMs(2026, 9, 4, 3, 30);   // still 09-03
  const after = istMs(2026, 9, 4, 4, 10);  // now 09-04
  const res = ca.appendRecords(dir, [
    { id: 'late', seq: 0, role: 'user', text: 'before rollover', clientTs: late },
    { id: 'after', seq: 0, role: 'user', text: 'after rollover', clientTs: after }
  ], { nowMs: after });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.written, 2);
  assert.deepStrictEqual(ca.listDays(dir), ['2026-09-03', '2026-09-04']);
  assert.strictEqual(ca.readDay(dir, '2026-09-03')[0].text, 'before rollover');
  assert.strictEqual(ca.readDay(dir, '2026-09-04')[0].text, 'after rollover');
});

test('readRecent NEVER drops old rows from disk — the cap is on the read, not the store', () => {
  // This is the regression that motivated the whole file. chat_transcript.json
  // persisted state.messages.slice(-40), so message 41 was deleted from disk.
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 9, 0);
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ id: 'r' + i, seq: 0, role: 'user', text: 'msg ' + i, clientTs: base + i * 1000 });
  }
  ca.appendRecords(dir, rows, { nowMs: base });

  // A bounded read returns the newest 10, in reading order.
  const recent = ca.readRecent(dir, { limit: 10 });
  assert.strictEqual(recent.length, 10);
  assert.strictEqual(recent[0].text, 'msg 110');
  assert.strictEqual(recent[9].text, 'msg 119');

  // ...but the oldest message is still on disk, in full.
  const all = ca.readDay(dir, '2026-09-03');
  assert.strictEqual(all.length, 120);
  assert.strictEqual(all[0].text, 'msg 0');
});

test('readRecent walks back across days and stays chronological', () => {
  const dir = tmpDir();
  ca.appendRecords(dir, [
    { id: 'd1a', seq: 0, role: 'user', text: 'day1 first', clientTs: istMs(2026, 9, 1, 10, 0) },
    { id: 'd1b', seq: 0, role: 'user', text: 'day1 last', clientTs: istMs(2026, 9, 1, 11, 0) }
  ], { nowMs: istMs(2026, 9, 1, 11, 0) });
  ca.appendRecords(dir, [
    { id: 'd2a', seq: 0, role: 'user', text: 'day2 only', clientTs: istMs(2026, 9, 2, 10, 0) }
  ], { nowMs: istMs(2026, 9, 2, 10, 0) });

  const recent = ca.readRecent(dir, { limit: 2 });
  assert.deepStrictEqual(recent.map(r => r.text), ['day1 last', 'day2 only']);
});

test('readRecent can filter to conversation roles only', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 14, 0);
  ca.appendRecords(dir, [
    { id: '1', seq: 0, role: 'user', text: 'q', clientTs: base },
    { id: '2', seq: 0, role: 'system', text: 'watcher fired', clientTs: base + 1 },
    { id: '3', seq: 0, role: 'assistant', text: 'a', clientTs: base + 2 }
  ], { nowMs: base });

  const convo = ca.readRecent(dir, { limit: 50, roles: ['user', 'assistant'] });
  assert.deepStrictEqual(convo.map(r => r.text), ['q', 'a']);
  // The system row is filtered from THIS read, not missing from the archive.
  assert.strictEqual(ca.readDay(dir, '2026-09-03').length, 3);
});

test('search is case-insensitive, AND across terms, newest first', () => {
  const dir = tmpDir();
  ca.appendRecords(dir, [
    { id: 'a', seq: 0, role: 'assistant', text: 'VERDICT: NO-GO on MNQ', clientTs: istMs(2026, 9, 1, 10, 0) }
  ], { nowMs: istMs(2026, 9, 1, 10, 0) });
  ca.appendRecords(dir, [
    { id: 'b', seq: 0, role: 'assistant', text: 'verdict: go on MGC', clientTs: istMs(2026, 9, 2, 10, 0) }
  ], { nowMs: istMs(2026, 9, 2, 10, 0) });

  const hits = ca.search(dir, { query: 'verdict' });
  assert.deepStrictEqual(hits.map(r => r.tradingDay), ['2026-09-02', '2026-09-01']);

  // Every term must match, so this finds only the MNQ row.
  const both = ca.search(dir, { query: 'verdict mnq' });
  assert.strictEqual(both.length, 1);
  assert.strictEqual(both[0].id, 'a');

  assert.deepStrictEqual(ca.search(dir, { query: '   ' }), []);
});

test('search only reads back a folded revision, never a stale partial', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 15, 0);
  ca.appendRecords(dir, [{ id: 'm', seq: 0, role: 'assistant', text: 'GO on MNQ', clientTs: base }], { nowMs: base });
  ca.appendRecords(dir, [{ id: 'm', seq: 1, role: 'assistant', text: 'NO-GO on MNQ', clientTs: base }], { nowMs: base });

  const hits = ca.search(dir, { query: 'mnq' });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].text, 'NO-GO on MNQ');
});

test('empty rows are not recorded, and an oversize row is clipped not dropped', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 16, 0);
  const huge = 'x'.repeat(ca.MAX_TEXT + 5000);
  ca.appendRecords(dir, [
    { id: 'empty', seq: 0, role: 'system', text: '   ' && '', clientTs: base },
    { id: 'huge', seq: 0, role: 'user', text: huge, clientTs: base + 1 }
  ], { nowMs: base });

  const rows = ca.readDay(dir, '2026-09-03');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'huge');
  assert.ok(rows[0].text.length > ca.MAX_TEXT);
  assert.ok(rows[0].text.includes('truncated'));
});

test('appendRecords never throws and reports the failure instead', () => {
  // A path that cannot be a directory (a file sits where the dir must go).
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ca.DIR_NAME), 'not a directory', 'utf8');
  const res = ca.appendRecords(dir, [{ id: 'a', seq: 0, role: 'user', text: 'hi' }], { nowMs: Date.now() });
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
  assert.strictEqual(res.written, 0);
});

test('reads on an archive that does not exist yet return empty, not an error', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(ca.listDays(dir), []);
  assert.deepStrictEqual(ca.readDay(dir, '2026-09-03'), []);
  assert.deepStrictEqual(ca.readRecent(dir, { limit: 10 }), []);
  assert.deepStrictEqual(ca.search(dir, { query: 'anything' }), []);
  assert.deepStrictEqual(ca.stats(dir), { days: 0, firstDay: null, lastDay: null, rows: 0, bytes: 0 });
});

test('a malformed day key cannot escape the archive directory', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(ca.readDay(dir, '../../../etc/passwd'), []);
  assert.deepStrictEqual(ca.readDayRaw(dir, '2026-09'), []);
  assert.strictEqual(ca.isDayKey('2026-09-03'), true);
  assert.strictEqual(ca.isDayKey('2026-9-3'), false);
});

test('stats reports the span of the archive', () => {
  const dir = tmpDir();
  ca.appendRecords(dir, [{ id: 'a', seq: 0, role: 'user', text: 'x', clientTs: istMs(2026, 9, 1, 10, 0) }], { nowMs: istMs(2026, 9, 1, 10, 0) });
  ca.appendRecords(dir, [{ id: 'b', seq: 0, role: 'user', text: 'y', clientTs: istMs(2026, 9, 3, 10, 0) }], { nowMs: istMs(2026, 9, 3, 10, 0) });
  const s = ca.stats(dir);
  assert.strictEqual(s.days, 2);
  assert.strictEqual(s.firstDay, '2026-09-01');
  assert.strictEqual(s.lastDay, '2026-09-03');
  assert.strictEqual(s.rows, 2);
  assert.ok(s.bytes > 0);
});

test('formatForAgent labels roles in words and trims per row', () => {
  const dir = tmpDir();
  const base = istMs(2026, 9, 3, 17, 0);
  ca.appendRecords(dir, [
    { id: 'a', seq: 0, role: 'user', text: 'i fucked up', clientTs: base },
    { id: 'b', seq: 0, role: 'system', text: 'LIVE SIZE VIOLATION — 20 > 2 cap', clientTs: base + 1 }
  ], { nowMs: base });

  const txt = ca.formatForAgent(ca.readDay(dir, '2026-09-03'));
  assert.ok(txt.includes('ANOOP: i fucked up'));
  assert.ok(txt.includes('APP: LIVE SIZE VIOLATION'));
  assert.ok(txt.includes('[2026-09-03 '));

  const long = ca.formatForAgent([{ tradingDay: '2026-09-03', istTime: '17:00:00', role: 'assistant', text: 'z'.repeat(5000) }], { perRow: 100 });
  assert.ok(long.includes('[trimmed]'));
  assert.ok(long.length < 400);

  assert.ok(ca.formatForAgent([]).includes('No archived chat'));
});

test('formatForAgent surfaces a ticket\'s form fields — the size must survive recall', () => {
  // A trade ticket's numbers are <input> values, not text. Recalling the row
  // without them would say "there was a ticket" and lose the only detail that
  // matters: the size he was about to send.
  const txt = ca.formatForAgent([{
    tradingDay: '2026-09-03', istTime: '18:00:00', role: 'ticket',
    text: 'Trade ticket — LONG MNQ1!',
    meta: { fields: { 'tc-v12-size': '2', 'tc-v12-stop': '24310.25', 'tc-v12-target': '24380' } }
  }]);
  assert.ok(txt.includes('TRADE TICKET: Trade ticket — LONG MNQ1!'));
  assert.ok(txt.includes('size=2'));
  assert.ok(txt.includes('stop=24310.25'));
  assert.ok(txt.includes('target=24380'));
});

test('formatForAgent flags a seeded row so its timestamp is not read as real', () => {
  const txt = ca.formatForAgent([{
    tradingDay: '2026-09-03', istTime: '19:37:30', role: 'user', text: 'i fucked up',
    meta: { seeded: true, source: 'chat_transcript.json' }
  }]);
  assert.ok(txt.includes('seeded'));
  assert.ok(txt.includes('not the message time'));
});
