'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, badge, normaliseMode, LIVE_REQUIREMENTS } = require('../autonomy-gate.js');

const QUALIFIED = {
  playbook: 'B', resolvedTrades: 50, profitFactor: 1.5,
  maxDrawdownUsd: 500, accountDrawdownLimitUsd: 2000,
};
const ARMED = { mode: 'live', armedBy: 'anoop', armedAt: '2026-08-26T10:00:00Z', shadowDays: 25 };

test('OFF is the default and means the human trades', () => {
  assert.equal(evaluate({}, {}).effectiveMode, 'off');
  assert.equal(evaluate({ mode: 'garbage' }, {}).effectiveMode, 'off');
  assert.equal(badge(evaluate({}, {})).text, 'YOU ARE TRADING');
});

test('SHADOW is always permitted — it cannot lose money', () => {
  const r = evaluate({ mode: 'shadow' }, {});
  assert.equal(r.allowed, true);
  assert.equal(r.effectiveMode, 'shadow');
  assert.match(r.summary, /Nothing reaches the broker/);
});

// ── The point of the gate ───────────────────────────────────────────────────
test('LIVE is refused when the strategy has no demonstrated edge', () => {
  const r = evaluate(ARMED, { playbook: 'B', resolvedTrades: 4, profitFactor: 0.63, maxDrawdownUsd: 584, accountDrawdownLimitUsd: 2000 });
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.some((b) => /resolved trades/.test(b)));
  assert.ok(r.blockers.some((b) => /profit factor/.test(b)));
});

test('a refusal falls back to SHADOW, not OFF — the request is honoured as far as it safely can be', () => {
  const r = evaluate(ARMED, { playbook: 'B', resolvedTrades: 0, accountDrawdownLimitUsd: 2000 });
  assert.equal(r.effectiveMode, 'shadow');
  assert.match(r.summary, /evidence keeps building/);
});

test('every unmet requirement is named individually, so "what would it take" is answerable', () => {
  const r = evaluate({ mode: 'live', shadowDays: 0 }, { playbook: 'B' });
  assert.ok(r.blockers.length >= 4);
  assert.ok(r.blockers.some((b) => /human confirmation/.test(b)));
  assert.ok(r.blockers.some((b) => /SHADOW first/.test(b)));
  assert.ok(r.blockers.some((b) => /drawdown limit not configured/.test(b)));
});

test('no code path may self-promote to LIVE without a human arming it', () => {
  const noHuman = { mode: 'live', armedBy: null, shadowDays: 99 };
  const r = evaluate(noHuman, QUALIFIED);
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.some((b) => /human confirmation/.test(b)));
});

test('LIVE is granted only when the human armed it AND every threshold is met', () => {
  const r = evaluate(ARMED, QUALIFIED);
  assert.equal(r.allowed, true);
  assert.equal(r.effectiveMode, 'live');
  assert.match(r.summary, /Armed by anoop/);
  assert.equal(badge(r).text, 'CLAUDE IS TRADING');
});

test('a strategy that drew down too far against the account limit is refused', () => {
  const deep = { ...QUALIFIED, maxDrawdownUsd: 1200 }; // 60% of a 2000 limit, over the 40% ceiling
  const r = evaluate(ARMED, deep);
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.some((b) => /exceeds 40%/.test(b)));
});

test('an unconfigured account drawdown limit blocks LIVE rather than being assumed safe', () => {
  const r = evaluate(ARMED, { ...QUALIFIED, accountDrawdownLimitUsd: null });
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.some((b) => /not configured/.test(b)));
});

test('a missing profit factor blocks, and is not read as neutral', () => {
  const r = evaluate(ARMED, { ...QUALIFIED, profitFactor: undefined });
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.some((b) => /none measured/.test(b)));
});

test('thresholds are exact boundaries, not approximate', () => {
  const atBar = { ...QUALIFIED, resolvedTrades: LIVE_REQUIREMENTS.minResolvedTrades, profitFactor: LIVE_REQUIREMENTS.minProfitFactor };
  assert.equal(evaluate({ ...ARMED, shadowDays: LIVE_REQUIREMENTS.minShadowDays }, atBar).allowed, true);
  const justUnder = { ...atBar, resolvedTrades: LIVE_REQUIREMENTS.minResolvedTrades - 1 };
  assert.equal(evaluate(ARMED, justUnder).allowed, false);
});

