'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../autonomy-store.js');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-'));
  return d;
}

test('a fresh install reads as OFF, never as anything else', () => {
  const d = tmp();
  const st = store.readState(d);
  assert.equal(st.mode, 'off');
  assert.equal(st.armedBy, null);
  assert.equal(st.shadowDays, 0);
});

test('a CORRUPT state file reads as OFF rather than as whatever it last was', () => {
  const d = tmp();
  store.ensureDir(d);
  fs.writeFileSync(path.join(d, 'autonomy', 'state.json'), '{not json', 'utf8');
  assert.equal(store.readState(d).mode, 'off');
});

test('state survives a write/read round trip', () => {
  const d = tmp();
  store.writeState(d, { mode: 'shadow', armedBy: 'anoop', shadowDays: 3 });
  const st = store.readState(d);
  assert.equal(st.mode, 'shadow');
  assert.equal(st.armedBy, 'anoop');
  assert.equal(st.shadowDays, 3);
});

// ── shadowDays must not be inflatable ───────────────────────────────────────
test('the same trading day counts once, no matter how many times it is marked', () => {
  const d = tmp();
  store.writeState(d, { mode: 'shadow' });
  for (let i = 0; i < 10; i++) store.markShadowDay(d, '2026-08-26');
  assert.equal(store.readState(d).shadowDays, 1, 'restarting the app must not earn shadow days');
});

test('a new day increments once', () => {
  const d = tmp();
  store.markShadowDay(d, '2026-08-26');
  store.markShadowDay(d, '2026-08-27');
  store.markShadowDay(d, '2026-08-27');
  assert.equal(store.readState(d).shadowDays, 2);
});

// ── the record ──────────────────────────────────────────────────────────────
test('decisions are appended, including refusals', () => {
  const d = tmp();
  store.recordDecision(d, { kind: 'mode-request', requested: 'live', effective: 'shadow', allowed: false, blockers: ['a', 'b'] });
  store.recordDecision(d, { kind: 'mode-request', requested: 'shadow', effective: 'shadow', allowed: true, blockers: [] });
  const rows = store.readRootJsonl(d, 'decisions.jsonl');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].allowed, false);
  assert.deepEqual(rows[0].blockers, ['a', 'b']);
  assert.ok(rows[0].ts, 'every decision is timestamped');
});

test('a shadow order is recorded as NOT submitted by default', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'x|B|s1|2c', playbook: 'B', direction: 'BULLISH', entry: 100 });
  const [row] = store.readJsonl(d, 'shadow', 'orders.jsonl');
  assert.equal(row.submitted, false, 'a reader must never have to infer whether real money moved');
});

test('a corrupt line costs one line, not the file', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { playbook: 'B', netUsd: 10 });
  fs.appendFileSync(path.join(d, 'autonomy', 'shadow', 'orders.jsonl'), '{broken\n', 'utf8');
  store.recordOrder(d, 'shadow', { playbook: 'B', netUsd: 20 });
  assert.equal(store.readJsonl(d, 'shadow', 'orders.jsonl').length, 2);
});

// ── evidence: what LIVE is judged on ────────────────────────────────────────
test('unresolved orders are EXCLUDED, never counted as scratches', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { playbook: 'B', resolved: true, netUsd: 100 });
  store.recordOrder(d, 'shadow', { playbook: 'B', resolved: false });
  store.recordOrder(d, 'shadow', { playbook: 'B', resolved: false });
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 1);
});

test('profit factor is null with no losses — never Infinity, never a fabricated pass', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { playbook: 'B', resolved: true, netUsd: 50 });
  const ev = store.evidence(d, 'shadow', 'B');
  assert.equal(ev.profitFactor, null);
  assert.notEqual(ev.profitFactor, Infinity);
});

