'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signalKey, describeSignal, shouldAnnounce, pruneSeen, REPEAT_WINDOW_MS } = require('../renderer/signal-alert.js');

const T = Date.UTC(2026, 7, 24, 11, 30, 20); // 17:00:20 IST — a real fire time from 2026-08-24

// ── the heartbeat trap ─────────────────────────────────────────────────────
test('a poll heartbeat with found:false never announces', () => {
  // engulf-check/fvg-check/sfp-check fire every 30-60s carrying found:false.
  // Announcing those would beep all session.
  const seen = {};
  const r = shouldAnnounce(seen, 'engulf', { tf: '1h', found: false, time: '2026-08-24T11:30:00Z' }, T);
  assert.equal(r.announce, false);
  assert.match(r.reason, /heartbeat/);
});

test('absence of `found` is NOT treated as found:false', () => {
  // The dedicated *-signal events carry no `found` field at all. Treating
  // absent as false would silence every real detection.
  const seen = {};
  assert.equal(shouldAnnounce(seen, 'fvg', { tf: '30', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 }, T).announce, true);
});

// ── the real duplicate observed live on 2026-08-24 ─────────────────────────
test('the SAME FVG gap re-firing on a later poll does not announce twice', () => {
  // Observed live: gap 29204-29205.75 fired at 17:00:20 and again at 17:15:17.
  // One setup, one sound.
  const seen = {};
  const first = { tf: '30', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 };
  const again = { tf: '30', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 };
  assert.equal(shouldAnnounce(seen, 'fvg', first, T).announce, true, 'first fire announces');
  assert.equal(shouldAnnounce(seen, 'fvg', again, T + 15 * 60 * 1000).announce, false, 're-confirm stays silent');
});

test('a DIFFERENT gap on the same timeframe is a new signal', () => {
  const seen = {};
  shouldAnnounce(seen, 'fvg', { tf: '30', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 }, T);
  const other = shouldAnnounce(seen, 'fvg', { tf: '30', direction: 'BEARISH', gapLow: 29310, gapHigh: 29312 }, T + 60000);
  assert.equal(other.announce, true);
});

test('the same setup announces again once the repeat window has passed', () => {
  const seen = {};
  const sig = { tf: '30', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 };
  shouldAnnounce(seen, 'fvg', sig, T);
  assert.equal(shouldAnnounce(seen, 'fvg', sig, T + REPEAT_WINDOW_MS + 1).announce, true);
});

// ── identity per watcher type ──────────────────────────────────────────────
test('sfp identity is the swept level', () => {
  const seen = {};
  assert.equal(shouldAnnounce(seen, 'sfp', { tf: '30', direction: 'bearish', level: 29248 }, T).announce, true);
  assert.equal(shouldAnnounce(seen, 'sfp', { tf: '30', direction: 'bearish', level: 29248 }, T + 1000).announce, false);
  assert.equal(shouldAnnounce(seen, 'sfp', { tf: '30', direction: 'bearish', level: 29300 }, T + 2000).announce, true);
});

test('po3 identity includes where it came FROM, so re-entering a phase is new', () => {
  const seen = {};
  const a = { symbol: 'MNQ1!', from: 'MANIPULATION', to: 'DISTRIBUTION' };
  const b = { symbol: 'MNQ1!', from: 'DISTRIBUTION', to: 'ACCUMULATION' };
  const c = { symbol: 'MNQ1!', from: 'ACCUMULATION', to: 'DISTRIBUTION' };
  assert.equal(shouldAnnounce(seen, 'po3', a, T).announce, true);
  assert.equal(shouldAnnounce(seen, 'po3', b, T + 1000).announce, true);
  assert.equal(shouldAnnounce(seen, 'po3', c, T + 2000).announce, true, 'a different route into the same phase is a new event');
});

test('the two symbols are tracked separately (MNQ and MGC run together)', () => {
  const seen = {};
  const mnq = { symbol: 'MNQ1!', from: 'A', to: 'B' };
  const mgc = { symbol: 'MGC1!', from: 'A', to: 'B' };
  assert.equal(shouldAnnounce(seen, 'po3', mnq, T).announce, true);
  assert.equal(shouldAnnounce(seen, 'po3', mgc, T).announce, true, 'the secondary symbol must not be swallowed');
});

