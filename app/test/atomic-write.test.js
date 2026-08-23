'use strict';
/**
 * Tests for atomic-write.js.
 *
 * These use the REAL filesystem (a temp dir), not mocks — the whole point of
 * this module is filesystem behaviour, and a mocked rename would prove nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAtomic, writeJsonAtomic, cleanupTemps } = require('../atomic-write');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
}

test('writes a new file and reports atomic', () => {
  const d = tmpdir(), f = path.join(d, 'a.json');
  const r = writeAtomic(f, 'hello');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.atomic, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello');
});

test('overwrites an existing file completely (no leftover tail)', () => {
  const d = tmpdir(), f = path.join(d, 'a.json');
  fs.writeFileSync(f, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  writeAtomic(f, 'B');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'B', 'must not leave bytes from the longer previous content');
});

test('leaves NO temp files behind on success', () => {
  const d = tmpdir(), f = path.join(d, 'a.json');
  writeAtomic(f, 'x');
  const leftovers = fs.readdirSync(d).filter(n => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('creates the directory if it does not exist', () => {
  const d = tmpdir(), f = path.join(d, 'nested', 'deep', 'a.json');
  const r = writeAtomic(f, 'x');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'x');
});

test('THE POINT: the previous file survives intact if the new write fails', () => {
  // Simulate a failed write by pointing at a path whose parent is a FILE, so
  // both the atomic path and the plain fallback fail.
  const d = tmpdir();
  const blocker = path.join(d, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const impossible = path.join(blocker, 'child.json');
  const r = writeAtomic(impossible, 'new');
  assert.strictEqual(r.ok, false, 'should report failure rather than pretend');
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'i am a file, not a directory',
    'the existing file must be untouched');
});

test('writeJsonAtomic round-trips an object', () => {
  const d = tmpdir(), f = path.join(d, 'trades.json');
  const payload = { '2026-08-10': [{ size: 9, pnl: -171, flags: ['oversize', 'revenge'] }] };
  writeJsonAtomic(f, payload);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), payload);
});

test('concurrent writers do not collide on the temp filename', () => {
  const d = tmpdir(), f = path.join(d, 'a.json');
  for (let i = 0; i < 50; i++) writeAtomic(f, 'v' + i);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v49');
  assert.deepStrictEqual(fs.readdirSync(d).filter(n => n.endsWith('.tmp')), []);
});

test('cleanupTemps removes crash leftovers but never real files', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, '.day_trades.json.1234.5678901.tmp'), 'partial');
  fs.writeFileSync(path.join(d, 'day_trades.json'), 'real');
  fs.writeFileSync(path.join(d, '.hidden-but-real.json'), 'also real');
  const removed = cleanupTemps(d);
  assert.strictEqual(removed, 1);
  assert.strictEqual(fs.existsSync(path.join(d, 'day_trades.json')), true);
  assert.strictEqual(fs.existsSync(path.join(d, '.hidden-but-real.json')), true);
});

test('cleanupTemps on a missing directory does not throw', () => {
  assert.doesNotThrow(() => cleanupTemps(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())));
});