test('profit factor and drawdown are computed from the equity path', () => {
  const d = tmp();
  for (const n of [100, -50, -50, 200]) store.recordOrder(d, 'shadow', { playbook: 'B', resolved: true, netUsd: n });
  const ev = store.evidence(d, 'shadow', 'B');
  assert.equal(ev.resolvedTrades, 4);
  assert.equal(ev.profitFactor, 3);          // 300 won / 100 lost
  assert.equal(ev.netUsd, 200);
  assert.equal(ev.maxDrawdownUsd, 100);      // peak 100 -> trough 0
});

test('evidence is scoped per playbook and never borrows another', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { playbook: 'B', resolved: true, netUsd: 100 });
  store.recordOrder(d, 'shadow', { playbook: 'A', resolved: true, netUsd: -100 });
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 1);
  assert.equal(store.evidence(d, 'shadow', 'A').netUsd, -100);
  assert.equal(store.evidence(d, 'shadow', 'NOPE').resolvedTrades, 0);
});

test('an empty store yields zero evidence, which blocks LIVE rather than passing it', () => {
  const d = tmp();
  const ev = store.evidence(d, 'shadow', 'B');
  assert.equal(ev.resolvedTrades, 0);
  assert.equal(ev.profitFactor, null);
  const gate = require('../autonomy-gate.js');
  const r = gate.evaluate({ mode: 'live', armedBy: 'anoop', shadowDays: 99 }, { ...ev, accountDrawdownLimitUsd: 2000 });
  assert.equal(r.allowed, false);
});

// ── daily rollup ────────────────────────────────────────────────────────────
test('the daily rollup counts only that day and writes a file', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { day: '2026-08-26', contracts: 4, playbook: 'B', resolved: true, netUsd: 100 });
  store.recordOrder(d, 'shadow', { day: '2026-08-26', contracts: 4, playbook: 'B', resolved: true, netUsd: -40 });
  store.recordOrder(d, 'shadow', { day: '2026-08-27', contracts: 4, playbook: 'B', resolved: true, netUsd: 999 });
  const sum = store.rollupDay(d, 'shadow', '2026-08-26');
  const four = sum.sizes.find((s) => s.contracts === 4);
  assert.equal(four.resolved, 2);
  assert.equal(four.netUsd, 60);
  assert.equal(four.profitFactor, 2.5);
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'shadow', 'daily', '2026-08-26.json')));
});

test('the SAME signal at two sizes is never summed into one day P&L', () => {
  // 10 setups recorded at 4c and 6c must not report as one account making the
  // sum of both. Caught on the first real run: +$3,638 and +$5,457 rendered
  // as a single +$9,095 day.
  const d = tmp();
  for (const c of [4, 6]) {
    store.recordOrder(d, 'shadow', { day: '2026-08-26', contracts: c, setupId: 's1', playbook: 'B', resolved: true, netUsd: 100 * c });
  }
  const sum = store.rollupDay(d, 'shadow', '2026-08-26');
  assert.equal(sum.setupsFired, 1, 'one setup, recorded twice, is still one setup');
  assert.equal(sum.ordersRecorded, 2);
  assert.equal(sum.sizes.length, 2);
  assert.equal(sum.sizes.find((s) => s.contracts === 4).netUsd, 400);
  assert.equal(sum.sizes.find((s) => s.contracts === 6).netUsd, 600);
  assert.equal(sum.netUsd, undefined, 'there must be no single combined figure to misread');
});

test('everything is written under autonomy/ and nowhere else', () => {
  const d = tmp();
  store.writeState(d, { mode: 'shadow' });
  store.recordDecision(d, { kind: 'x' });
  store.recordOrder(d, 'shadow', { playbook: 'B' });
  store.rollupDay(d, 'shadow', '2026-08-26');
  assert.deepEqual(fs.readdirSync(d), ['autonomy'], 'no stray files outside the folder');
});

