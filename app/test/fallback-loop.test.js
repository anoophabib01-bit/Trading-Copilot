'use strict';
/**
 * fallback-loop.test.js — unit tests for groq-agent.js's model-fallback loop
 * cap (shouldLoopChain/loopGiveUpReason), extracted 2026-08-03 specifically
 * to make this testable. This is the one correctness-critical new piece from
 * the token-audit/reliability plan: a wrong decision here either hangs a
 * live trading session (loops when it shouldn't) or gives up too early on a
 * transient blip (doesn't loop when it should).
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldLoopChain, loopGiveUpReason, RETRYABLE_STATUSES } = require('../groq-agent.js')._debug;

const BASE = { chainLength: 3, lapCount: 1, maxLaps: 2, elapsedMs: 1000, budgetMs: 60000 };

test('shouldLoopChain: loops on a retryable status within lap and time budget', () => {
  for (const statusCode of RETRYABLE_STATUSES) {
    assert.equal(shouldLoopChain({ ...BASE, statusCode }), true, `expected loop for status ${statusCode}`);
  }
});

test('shouldLoopChain: does NOT loop on a non-retryable status', () => {
  for (const statusCode of [200, 401, 403, 422]) {
    assert.equal(shouldLoopChain({ ...BASE, statusCode }), false, `expected no loop for status ${statusCode}`);
  }
});

test('shouldLoopChain: does NOT loop when lap cap is already reached', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, lapCount: 2, maxLaps: 2 }), false);
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, lapCount: 5, maxLaps: 2 }), false);
});

test('shouldLoopChain: loops right up to the boundary below lap cap', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, lapCount: 1, maxLaps: 2 }), true);
});

test('shouldLoopChain: does NOT loop when the time budget is exactly exhausted or exceeded', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, elapsedMs: 60000, budgetMs: 60000 }), false);
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, elapsedMs: 90000, budgetMs: 60000 }), false);
});

test('shouldLoopChain: loops with time remaining just under budget', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, elapsedMs: 59999, budgetMs: 60000 }), true);
});

test('shouldLoopChain: does NOT loop for a single-candidate chain (nothing to fall back through)', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, chainLength: 1 }), false);
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, chainLength: 0 }), false);
});

test('shouldLoopChain: both caps enforced together — lap cap wins even with budget remaining', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, lapCount: 2, maxLaps: 2, elapsedMs: 100, budgetMs: 60000 }), false);
});

test('shouldLoopChain: both caps enforced together — budget wins even with laps remaining', () => {
  assert.equal(shouldLoopChain({ ...BASE, statusCode: 429, lapCount: 0, maxLaps: 5, elapsedMs: 61000, budgetMs: 60000 }), false);
});

test('loopGiveUpReason: attributes to lap cap when lap count has reached the cap', () => {
  assert.equal(loopGiveUpReason({ lapCount: 2, maxLaps: 2 }), 'lap cap (2) reached');
  assert.equal(loopGiveUpReason({ lapCount: 3, maxLaps: 2 }), 'lap cap (2) reached');
});

test('loopGiveUpReason: attributes to time budget when lap count is still under the cap', () => {
  assert.equal(loopGiveUpReason({ lapCount: 1, maxLaps: 2 }), 'time budget exceeded');
  assert.equal(loopGiveUpReason({ lapCount: 0, maxLaps: 5 }), 'time budget exceeded');
});
