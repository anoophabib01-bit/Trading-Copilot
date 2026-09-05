const test = require('node:test');
const assert = require('node:assert');
const { dayPnl, dayPnlSourceTag } = require('../renderer/day-pnl.js');

// The regression this module exists for. On 2026-09-04 the left panel showed
// +$127 while the HUD showed -$2,308 on the same day: the panel only assigned
// acc.profit when today had NO ledger entry, so once one existed it kept a
// stale value forever while the live feed carried on.
test('REGRESSION: a live feed wins even when today already has a ledger entry', () => {
  const r = dayPnl({
    live: { connected: true, dayPnl: -2308 },
    ledgerToday: 127,
    trades: [{ pnl: 127 }]
  });
  assert.strictEqual(r.value, -2308);
  assert.strictEqual(r.source, 'live');
});

test('both surfaces get the same answer from the same input', () => {
  const input = { live: { connected: true, dayPnl: -2308 }, ledgerToday: 127, trades: [] };
  assert.deepStrictEqual(dayPnl(input), dayPnl(input));
});

test('live is skipped when the feed is disconnected', () => {
  const r = dayPnl({ live: { connected: false, dayPnl: -2308 }, ledgerToday: -855.5 });
  assert.strictEqual(r.value, -855.5);
  assert.strictEqual(r.source, 'ledger');
});

// A disconnected feed reporting a stale number must not beat a real one.
test('live is skipped when dayPnl is not a finite number', () => {
  assert.strictEqual(dayPnl({ live: { connected: true, dayPnl: null }, ledgerToday: -40 }).source, 'ledger');
  assert.strictEqual(dayPnl({ live: { connected: true, dayPnl: undefined }, trades: [{ pnl: -12 }] }).source, 'manual');
  assert.strictEqual(dayPnl({ live: { connected: true, dayPnl: NaN }, ledgerToday: -40 }).value, -40);
});

// The 2026-08-11 case recorded in grRender's own comment: the HUD read -$637
// from hand-typed trades while the CSV said -$855.50, because two of six were
// never logged. The CSV tier now outranks the manual sum.
test('a CSV-confirmed day beats a hand-typed sum that is missing trades', () => {
  const r = dayPnl({
    live: { connected: false },
    ledgerToday: -855.5,
    trades: [{ pnl: -300 }, { pnl: -337 }]      // only 4 of 6 logged
  });
  assert.strictEqual(r.value, -855.5);
  assert.strictEqual(r.source, 'ledger');
  assert.strictEqual(r.verified, true);
});

test('falls back to the manual sum, marked unverified', () => {
  const r = dayPnl({ trades: [{ pnl: -300 }, { pnl: 40 }, { pnl: -12.5 }] });
  assert.strictEqual(r.value, -272.5);
  assert.strictEqual(r.source, 'manual');
  assert.strictEqual(r.verified, false);
});

test('non-numeric trade P&Ls are ignored rather than poisoning the sum', () => {
  const r = dayPnl({ trades: [{ pnl: -100 }, { pnl: null }, {}, { pnl: '50' }, { pnl: 25 }] });
  assert.strictEqual(r.value, -75);
});

// A ledger entry of exactly 0 is a real, confirmed flat day and must not fall
// through to the manual tier the way a null would.
test('a ledger net of zero is a confirmed flat day, not a missing one', () => {
  const r = dayPnl({ ledgerToday: 0, trades: [{ pnl: -500 }] });
  assert.strictEqual(r.value, 0);
  assert.strictEqual(r.source, 'ledger');
});

test('nothing at all reports zero but does NOT claim to be verified', () => {
  const r = dayPnl({});
  assert.strictEqual(r.value, 0);
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.verified, false);
  assert.strictEqual(dayPnl(null).source, 'none');
  assert.strictEqual(dayPnl(undefined).source, 'none');
});

test('an empty trade list is not treated as a logged flat day', () => {
  assert.strictEqual(dayPnl({ trades: [] }).source, 'none');
});

test('source tags name the source, and live carries no tag', () => {
  assert.strictEqual(dayPnlSourceTag('live'), '');
  assert.strictEqual(dayPnlSourceTag('none'), '');
  assert.match(dayPnlSourceTag('manual'), /unverified/);
  assert.match(dayPnlSourceTag('ledger'), /CSV/);
});

// ── dayCounts: the "all the other details are empty" regression ─────────────
// The panel showed Trades 0 while the HUD showed 6, because acc.tradeCount was
// only ever written by the manual log path.
test('REGRESSION: trade count comes from the live feed, not the manual log', () => {
  const { dayCounts } = require('../renderer/day-pnl.js');
  const r = dayCounts({ live: { connected: true, tradeCount: 6, maxSize: 20 }, trades: [] });
  assert.strictEqual(r.trades, 6);
  assert.strictEqual(r.maxSize, 20);
  assert.strictEqual(r.source, 'live');
});

test('dayCounts falls back to the manual list and takes the largest size', () => {
  const { dayCounts } = require('../renderer/day-pnl.js');
  const r = dayCounts({ trades: [{ size: 2 }, { size: 5 }, { size: 1 }] });
  assert.strictEqual(r.trades, 3);
  assert.strictEqual(r.maxSize, 5);
  assert.strictEqual(r.source, 'manual');
});

test('dayCounts reports nothing as source "none", not a logged flat day', () => {
  const { dayCounts } = require('../renderer/day-pnl.js');
  assert.deepStrictEqual(dayCounts({}), { trades: 0, maxSize: 0, source: 'none' });
});

test('a connected feed reporting zero trades is still authoritative', () => {
  const { dayCounts } = require('../renderer/day-pnl.js');
  const r = dayCounts({ live: { connected: true, tradeCount: 0 }, trades: [{ size: 9 }] });
  assert.strictEqual(r.trades, 0);
  assert.strictEqual(r.source, 'live');
});

// ── breakRemainingMs ───────────────────────────────────────────────────────
test('the live cooldown drives the break when there is no manual trade time', () => {
  const { breakRemainingMs } = require('../renderer/day-pnl.js');
  const now = 1_000_000;
  assert.strictEqual(breakRemainingMs({ cooldownUntil: now + 90_000, now }), 90_000);
});

test('a manual log cannot shorten a cooldown that is already running', () => {
  const { breakRemainingMs } = require('../renderer/day-pnl.js');
  const now = 1_000_000;
  // manual break would end in 60s; the live cooldown runs 10 minutes
  const rem = breakRemainingMs({
    cooldownUntil: now + 600_000,
    lastTradeTime: now - 14 * 60_000,
    cooldownMs: 15 * 60_000,
    now
  });
  assert.strictEqual(rem, 600_000);
});

test('no break running reports zero, not a negative', () => {
  const { breakRemainingMs } = require('../renderer/day-pnl.js');
  const now = 1_000_000;
  assert.strictEqual(breakRemainingMs({ cooldownUntil: now - 5000, now }), 0);
  assert.strictEqual(breakRemainingMs({ now }), 0);
  assert.strictEqual(breakRemainingMs({ lastTradeTime: now - 20 * 60_000, cooldownMs: 15 * 60_000, now }), 0);
});