// ── Production bugs found on the first real shadow day (2026-08-26) ─────────
test('an order the risk rules would refuse never counts toward the track record', () => {
  // The real first shadow order was a 79.5pt stop = $636 risk at 4c against a
  // $300 limit. Counting it would build LIVE's evidence from impossible trades.
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'a', day: 'D', contracts: 4, playbook: 'B', riskUsd: 636, blocked: 'risk-too-big' });
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'b', day: 'D', contracts: 4, playbook: 'B', riskUsd: 200 });
  store.recordOutcome(d, 'shadow', { id: 'a', netUsd: 5000 });   // even a huge win must not count
  store.recordOutcome(d, 'shadow', { id: 'b', netUsd: 100 });
  const ev = store.evidence(d, 'shadow', 'B', 4);
  assert.equal(ev.resolvedTrades, 1, 'only the tradeable order counts');
  assert.equal(ev.netUsd, 100);
});

test('a blocked order is never handed to the resolver', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'a', playbook: 'B', blocked: 'risk-too-big' });
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'b', playbook: 'B' });
  const pending = store.pendingMachineOrders(d, 'shadow');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'b');
});

test('the daily rollup surfaces the blocked count rather than hiding it', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'a', day: 'D', contracts: 4, blocked: 'risk-too-big' });
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'b', day: 'D', contracts: 4 });
  const sum = store.rollupDay(d, 'shadow', 'D');
  assert.equal(sum.blockedByRisk, 1);
  assert.equal(sum.ordersRecorded, 1);
});

// ── The per-mode risk filter (2026-08-29) ──────────────────────────────────
// SHADOW records under the global $300 per-trade cap; CONTROL runs at $200.
// Promoting CONTROL on an unfiltered shadow record would grant it on a track
// record containing trades it is forbidden to place — the same class of error
// as counting `blocked` rows toward the profit factor.
// See AUTONOMY_MODES_SPEC.md §8.1.

function resolvedOrder(d, id, riskUsd, netUsd) {
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id, playbook: 'B', contracts: 2, riskUsd });
  store.recordOutcome(d, 'shadow', { id, playbook: 'B', contracts: 2, netUsd, outcome: netUsd > 0 ? 'target' : 'stop' });
}

test('evidence read under a cap excludes orders that breach it', () => {
  const d = tmp();
  resolvedOrder(d, 'in-1', 155, 300);    // within CONTROL's $200
  resolvedOrder(d, 'in-2', 193, 300);    // within
  resolvedOrder(d, 'over', 291, -580);   // SHADOW would record it; CONTROL may not place it

  const unfiltered = store.evidence(d, 'shadow', 'B');
  assert.equal(unfiltered.resolvedTrades, 3);

  const forControl = store.evidence(d, 'shadow', 'B', null, { maxRiskUsd: 200 });
  assert.equal(forControl.resolvedTrades, 2, 'the $291 order must not count toward CONTROL');
  assert.equal(forControl.maxRiskUsd, 200, 'the cap is echoed back so an empty result is explicable');
});

test('the excluded loser does not flatter the profit factor it was excluded from', () => {
  const d = tmp();
  resolvedOrder(d, 'in-1', 155, 300);
  resolvedOrder(d, 'over', 291, -580);
  // Unfiltered: one win, one big loss. Filtered: only the win remains, so the
  // loss cannot be laundered out of a record CONTROL is judged on by accident
  // — it is excluded because CONTROL could not have taken it at all.
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 2);
  assert.equal(store.evidence(d, 'shadow', 'B', null, { maxRiskUsd: 200 }).resolvedTrades, 1);
});

test('an order with NO risk figure is excluded under a cap, never treated as $0', () => {
  // Number(null) is 0 and 0 passes every cap, so a naive coercion would count
  // an unknown-risk order as the safest trade in the file.
  const d = tmp();
  resolvedOrder(d, 'known', 155, 100);
  resolvedOrder(d, 'unknown', null, 100);
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 2, 'both count with no cap applied');
  assert.equal(store.evidence(d, 'shadow', 'B', null, { maxRiskUsd: 200 }).resolvedTrades, 1,
    'the unknown-risk order must be excluded, not assumed to fit');
});

