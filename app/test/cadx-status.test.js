// Tests for cadx-status.js — the Playbook C (ADX) row in the Chart Watchers
// panel. See the module header for why C-ADX had no live surface at all.
const test = require('node:test');
const assert = require('node:assert');
const { cadxWatcherRow } = require('../cadx-status');

const T0 = Date.parse('2026-09-03T17:11:54+05:30');
const row = (stats, over) => cadxWatcherRow(Object.assign({
  stats, running: true, tvDown: false, nowMs: T0, intervalMs: 60000, minBars: 120
}, over || {}));

test('a healthy idle monitor says it is watching, and says nothing more', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'no-signal', bars: 1179, signals: 0 });
  assert.strictEqual(r.health, 'healthy');
  assert.match(r.detail, /no setup on the last closed bar/);
  assert.match(r.detail, /1179 bars/);
  assert.match(r.detail, /0 signals this run/, 'zero is the expected reading and must be shown');
});

test('THE ONE THAT WAS INVISIBLE: setup found but held by the HTF gate', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'htf-blocked', bars: 1179, signals: 0 });
  assert.strictEqual(r.health, 'healthy');
  assert.match(r.detail, /SETUP FOUND/);
  assert.match(r.detail, /HTF gate/);
});

test('a fired signal is reported as such, with the time', () => {
  const r = row({ lastCheckAt: T0 - 2000, lastStatus: 'signal', bars: 1179, signals: 1, lastSignalAt: T0 - 60000 });
  assert.match(r.detail, /SIGNAL FIRED/);
  assert.match(r.detail, /1 signal this run/, 'singular, not "1 signals"');
  assert.match(r.detail, /last signal/);
});

test('shadow OFF is reported as stopped, not as healthy', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'inactive' });
  assert.strictEqual(r.health, 'stopped');
  assert.match(r.detail, /shadow is OFF/);
});

test('a chart on the wrong symbol is reported, not silently green', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'not-mnq' });
  assert.strictEqual(r.health, 'stopped');
  assert.match(r.detail, /not MNQ/);
});

test('warm-up shows progress toward the bar requirement', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'short-history:64' });
  assert.strictEqual(r.health, 'healthy');
  assert.match(r.detail, /warming up — 64 of 120 bars/);
});

test('a fetch failure is amber, never green', () => {
  for (const st of ['fetch-failed', 'no-bars', 'merge-rejected']) {
    assert.strictEqual(row({ lastCheckAt: T0 - 5000, lastStatus: st }).health, 'amber', st);
  }
});

test('THE 2.5-HOUR GAP: a stale monitor goes amber then red, and says nothing restarts it', () => {
  const fresh = row({ lastCheckAt: T0 - 60000, lastStatus: 'no-signal' });
  assert.strictEqual(fresh.health, 'healthy');
  const stale = row({ lastCheckAt: T0 - 5 * 60000, lastStatus: 'no-signal' });
  assert.strictEqual(stale.health, 'amber');
  assert.match(stale.detail, /STALE/);
  assert.match(stale.detail, /nothing restarts this one/);
  const dead = row({ lastCheckAt: T0 - 150 * 60000, lastStatus: 'no-signal' });
  assert.strictEqual(dead.health, 'red', '2.5 hours with no check is red, not amber');
});

test('a stale monitor never reports its last status as if it were current', () => {
  const stale = row({ lastCheckAt: T0 - 60 * 60000, lastStatus: 'no-signal', bars: 1179 });
  assert.doesNotMatch(stale.detail, /watching/, 'the last thing it said stops being true when it stops saying anything');
});

test('no completed check yet is amber "starting up", not healthy', () => {
  const r = row({ lastStatus: null });
  assert.strictEqual(r.health, 'amber');
  assert.match(r.detail, /starting up/);
});

test('not running and TV down are each reported distinctly', () => {
  assert.strictEqual(row({}, { running: false }).health, 'stopped');
  assert.match(row({}, { running: false }).detail, /not running/);
  const off = row({ lastCheckAt: T0 }, { tvDown: true });
  assert.strictEqual(off.health, 'tv-offline');
  assert.match(off.detail, /waiting for TradingView/);
});

test('an unrecognised status is amber and quotes itself, never silently green', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'something-new' });
  assert.strictEqual(r.health, 'amber');
  assert.match(r.detail, /unrecognised status "something-new"/);
});

test('the row keeps the shape the panel already renders', () => {
  const r = row({ lastCheckAt: T0 - 5000, lastStatus: 'no-signal' });
  assert.strictEqual(r.id, 'c-adx');
  assert.match(r.label, /Playbook C \(ADX\)/);
  assert.strictEqual(typeof r.running, 'boolean');
  assert.strictEqual(typeof r.health, 'string');
  assert.strictEqual(r.lastError, null);
  assert.strictEqual(typeof r.lastCheck, 'string');
});

test('missing/garbage input degrades to a stopped row, never throws', () => {
  for (const v of [undefined, {}, { stats: null }]) {
    const r = cadxWatcherRow(v);
    assert.strictEqual(r.id, 'c-adx');
    assert.strictEqual(r.health, 'stopped');
  }
});
