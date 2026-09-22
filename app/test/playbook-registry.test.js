'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../playbook-registry');
const playbookSpec = require('../playbook-spec');
const realRules = require('../rules.json');

// No spec block by default: payoff must come from the rules object under test,
// never from a default baked into the helper.
const RULES = (over) => Object.assign({ sizeCap: 4 }, over || {});

// ── the registry itself ────────────────────────────────────────────────────
test('every shipped playbook id exists in the spec, so the registry cannot invent one', () => {
  for (const id of Object.keys(reg.PLAYBOOK_META)) {
    if (id === 'PO3') continue;   // informational: a phase event, deliberately not a setup
    assert.ok(playbookSpec.getPlaybook(id), id + ' is in the registry but not in playbook-spec.js');
  }
});

test('setups sort first — order[kind] is 0 for setup and must not fall into a || default', () => {
  // Regression: '(order[kind] || 9)' made setup (0) sort LAST, so the list was
  // valid, complete, and in the wrong order. Only the smoke run caught it.
  const list = reg.listRegistry(RULES());
  assert.equal(list[0].kind, 'setup');
  assert.deepEqual(list.filter((e) => e.kind === 'setup').map((e) => e.id).slice(0, 1), ['A']);
});

test('the SHIPPED defaults have A and B on, C-ADX off, everything recording-only', () => {
  // Asserted against an EMPTY config — i.e. the shipped default — not against
  // app/rules.json. That file is his to change from the app, and on 2026-09-21
  // he turned C-ADX on; a test that reads his live switches reports his taste as
  // a code regression. (Found exactly that way.)
  const list = reg.listRegistry({});
  const by = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.equal(by.A.enabled, true);
  assert.equal(by.B.enabled, true);
  assert.equal(by['C-ADX'].enabled, false);
  for (const e of list) assert.equal(e.shadowOnly, true, e.id + ' must start recording-only');
});

test('the LIVE rules file is still structurally valid, whatever his switches say', () => {
  // What is worth asserting about user data: every playbook resolves, the gate
  // is still locked, nothing has become executable, and the sizes respect the cap.
  const list = reg.listRegistry(realRules);
  assert.equal(list.length >= 4, true);
  const c = list.find((e) => e.id === 'C');
  assert.equal(c.enabled, true, 'the gate is locked ON regardless of the file');
  assert.equal(c.locked, true);
  for (const e of list) {
    if (e.kind === 'setup') assert.equal(e.shadowOnly, true, e.id + ' must never be executable by a file edit');
    for (const s of e.sizes) assert.ok(s <= 6, e.id + ' size must stay inside the hard cap');
  }
});

test('C is a gate and is locked ON even when rules.json says otherwise', () => {
  const r = RULES({ playbookRegistry: { C: { enabled: false } } });
  const entry = reg.entryFor(r, 'C');
  assert.equal(entry.enabled, true, 'a gate must not be switchable off');
  assert.equal(entry.locked, true);
  assert.match(entry.lockReason, /validity GATE/);
});

test('turning the gate off is refused, with the reason that explains why', () => {
  const out = reg.toggle(RULES(), 'C', false);
  assert.equal(out.ok, false);
  assert.match(out.reason, /unfiltered engulfs/);
});

test('PO3 cannot be taken out of shadow — it has no order path at all', () => {
  const out = reg.setShadowOnly(RULES(), 'PO3', false);
  assert.equal(out.ok, false);
  assert.match(out.reason, /no order path/);
  assert.equal(reg.resolveRegistry(RULES({ playbookRegistry: { PO3: { shadowOnly: false } } })).PO3.shadowOnly, true);
});

test('a gate can never be taken out of shadow either', () => {
  assert.equal(reg.setShadowOnly(RULES(), 'C', false).ok, false);
});

