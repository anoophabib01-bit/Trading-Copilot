'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { marketStateLine, tfSecondsFor } = require('../market-state.js');

test('no setup → watching line with bias and session', () => {
  const line = marketStateLine(null, { nowMs: 1000, hourTrendLabel: 'STRONG BEAR', hourTrendDirection: 'bearish', sessionTier: 'London' });
  assert.ok(line.includes('no setup armed'));
  assert.ok(line.includes('STRONG BEAR (bearish)'));
  assert.ok(line.includes('London'));
});

test('live setup → SETUP LIVE line with playbook, direction, tf, level, gap', () => {
  const setup = {
    signalTs: 1000000, expiresAt: 1000000 + 8 * 1800 * 1000,
    playbook: 'B', tfCode: '30', tfLabel: '30M', direction: 'BULLISH',
    level: 21847.25, gapLow: 21850, gapHigh: 21862,
    message: 'swept sell-side and rejected, HL structure intact'
  };
  const line = marketStateLine(setup, { nowMs: 1000000 + 4 * 60000, hourTrendLabel: 'BULL', hourTrendDirection: 'bullish', sessionTier: 'NY' });
  assert.ok(line.includes('SETUP LIVE'));
  assert.ok(line.includes('Playbook B'));
  assert.ok(line.includes('BULLISH · 30M'));
  assert.ok(line.includes('level 21847.25'));
  assert.ok(line.includes('gap 21850-21862'));
  assert.ok(line.includes('fired 4m ago'));
  assert.ok(line.includes('expires in ~8 candles'));
  assert.ok(line.includes('NY session'));
  assert.ok(line.includes('validity: swept sell-side'));
  assert.ok(line.includes("Daily is Anoop's read"));
});

test('expiry count never shows below 1 candle', () => {
  const setup = { signalTs: 1000000, expiresAt: 1000000 + 1000, playbook: 'A', tfCode: '60', tfLabel: '1H', direction: 'BEARISH' };
  const line = marketStateLine(setup, { nowMs: 1000000 + 900, hourTrendLabel: 'BEAR', sessionTier: 'outside-session' });
  assert.ok(line.includes('expires in ~1 candles'));
});

test('tfSecondsFor handles codes and unknown fallback', () => {
  assert.equal(tfSecondsFor('30'), 1800);
  assert.equal(tfSecondsFor('60'), 3600);
  assert.equal(tfSecondsFor('D'), 86400);
  assert.equal(tfSecondsFor('nonsense'), 900);
});
