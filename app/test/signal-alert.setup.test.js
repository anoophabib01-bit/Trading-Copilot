// Tests for the 'setup' alert kind — the chime added 2026-09-03 so an armed
// Playbook C (ADX) setup is audible instead of a silent card in the chat.
const test = require('node:test');
const assert = require('node:assert');
const SA = require('../renderer/signal-alert');

const TS = 1788400000000;
const setup = (over) => Object.assign({
  playbook: 'C-ADX', tfCode: '60', tfLabel: '1H', direction: 'BULLISH',
  entryRef: 29050, signalTs: TS
}, over || {});

test('an armed setup is announceable at all (it was not before)', () => {
  const r = SA.shouldAnnounce({}, 'setup', setup(), TS + 1000);
  assert.strictEqual(r.announce, true);
  assert.match(r.text, /SETUP ARMED/);
  assert.match(r.text, /C-ADX/);
  assert.match(r.text, /1H/);
  assert.match(r.text, /BULLISH/);
  assert.match(r.text, /29050/, 'the entry price is the point of the line');
});

test('THE RE-BROADCAST: the same setup re-sent does not chime twice', () => {
  const seen = {};
  assert.strictEqual(SA.shouldAnnounce(seen, 'setup', setup(), TS).announce, true);
  // The server re-broadcasts the live setup on every client connect and render.
  for (const t of [TS + 1000, TS + 60000, TS + 19 * 60000]) {
    assert.strictEqual(SA.shouldAnnounce(seen, 'setup', setup(), t).announce, false, 'at +' + t);
  }
});

test('the key is the signalTs, not the moment we were told', () => {
  // Same setup, two different arrival times — one identity.
  assert.strictEqual(
    SA.signalKey('setup', setup()),
    SA.signalKey('setup', setup())
  );
  // A genuinely new arm gets a new key.
  assert.notStrictEqual(
    SA.signalKey('setup', setup()),
    SA.signalKey('setup', setup({ signalTs: TS + 3600000 }))
  );
});

test('a different playbook or direction is a different setup', () => {
  const k = SA.signalKey('setup', setup());
  assert.notStrictEqual(k, SA.signalKey('setup', setup({ playbook: 'B' })));
  assert.notStrictEqual(k, SA.signalKey('setup', setup({ direction: 'BEARISH' })));
});

test('signalKey does not throw on a cleared slot', () => {
  // The real guard lives in app.js, which returns early on a falsy setup.
  // This pins that the module itself cannot be the thing that breaks on one.
  assert.doesNotThrow(() => SA.signalKey('setup', null));
});

test('the four existing watcher kinds are unchanged by the new case', () => {
  assert.strictEqual(SA.signalKey('engulf', { tf: '30', direction: 'BULLISH', barTime: 5 }), 'engulf|30|BULLISH|5');
  assert.strictEqual(SA.signalKey('fvg', { tf: '30', direction: 'BEARISH', gapLow: 1, gapHigh: 2 }), 'fvg|30|BEARISH|1-2');
  assert.strictEqual(SA.signalKey('sfp', { tf: '30', direction: 'BULLISH', level: 9 }), 'sfp|30|BULLISH|9');
  assert.strictEqual(SA.signalKey('po3', { symbol: 'MNQ', from: 'A', to: 'M' }), 'po3|MNQ|A→M');
  assert.strictEqual(SA.signalKey('nope', {}), null);
});

test('a watcher payload that used tf still reads tf, not tfCode', () => {
  assert.match(SA.describeSignal('engulf', { tf: '30', direction: 'BULLISH' }), /Engulfing 30/);
});
