'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { hitTarget, hitStop, dirSign } = require('../take-profit-signal');

test('dirSign maps directions', () => {
  assert.strictEqual(dirSign('BULLISH'), 1);
  assert.strictEqual(dirSign('BEARISH'), -1);
  assert.strictEqual(dirSign('LONG'), 1);
  assert.strictEqual(dirSign('SHORT'), -1);
  assert.strictEqual(dirSign(''), 0);
  assert.strictEqual(dirSign(null), 0);
  assert.strictEqual(dirSign(undefined), 0);
});

test('bullish target is hit when price reaches or exceeds it', () => {
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: 100 }, 101), true);
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: 100 }, 100), true);
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: 100 }, 99.5), false);
});

test('bearish target is hit when price falls to or under it', () => {
  assert.strictEqual(hitTarget({ direction: 'BEARISH', target: 100 }, 99), true);
  assert.strictEqual(hitTarget({ direction: 'BEARISH', target: 100 }, 100), true);
  assert.strictEqual(hitTarget({ direction: 'BEARISH', target: 100 }, 100.5), false);
});

test('missing target or unreadable price is never a hit', () => {
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: null }, 100), false);
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: 100 }, null), false);
  assert.strictEqual(hitTarget({ direction: 'BULLISH', target: 100 }, NaN), false);
  assert.strictEqual(hitTarget(null, 100), false);
  assert.strictEqual(hitTarget({ target: 100 }, 100), false); // no direction
});

test('stop is the mirror image', () => {
  assert.strictEqual(hitStop({ direction: 'BULLISH', stop: 90 }, 89), true);
  assert.strictEqual(hitStop({ direction: 'BULLISH', stop: 90 }, 91), false);
  assert.strictEqual(hitStop({ direction: 'BEARISH', stop: 110 }, 111), true);
  assert.strictEqual(hitStop({ direction: 'BEARISH', stop: 110 }, 109), false);
});