test('with no cap supplied the filter is inert — existing callers are unaffected', () => {
  const d = tmp();
  resolvedOrder(d, 'a', 291, 100);
  resolvedOrder(d, 'b', null, 100);
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 2);
  assert.equal(store.evidence(d, 'shadow', 'B').maxRiskUsd, null);
});

// ── Per-mode folders (2026-08-29) ──────────────────────────────────────────
// Anoop: "each mode should have separate folder to avoid confusion." The
// property that matters is not tidiness — it is that one mode's track record
// can never be read as another's, because that is what a promotion is granted
// on. See autonomy-store's header and AUTONOMY_MODES_SPEC.md §4.

test('each mode writes to its own folder, and control maps to control/', () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 's1', playbook: 'B' });
  store.recordOrder(d, 'assist', { kind: 'machine-order', id: 'a1', playbook: 'B' });
  store.recordOrder(d, 'live', { kind: 'machine-order', id: 'c1', playbook: 'B' });
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'shadow', 'orders.jsonl')));
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'assist', 'orders.jsonl')));
  // The mode id is 'live'; the folder is 'control', matching the UI and rules.json.
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'control', 'orders.jsonl')));
});

test("one mode's orders are invisible to another — no filtering required", () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 's1', playbook: 'B', riskUsd: 100 });
  store.recordOrder(d, 'live', { kind: 'machine-order', id: 'c1', playbook: 'B', riskUsd: 100 });
  store.recordOutcome(d, 'shadow', { id: 's1', netUsd: 500 });
  store.recordOutcome(d, 'live', { id: 'c1', netUsd: -500 });

  // If these shared a file, reading either would need a filter someone has to
  // remember to apply — and forgetting once promotes a system on the wrong record.
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 1);
  assert.equal(store.evidence(d, 'shadow', 'B').netUsd, 500);
  assert.equal(store.evidence(d, 'live', 'B').resolvedTrades, 1);
  assert.equal(store.evidence(d, 'live', 'B').netUsd, -500);
});

test("a mode's outcome cannot resolve another mode's order", () => {
  const d = tmp();
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'same-id', playbook: 'B' });
  store.recordOutcome(d, 'live', { id: 'same-id', netUsd: 999 });
  // Same id, different folder: shadow's order stays unresolved rather than
  // picking up a result produced by a different system.
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 0);
  assert.equal(store.pendingMachineOrders(d, 'shadow').length, 1);
});

test('every order is stamped with the mode that wrote it', () => {
  const d = tmp();
  store.recordOrder(d, 'live', { kind: 'machine-order', id: 'c1' });
  assert.equal(store.readJsonl(d, 'live', 'orders.jsonl')[0].mode, 'live');
});

test('an unknown mode falls back to shadow rather than throwing on the live path', () => {
  const d = tmp();
  assert.doesNotThrow(() => store.recordOrder(d, 'nonsense', { kind: 'machine-order', id: 'x' }));
  assert.equal(store.readJsonl(d, 'shadow', 'orders.jsonl').length, 1);
});

test('human trades are ONE stream, not filed under whichever mode was running', () => {
  const d = tmp();
  store.recordHumanTrade(d, { pnl: 100, fingerprint: 'a' });
  store.recordHumanTrade(d, { pnl: -50, fingerprint: 'b' });
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'human', 'trades.jsonl')));
  assert.equal(store.readHumanTrades(d).length, 2);
  // ...and they never contaminate a mode's machine track record.
  assert.equal(store.evidence(d, 'shadow').resolvedTrades, 0);
});

test('approvals and interventions land in their own files, not in orders.jsonl', () => {
  const d = tmp();
  store.recordApproval(d, { decision: 'refused', setupId: 's1' });
  store.recordIntervention(d, { kind: 'breaker-trip', reason: 'daily loss ceiling' });
  assert.equal(store.readJsonl(d, 'assist', 'approvals.jsonl').length, 1);
  assert.equal(store.readJsonl(d, 'live', 'interventions.jsonl').length, 1);
  // An intervention is not a trade and must never be counted as one.
  assert.equal(store.readJsonl(d, 'live', 'orders.jsonl').length, 0);
});