// ── the import path he asked for ───────────────────────────────────────────
test('a playbook added in rules.json appears immediately, OFF and recording-only', () => {
  const r = RULES({ playbookRegistry: { 'D-SWEEP': { enabled: true } } });
  const entry = reg.entryFor(r, 'D-SWEEP');
  assert.ok(entry, 'an imported playbook must be listed, not silently dropped');
  assert.equal(entry.unknown, true);
  assert.equal(entry.label, 'D-SWEEP');
});

test('an imported playbook cannot execute until it has a spec and a detector', () => {
  const r = RULES({ playbookRegistry: { 'D-SWEEP': { enabled: true, shadowOnly: false } } });
  const out = reg.canExecute(r, 'D-SWEEP', 'live', null);
  assert.equal(out.allowed, false);
  assert.match(out.reason, /no specification or detector/);
});

test('_comment style keys in the registry block are not treated as playbooks', () => {
  const list = reg.listRegistry(realRules);
  assert.equal(list.some((e) => e.id.startsWith('_')), false);
});

// ── toggles are patches, and the patch is clamped ───────────────────────────
test('toggle returns a patch, never a write, and the patch round-trips', () => {
  const out = reg.toggle(RULES(), 'B', false);
  assert.equal(out.ok, true);
  assert.equal(out.playbookRegistry.B.enabled, false);
  assert.equal(reg.isEnabled(RULES({ playbookRegistry: out.playbookRegistry }), 'B'), false);
  assert.equal(reg.isEnabled(RULES(), 'B'), true, 'the original rules object must be untouched');
});

test('sizes are clamped to sizeCap on every normalise, so the registry cannot widen the cap', () => {
  const r = RULES({ sizeCap: 3, playbookRegistry: { A: { enabled: true, sizes: [2, 6, 20] } } });
  assert.deepEqual(reg.sizesFor(r, 'A'), [2, 3, 3]);
});

test('a junk size list falls back to the default instead of an empty grant', () => {
  const r = RULES({ playbookRegistry: { A: { enabled: true, sizes: ['x', -2, 0] } } });
  assert.deepEqual(reg.sizesFor(r, 'A'), [2]);
});

// ── aliases ────────────────────────────────────────────────────────────────
test('historical ids resolve to the same registry entry as the current one', () => {
  assert.equal(reg.entryFor(RULES(), 'LTF-ENGULF').id, 'A');
  assert.equal(reg.entryFor(RULES(), 'DSH-V2').id, 'C-ADX');
});

// ── execution is the narrow answer, and it is never the registry alone ─────
test('an ON setup is still refused an order while it is recording-only', () => {
  const out = reg.canExecute(RULES(), 'A', 'live', null);
  assert.equal(out.allowed, false);
  assert.match(out.reason, /recording-only/);
});

test('a switched-off playbook is refused even when a mode lists it', () => {
  const r = RULES({ playbookRegistry: { A: { enabled: false, shadowOnly: false } } });
  const modes = { isPlaybookAllowed: () => true };
  const out = reg.canExecute(r, 'A', 'live', modes);
  assert.equal(out.allowed, false);
  assert.match(out.reason, /switched OFF/);
});

test('a mode that does not list the playbook refuses it even when the registry allows it', () => {
  const r = RULES({ playbookRegistry: { A: { enabled: true, shadowOnly: false } } });
  const modes = { isPlaybookAllowed: (rules, mode, pb) => pb === 'B' };
  assert.equal(reg.canExecute(r, 'A', 'live', modes).allowed, false);
  assert.equal(reg.canExecute(r, 'A', 'live', modes).reason.includes('not in the playbook list'), true);
});

test('only when both agree is execution allowed, and it carries the clamped sizes', () => {
  const r = RULES({ sizeCap: 4, playbookRegistry: { A: { enabled: true, shadowOnly: false, sizes: [2, 9] } } });
  const modes = { isPlaybookAllowed: () => true };
  const out = reg.canExecute(r, 'A', 'live', modes);
  assert.equal(out.allowed, true);
  assert.deepEqual(out.sizes, [2, 4]);
});