test('an unknown type never announces', () => {
  assert.equal(shouldAnnounce({}, 'nonsense', { tf: '1' }, T).announce, false);
  assert.equal(signalKey('nonsense', {}), null);
});

// ── copy ───────────────────────────────────────────────────────────────────
test('descriptions are short one-liners fit for the chat stream', () => {
  assert.equal(describeSignal('fvg', { tfLabel: '30M', direction: 'BEARISH', gapLow: 29204, gapHigh: 29205.75 }),
    'FVG 30M · BEARISH · gap 29204–29205.75');
  assert.equal(describeSignal('sfp', { tfLabel: '30M', direction: 'bearish', level: 29248 }),
    'SFP 30M · BEARISH · swept 29248');
  assert.equal(describeSignal('po3', { symLabel: 'MNQ', from: 'MANIPULATION', to: 'DISTRIBUTION' }),
    'PO3 MNQ MANIPULATION → DISTRIBUTION');
  for (const t of ['engulf', 'fvg', 'sfp', 'po3']) {
    assert.ok(describeSignal(t, {}).length < 60, t + ' description stays short');
  }
});

// ── robustness: this runs in the render path of a live trading UI ──────────
test('never throws on garbage', () => {
  assert.doesNotThrow(() => shouldAnnounce({}, 'fvg', null, T));
  assert.doesNotThrow(() => shouldAnnounce({}, 'fvg', undefined, T));
  assert.doesNotThrow(() => shouldAnnounce(null, 'fvg', {}, T));
  assert.doesNotThrow(() => shouldAnnounce({}, 'po3', {}, NaN));
  assert.doesNotThrow(() => describeSignal('engulf', null));
});

test('pruneSeen keeps the map from growing all session', () => {
  const seen = { old: T - REPEAT_WINDOW_MS - 1, fresh: T };
  pruneSeen(seen, T);
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'old'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'fresh'), true);
});

// ── 2026-08-27: engulf dedup keys on the CANDLE, not the poll clock ──────────
// The old key used `time`, which server.js built from `new Date()` at the
// moment the monitor noticed — so every re-poll of the same candle produced a
// fresh key and chimed again. On a 5M watcher polling every 15s that is up to
// twenty chimes for one candle.
test('engulf: the same candle re-firing on a later poll chimes ONCE', () => {
  const seen = Object.create(null);
  const T = Date.parse('2026-08-27T07:00:00Z');
  const bar = { tf: '5m', direction: 'BULLISH', barTime: 1756278000, time: '12:30:05' };
  assert.strictEqual(shouldAnnounce(seen, 'engulf', bar, T).announce, true);
  // Same candle, noticed 15s later — the poll clock moved, the candle did not.
  const reFire = { ...bar, time: '12:30:20' };
  assert.strictEqual(shouldAnnounce(seen, 'engulf', reFire, T + 15000).announce, false);
});

test('engulf: the NEXT candle is a new signal and chimes again', () => {
  const seen = Object.create(null);
  const T = Date.parse('2026-08-27T07:00:00Z');
  const a = { tf: '5m', direction: 'BULLISH', barTime: 1756278000 };
  const b = { tf: '5m', direction: 'BULLISH', barTime: 1756278300 };  // +5 min
  assert.strictEqual(shouldAnnounce(seen, 'engulf', a, T).announce, true);
  // Inside the 20-min repeat window — a wall-clock-keyed dedup would swallow
  // this. Consecutive 5M engulfs are exactly the case that must not be lost.
  assert.strictEqual(shouldAnnounce(seen, 'engulf', b, T + 5 * 60 * 1000).announce, true);
});

test('engulf: the chat line carries candle time, price and key level', () => {
  const text = describeSignal('engulf', {
    tfLabel: '5M', direction: 'BULLISH', barCloseIST: '12:30:00',
    price: 29428.75, levelNote: ' — AT PDL 29402.25',
  });
  assert.match(text, /5M/);
  assert.match(text, /12:30:00/);
  assert.match(text, /29428\.75/);
  assert.match(text, /PDL 29402\.25/);
});

test('engulf: an older server sending none of the annotations still describes cleanly', () => {
  const text = describeSignal('engulf', { tfLabel: '1H', direction: 'BEARISH' });
  assert.strictEqual(text, 'Engulfing 1H · BEARISH');
});