// ── the one-time migration ─────────────────────────────────────────────────

function writeLegacy(d, rows, outcomes) {
  const root = path.join(d, 'autonomy');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'shadow-orders.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (outcomes) {
    fs.writeFileSync(path.join(root, 'shadow-outcomes.jsonl'),
      outcomes.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
}

test('migration splits the old flat file into machine orders and human trades', () => {
  const d = tmp();
  writeLegacy(d, [
    { kind: 'machine-order', id: 'm1', playbook: 'B', riskUsd: 150 },
    { kind: 'human-trade', pnl: 42, fingerprint: 'h1' },
    { kind: 'human-trade', pnl: -13, fingerprint: 'h2' },
  ], [{ id: 'm1', netUsd: 300 }]);

  const r = store.migrateLegacyLayout(d, { stamp: 'test' });
  assert.equal(r.ran, true);
  assert.equal(r.machineOrders, 1);
  assert.equal(r.humanTrades, 2);
  assert.equal(r.outcomes, 1);

  assert.equal(store.readJsonl(d, 'shadow', 'orders.jsonl').length, 1);
  assert.equal(store.readHumanTrades(d).length, 2);
  assert.equal(store.evidence(d, 'shadow', 'B').resolvedTrades, 1);
});

test('migration is NON-DESTRUCTIVE — the legacy files are renamed, never deleted', () => {
  const d = tmp();
  writeLegacy(d, [{ kind: 'machine-order', id: 'm1' }]);
  store.migrateLegacyLayout(d, { stamp: 'test' });
  const root = path.join(d, 'autonomy');
  assert.equal(fs.existsSync(path.join(root, 'shadow-orders.jsonl')), false, 'moved out of the way');
  assert.ok(fs.existsSync(path.join(root, 'shadow-orders.jsonl.test')), 'but kept, so an undo is one rename');
});

test('migration is idempotent — a second run cannot double the track record', () => {
  const d = tmp();
  writeLegacy(d, [{ kind: 'machine-order', id: 'm1', riskUsd: 100 }], [{ id: 'm1', netUsd: 200 }]);
  store.migrateLegacyLayout(d, { stamp: 'test' });
  const after = store.readJsonl(d, 'shadow', 'orders.jsonl').length;
  const second = store.migrateLegacyLayout(d, { stamp: 'test2' });
  assert.equal(second.ran, false);
  assert.equal(store.readJsonl(d, 'shadow', 'orders.jsonl').length, after);
});

test('migration refuses to merge into an already-populated new layout', () => {
  const d = tmp();
  // New layout already has data (e.g. a session ran before the migration did).
  store.recordOrder(d, 'shadow', { kind: 'machine-order', id: 'live-row' });
  writeLegacy(d, [{ kind: 'machine-order', id: 'legacy-row' }]);
  const r = store.migrateLegacyLayout(d, { stamp: 'test' });
  assert.equal(r.ran, false);
  assert.ok(r.notes.some((n) => /already populated/.test(n)));
  // The legacy file is left exactly where it was for a human to look at.
  assert.ok(fs.existsSync(path.join(d, 'autonomy', 'shadow-orders.jsonl')));
  assert.equal(store.readJsonl(d, 'shadow', 'orders.jsonl').length, 1);
});

test('migration on a fresh install is a silent no-op', () => {
  const d = tmp();
  const r = store.migrateLegacyLayout(d, { stamp: 'test' });
  assert.equal(r.ran, false);
  assert.deepEqual(r.notes, []);
});

test('a legacy row with no `kind` is treated as a machine order, not dropped', () => {
  // Rows written before the human/machine split carry no kind. Discarding
  // history to simplify a filter is how a track record quietly shrinks.
  const d = tmp();
  writeLegacy(d, [{ id: 'old', playbook: 'B', riskUsd: 100 }]);
  const r = store.migrateLegacyLayout(d, { stamp: 'test' });
  assert.equal(r.machineOrders, 1);
  assert.equal(r.humanTrades, 0);
});