test('a gate is refused by canExecute with a reason that is not a config error', () => {
  assert.equal(reg.canExecute(RULES(), 'C', 'live', { isPlaybookAllowed: () => true }).allowed, false);
});

// ── the switch, decided by his own ledger ──────────────────────────────────
const STATS = (over) => Object.assign({ n: 0, wins: 0, winRate: null, expectancyPerContract: null }, over || {});

test('no scored signals is "insufficient", never "off"', () => {
  const out = reg.decideSwitch(STATS(), RULES());
  assert.equal(out.recommend, 'insufficient');
  assert.match(out.reason, /No outcome has been recorded/);
});

test('a small sample carries its own interval into the refusal', () => {
  // 7 of 12 is 58% — the exact shape that reads as an edge and is not one.
  const out = reg.decideSwitch(STATS({ n: 12, wins: 7, winRate: 7 / 12, expectancyPerContract: 40 }), RULES());
  assert.equal(out.recommend, 'insufficient');
  assert.match(out.reason, /spans a coin, an edge and a disaster/);
  assert.ok(out.ci.lo < 0.35, 'the interval must show how little 12 trades say');
});

test('enough data with the interval still below break-even is OFF', () => {
  const out = reg.decideSwitch(STATS({ n: 40, wins: 13, winRate: 13 / 40, expectancyPerContract: -8 }), RULES());
  assert.equal(out.recommend, 'off');
  assert.equal(out.bar.breakevenWinRate, 0.333);   // rounded to 3dp for the UI
  assert.match(out.reason, /GOOD end of the interval/);
});

test('a winning rate with negative expectancy is still OFF', () => {
  const out = reg.decideSwitch(STATS({ n: 40, wins: 30, winRate: 0.75, expectancyPerContract: -3 }), RULES());
  assert.equal(out.recommend, 'off');
  assert.match(out.reason, /fee-paying machine/);
});

test('only a lower bound above break-even AND positive expectancy recommends ON', () => {
  const out = reg.decideSwitch(STATS({ n: 60, wins: 42, winRate: 0.7, expectancyPerContract: 55 }), RULES());
  assert.equal(out.recommend, 'on');
  assert.ok(out.ci.lo > out.bar.breakevenWinRate);
  assert.match(out.reason, /Recorded evidence, not an opinion/);
});

test('the payoff reads the real rules.json shape (playbooks.targetR), not a constant', () => {
  // rules.json keeps spec numbers under `playbooks`; a hardcoded 2 here would
  // silently disagree with the app's own target the moment he changes it.
  assert.equal(reg.decideSwitch(STATS({ n: 5, wins: 3, winRate: 0.6, expectancyPerContract: 10 }), realRules).bar.payoff, 2);
  const r = RULES({ playbooks: { targetR: 3 } });
  const out = reg.decideSwitch(STATS({ n: 5, wins: 3, winRate: 0.6, expectancyPerContract: 10 }), r);
  assert.equal(out.bar.payoff, 3);
  assert.equal(out.bar.breakevenWinRate, 0.25);
});

test('decideSwitch reads n as a number and reports a winRate given as a count', () => {
  const out = reg.decideSwitch({ n: 50, wins: 35, expectancyPerContract: 20 }, RULES());
  assert.equal(out.recommend, 'on');
  assert.equal(out.ci.p, 0.7);
});

test('describeEntry never claims an unknown playbook is wired', () => {
  const line = reg.describeEntry(reg.entryFor(RULES({ playbookRegistry: { 'D-SWEEP': { enabled: true } } }), 'D-SWEEP'), null);
  assert.match(line, /no detector yet/);
});

test('describeEntry reports the gate as locked on, not as ON', () => {
  // The parens are literal text, not a regex group — assert on the words.
  assert.match(reg.describeEntry(reg.entryFor(realRules, 'C'), null), /validity gate .locked on./);
});
