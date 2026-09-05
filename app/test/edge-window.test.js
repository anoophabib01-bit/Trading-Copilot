'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { edgeWindowVerdict } = require('../edge-window');
const W = { start: 1080, end: 1200 };
test('14:00 IST (840) outside', () => { assert.equal(edgeWindowVerdict({ istMinutes: 840, window: W }).outsideEdge, true); });
test('19:15 IST (1155) inside', () => { assert.equal(edgeWindowVerdict({ istMinutes: 1155, window: W }).outsideEdge, false); });
test('18:00 inside, 20:00 outside', () => {
  assert.equal(edgeWindowVerdict({ istMinutes: 1080, window: W }).outsideEdge, false);
  assert.equal(edgeWindowVerdict({ istMinutes: 1200, window: W }).outsideEdge, true);
});
test('uncomputable does not block', () => { assert.equal(edgeWindowVerdict({ istMinutes: null, window: W }).outsideEdge, false); });