test('the badge is never ambiguous about who is in charge', () => {
  const texts = ['off', 'shadow', 'live'].map((m) => badge({ effectiveMode: m }).text);
  assert.equal(new Set(texts).size, 3);
  for (const t of texts) assert.ok(t.length > 0);
});

test('normaliseMode rejects anything not in the known set', () => {
  assert.equal(normaliseMode('LIVE'), 'live');
  assert.equal(normaliseMode('nonsense'), 'off');
  assert.equal(normaliseMode(null), 'off');
  assert.equal(normaliseMode(undefined), 'off');
});

// ── Only a human may arm LIVE ───────────────────────────────────────────────
const { isHumanArmer } = require('../autonomy-gate.js');

test('a session id or service account does NOT count as human confirmation', () => {
  for (const impostor of ['claude-session-2026-08-26', 'system', 'watchdog', 'localhost', '', '   ', 'true']) {
    const r = evaluate({ ...ARMED, armedBy: impostor }, QUALIFIED);
    assert.equal(r.allowed, false, `"${impostor}" must not arm LIVE`);
    assert.ok(r.blockers.some((b) => /human/.test(b)));
  }
});

test('the real human identity does arm it, case- and whitespace-insensitively', () => {
  for (const ok of ['anoop', 'Anoop', '  ANOOP  ']) {
    assert.equal(evaluate({ ...ARMED, armedBy: ok }, QUALIFIED).allowed, true, `"${ok}" should arm`);
  }
});

test('isHumanArmer is an allow-list, so unknown callers never inherit the privilege', () => {
  assert.equal(isHumanArmer('anoop'), true);
  assert.equal(isHumanArmer('anyone-else'), false);
  assert.equal(isHumanArmer(null), false);
  assert.equal(isHumanArmer(undefined), false);
});

// ── ASSIST — the rung added 2026-08-29 ──────────────────────────────────────
// Real orders, but every one passes through Anoop's click. The properties that
// matter: it is NOT gated on the evidence bar (that would be circular — ASSIST
// is where evidence about real execution starts existing), and it IS gated on
// a human, because entering it changes what the app is able to do at all.

test('ASSIST is granted without any track record — the bar would be circular', () => {
  const noEvidence = { playbook: 'B', resolvedTrades: 0, profitFactor: null,
                       maxDrawdownUsd: null, accountDrawdownLimitUsd: 2000 };
  const r = evaluate({ mode: 'assist', armedBy: 'anoop', shadowDays: 0 }, noEvidence);
  assert.equal(r.allowed, true);
  assert.equal(r.effectiveMode, 'assist');
  assert.deepEqual(r.blockers, []);
});

test('ASSIST still refuses a non-human armer, and falls back to SHADOW', () => {
  for (const impostor of ['session-abc', 'system', '', null]) {
    const r = evaluate({ mode: 'assist', armedBy: impostor }, QUALIFIED);
    assert.equal(r.allowed, false, `"${impostor}" must not arm ASSIST`);
    assert.equal(r.effectiveMode, 'shadow', 'refusal falls back to SHADOW, never to a permissive mode');
    assert.ok(r.blockers.some((b) => /human/.test(b)));
  }
});

test('ASSIST says who places the order, unambiguously', () => {
  const r = evaluate({ mode: 'assist', armedBy: 'anoop' }, QUALIFIED);
  assert.match(r.summary, /Nothing is placed until you approve it/);
  assert.equal(badge(r).text, 'ASSIST — you approve every trade');
  assert.equal(badge(r).tone, 'assist');
});

test('every mode produces its own distinct badge — the toggle is never ambiguous', () => {
  const texts = new Set();
  for (const mode of ['off', 'shadow', 'assist', 'live']) {
    const r = evaluate({ mode, armedBy: 'anoop', shadowDays: 40 }, QUALIFIED);
    texts.add(badge(r).text);
  }
  assert.equal(texts.size, 4, 'each mode must be visually distinguishable');
});

test('the gate and the modes module agree on the mode list', () => {
  // Divergence here means a mode that exists in one file reads as unknown (and
  // therefore as OFF) in the other — a silent downgrade nobody would notice.
  const modes = require('../autonomy-modes.js');
  const gate = require('../autonomy-gate.js');
  assert.deepEqual(gate.MODES, modes.MODES);
});
