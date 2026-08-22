'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChartBarCache, normalizeTf, ttlMsForTf, staggerOffsetMs } = require('../chart-bar-cache.js');

const bar = (t) => ({ time: t, open: 1, high: 2, low: 0, close: 1.5 });
const bars = (n) => Array.from({ length: n }, (_, i) => bar(i));

test('normalizeTf maps the codes the codebase uses', () => {
  assert.equal(normalizeTf('60'), '60');
  assert.equal(normalizeTf('1h'), '60');
  assert.equal(normalizeTf('1H'), '60');
  assert.equal(normalizeTf('240'), '240');
  assert.equal(normalizeTf('4H'), '240');
  assert.equal(normalizeTf('D'), 'D');
  assert.equal(normalizeTf('1D'), 'D');
  assert.equal(normalizeTf('W'), 'W');
  assert.equal(normalizeTf(null), '?');
});

test('ttlMsForTf is one third of bar duration, floored, unknown → default', () => {
  assert.equal(ttlMsForTf('30'), 10 * 60 * 1000);
  assert.equal(ttlMsForTf('60'), 20 * 60 * 1000);
  assert.equal(ttlMsForTf('15'), 5 * 60 * 1000);
  assert.equal(ttlMsForTf('1'), 20 * 1000);
  assert.equal(ttlMsForTf('weird-tf'), 5 * 60 * 1000);
});

test('cache serves a smaller count from a bigger fetch', () => {
  const c = new ChartBarCache();
  c.set('MNQ1!', '30', 6, bars(6));
  const got = c.get('MNQ1!', '30', 5);
  assert.ok(got);
  assert.equal(got.length, 5);
  assert.equal(got[0].time, 1);
  assert.equal(c.stats.hits, 1);
});

test('a request bigger than the cached fetch misses', () => {
  const c = new ChartBarCache();
  c.set('MNQ1!', '30', 5, bars(5));
  assert.equal(c.get('MNQ1!', '30', 6), null);
  assert.equal(c.stats.misses, 1);
});

test('entry expires after its TTL', () => {
  let now = 1000000;
  const c = new ChartBarCache({ now: () => now });
  c.set('MNQ1!', '15', 5, bars(5));
  assert.ok(c.get('MNQ1!', '15', 5));
  now += ttlMsForTf('15') + 1;
  assert.equal(c.get('MNQ1!', '15', 5), null);
  assert.equal(c.size(), 0);
});

test('different symbols or timeframes never share an entry', () => {
  const c = new ChartBarCache();
  c.set('MNQ1!', '30', 1, bars(1));
  c.set('MGC1!', '30', 1, bars(1));
  c.set('MNQ1!', '15', 1, bars(1));
  assert.equal(c.size(), 3);
  assert.ok(c.get('MNQ1!', '30', 1));
  assert.ok(c.get('MGC1!', '30', 1));
  assert.ok(c.get('MNQ1!', '15', 1));
});

test('a fresh bigger entry is not overwritten by a smaller one', () => {
  const c = new ChartBarCache();
  c.set('MNQ1!', '30', 6, bars(6));
  assert.equal(c.set('MNQ1!', '30', 5, bars(5)), false);
  assert.ok(c.get('MNQ1!', '30', 6));
  assert.equal(c.stats.sets, 1);
});

test('empty bars are never cached', () => {
  const c = new ChartBarCache();
  assert.equal(c.set('MNQ1!', '30', 5, []), false);
  assert.equal(c.get('MNQ1!', '30', 5), null);
});

test('noslice returns the raw cached value (label-text use)', () => {
  const c = new ChartBarCache();
  c.set('MNQ1!', '30', 5, 'bullish engulfing label text');
  assert.equal(c.get('MNQ1!', '30', 5, { noslice: true }), 'bullish engulfing label text');
  assert.equal(c.get('MNQ1!', '30', 5), 'bullish engulfing label text'); // non-array passes through
});

test('staggerOffsetMs offsets each watcher by a few seconds', () => {
  assert.equal(staggerOffsetMs(0), 0);
  assert.equal(staggerOffsetMs(1), 4000);
  assert.equal(staggerOffsetMs(3), 12000);
  assert.equal(staggerOffsetMs(-1), 0);
});
