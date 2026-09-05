'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ba = require('../bar-archive');

test('normalizeBar converts legacy seconds to ms and passes ms through', () => {
  const sec = ba.normalizeBar({ time: 1720000000, open: 1, high: 2, low: 0.5, close: 1.5 });
  assert.equal(sec.t, 1720000000000);
  assert.equal(sec.h, 2);
  const ms = ba.normalizeBar({ t: 1720000000000, o: 1, h: 2, l: 0.5, c: 1.5 });
  assert.equal(ms.t, 1720000000000);
});

test('appendToArchiveFile dedupes by t, later wins, counts new only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-archive-'));
  const fp = path.join(dir, 'MNQ', '1', '2026-09-05.jsonl');
  const a = ba.appendToArchiveFile(fp, [
    { t: 1720000000000, o: 1, h: 2, l: 0.5, c: 1.5 },
    { t: 1720000001000, o: 1.5, h: 2.5, l: 1, c: 2 },
  ]);
  assert.equal(a, 2);
  const b = ba.appendToArchiveFile(fp, [
    { t: 1720000001000, o: 2, h: 3, l: 1, c: 2.5 },
    { t: 1720000002000, o: 2.5, h: 3.5, l: 2, c: 3 },
  ]);
  assert.equal(b, 1);
  const all = ba.readArchive(dir, 'MNQ', '1', null, null);
  assert.equal(all.length, 3);
  assert.equal(all[1].h, 3);
  assert.deepEqual(all.map((x) => x.t), [1720000000000, 1720000001000, 1720000002000]);
});

test('readArchive filters by range across two day files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-archive-'));
  ba.appendToArchiveFile(path.join(dir, 'MNQ', '1', '2026-09-04.jsonl'), [{ t: 1725400000000, o: 1, h: 2, l: 0.5, c: 1.5 }]);
  ba.appendToArchiveFile(path.join(dir, 'MNQ', '1', '2026-09-05.jsonl'), [{ t: 1725486400000, o: 2, h: 3, l: 1, c: 2.5 }]);
  const out = ba.readArchive(dir, 'MNQ', '1', 1725400000000, 1725486400000);
  assert.equal(out.length, 2);
});
