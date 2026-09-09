'use strict';
// ── I1.1 adapter unit tests — pure logic, no CLI spawn ─────────────────────
const test = require('node:test');
const assert = require('node:assert');
const nse = require('../india-desk/nse');
const marketCli = require('../market-cli');

const { coldState, coldBucket, toNum } = nse._internals;

test('empty at exit 0 maps to cold, never to an empty ready', () => {
  assert.equal(coldState({ ok: true, empty: true, data: null }), 'cold');
  assert.equal(coldState({ ok: true, empty: true, data: [] }), 'cold');
  assert.equal(coldState({ ok: true, empty: false, data: [{ a: 1 }] }), 'ready');
  assert.equal(coldState({ ok: false, empty: true, data: null }), 'error');
});

test('coldBucket carries rows only when ready, and [] when cold', () => {
  const cold = coldBucket({ ok: true, empty: true, data: null });
  assert.deepEqual(cold, { state: 'cold', rows: [], error: null });

  const ready = coldBucket({ ok: true, empty: false, data: [{ symbol: 'X' }] });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.rows.length, 1);

  const err = coldBucket({ ok: false, empty: true, data: null, error: 'boom' });
  assert.deepEqual(err, { state: 'error', rows: [], error: 'boom' });
});

test('getColdSignals maps a stubbed empty run() to cold for all three', async () => {
  const orig = marketCli.run;
  marketCli.run = async () => ({ ok: true, empty: true, data: null });
  try {
    const r = await nse.getColdSignals();
    assert.equal(r.ok, true);
    assert.equal(r.data.deliverySpike.state, 'cold');
    assert.equal(r.data.deliveryDivergence.state, 'cold');
    assert.equal(r.data.sectorBreadth.state, 'cold');
    assert.deepEqual(r.data.deliverySpike.rows, []);
  } finally {
    marketCli.run = orig;
  }
});

test('toNum is strict — never coerces null/empty to zero', () => {
  assert.equal(toNum(23897.7), 23897.7);
  assert.equal(toNum('94.53'), 94.53);
  assert.equal(toNum(null), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum(''), null);
  assert.equal(toNum('abc'), null);
});

test('isNseOpen brackets the 09:15–15:30 IST session and skips weekends', () => {
  // 2026-09-07 is a Monday. 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC.
  const open = Date.parse('2026-09-07T05:00:00Z');   // 10:30 IST
  const before = Date.parse('2026-09-07T03:30:00Z'); // 09:00 IST
  const after = Date.parse('2026-09-07T10:30:00Z');  // 16:00 IST
  const sat = Date.parse('2026-09-12T05:00:00Z');    // Saturday 10:30 IST
  assert.equal(nse.isNseOpen(open), true);
  assert.equal(nse.isNseOpen(before), false);
  assert.equal(nse.isNseOpen(after), false);
  assert.equal(nse.isNseOpen(sat), false);
});
