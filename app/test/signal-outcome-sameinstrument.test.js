'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sameInstrument } = require('../signal-outcome');

test('sameInstrument matches root ticker across formats', () => {
  assert.strictEqual(sameInstrument('CME_MINI:MNQ1!', 'CME_MINI:MNQ1!'), true);
  assert.strictEqual(sameInstrument('CME_MINI:MNQ1!', 'MNQ1!'), true);
  assert.strictEqual(sameInstrument('MNQU6', 'MNQ1!'), true);   // same family, different month
  assert.strictEqual(sameInstrument('COMEX_MINI:MGC1!', 'CME_MINI:MNQ1!'), false);
  assert.strictEqual(sameInstrument('MGC1!', 'MNQ1!'), false);
});

test('unknown symbol never blocks', () => {
  assert.strictEqual(sameInstrument(null, 'MNQ1!'), true);
  assert.strictEqual(sameInstrument('', 'MNQ1!'), true);
  assert.strictEqual(sameInstrument('MNQ1!', undefined), true);
});
