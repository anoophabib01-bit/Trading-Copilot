'use strict';
// Tests for autonomy-modes.js — the per-mode config layer added 2026-08-29.
//
// The properties worth testing here are the ones that protect real money: that
// a config edit can only ever TIGHTEN risk, that a mode which is not switched
// on cannot be entered, and that OFF/SHADOW are incapable of executing no
// matter what the config says.
const test = require('node:test');
const assert = require('node:assert');
const m = require('../autonomy-modes.js');

// A minimal rules object in the real shape, so these tests do not depend on the
// live rules.json (which Anoop edits) staying at any particular value.
function rules(overrides) {
  return Object.assign({
    perTradeMaxLoss: 300,
    autonomyEnabled: true,
    autonomyModes: {
      shadow: { enabled: true, silent: true, sizes: [2], perTradeRiskCapUsd: null },
      assist: { enabled: true, sizes: [2], perTradeRiskCapUsd: null },
      control: {
        enabled: true, sizes: [2], perTradeRiskCapUsd: 200,
        dailyLossCeilingUsd: 200, autoResetDaily: false,
        playbooks: ['A', 'B', 'LTF-ENGULF'],
      },
    },
  }, overrides || {});
}

// ── the four rungs ─────────────────────────────────────────────────────────

test('there are exactly four modes, in ladder order', () => {
  assert.deepEqual(m.MODES, ['off', 'shadow', 'assist', 'live']);
});

test('only ASSIST and CONTROL can execute — OFF and SHADOW never can', () => {
  assert.equal(m.canExecute('off'), false);
  assert.equal(m.canExecute('shadow'), false);
  assert.equal(m.canExecute('assist'), true);
  assert.equal(m.canExecute('live'), true);
});

test('an unknown mode reads as OFF, never as something permissive', () => {
  for (const bogus of ['LIVE!', 'control', 'auto', '', null, undefined, 42, {}]) {
    assert.equal(m.normaliseMode(bogus), 'off', `${JSON.stringify(bogus)} should normalise to off`);
  }
});

test("'control' is the CONFIG key but 'live' is the mode id — the two must map", () => {
  // state.json on disk and autonomy-gate both speak 'live'; rules.json speaks
  // 'control'. If this mapping breaks, a configured mode silently reads as
  // unconfigured and defaults to disabled.
  assert.equal(m.CONFIG_KEY.live, 'control');
  assert.equal(m.modeConfig(rules(), 'live').perTradeRiskCapUsd, 200);
});

// ── the safety property: config can only tighten ───────────────────────────

test('a mode config can NEVER loosen the global per-trade cap', () => {
  const evil = rules({ autonomyModes: { control: { enabled: true, perTradeRiskCapUsd: 99999 } } });
  assert.equal(m.riskCapUsd(evil, 'live'), 300, 'must clamp to the global perTradeMaxLoss');
});

test('a mode config CAN tighten the global cap', () => {
  assert.equal(m.riskCapUsd(rules(), 'live'), 200);
});

test('a mode with no cap of its own inherits the global one', () => {
  assert.equal(m.riskCapUsd(rules(), 'shadow'), 300);
  assert.equal(m.riskCapUsd(rules(), 'assist'), 300);
});

test('CONTROL refuses the widest real Playbook B setup and accepts the median', () => {
  // Measured over the cached bars (app/scripts/risk-dist.js): median 48.3pt =
  // $193 at 2 contracts, widest 72.8pt = $291. The $200 cap is what makes the
  // $200 daily ceiling a real ceiling rather than one a single stop-out
  // overshoots by 46%.
  assert.equal(m.checkOrderRisk(rules(), 'live', 193).allowed, true);
  assert.equal(m.checkOrderRisk(rules(), 'live', 291).allowed, false);
  assert.match(m.checkOrderRisk(rules(), 'live', 291).reason, /exceeds the \$200 per-trade limit for CONTROL/);
});

test('risk that cannot be computed is REFUSED, never assumed small', () => {
  for (const bad of [null, undefined, NaN, 'lots', {}]) {
    const r = m.checkOrderRisk(rules(), 'live', bad);
    assert.equal(r.allowed, false, `${JSON.stringify(bad)} must not be allowed`);
    assert.match(r.reason, /not computable/);
  }
});

// ── enablement ─────────────────────────────────────────────────────────────

test('the master kill switch beats every per-mode flag', () => {
  const off = rules({ autonomyEnabled: false });
  for (const mode of ['shadow', 'assist', 'live']) {
    assert.equal(m.isModeEnabled(off, mode), false, `${mode} must be disabled by the master switch`);
  }
  // OFF is always available — it is the fallback, not a feature.
  assert.equal(m.isModeEnabled(off, 'off'), true);
});

test('a per-mode flag can disable one mode while the others stay on', () => {
  const r = rules();
  r.autonomyModes.control.enabled = false;
  assert.equal(m.isModeEnabled(r, 'shadow'), true);
  assert.equal(m.isModeEnabled(r, 'assist'), true);
  assert.equal(m.isModeEnabled(r, 'live'), false);
});

test('enabled must be exactly true — a truthy typo does not arm a mode', () => {
  for (const typo of ['true', 1, 'yes', {}]) {
    const r = rules();
    r.autonomyModes.control.enabled = typo;
    assert.equal(m.isModeEnabled(r, 'live'), false, `${JSON.stringify(typo)} must not enable CONTROL`);
  }
});

test('a missing autonomyModes block behaves exactly like everything is off', () => {
  const bare = { perTradeMaxLoss: 300, autonomyEnabled: true };
  for (const mode of ['shadow', 'assist', 'live']) {
    assert.equal(m.isModeEnabled(bare, mode), false);
  }
  // ...and must not throw on the live path.
  assert.deepEqual(m.modeConfig(bare, 'shadow').sizes, [2]);
});

test('malformed rules never throw', () => {
  for (const bad of [null, undefined, 'nonsense', 42, []]) {
    assert.doesNotThrow(() => m.modeConfig(bad, 'live'));
    assert.doesNotThrow(() => m.isModeEnabled(bad, 'live'));
    assert.doesNotThrow(() => m.riskCapUsd(bad, 'live'));
  }
});

// ── sizes ──────────────────────────────────────────────────────────────────

test('sizes default to [2] — the real sizeCap and sizeFloor', () => {
  assert.deepEqual(m.sizesFor(rules(), 'shadow'), [2]);
  assert.deepEqual(m.sizesFor(rules(), 'live'), [2]);
});

test('an empty or garbage sizes list falls back rather than recording nothing', () => {
  // Recording nothing is the failure that cost shadow its entire track record:
  // the old [4,6] made every order unrecordable and the folder stayed empty
  // while looking configured.
  for (const junk of [[], ['x'], [0], [-2], [2.5], null]) {
    const r = rules();
    r.autonomyModes.shadow.sizes = junk;
    assert.deepEqual(m.sizesFor(r, 'shadow'), [2], `${JSON.stringify(junk)} should fall back to [2]`);
  }
});

test('valid multi-size configs are preserved', () => {
  const r = rules();
  r.autonomyModes.shadow.sizes = [1, 2, 4];
  assert.deepEqual(m.sizesFor(r, 'shadow'), [1, 2, 4]);
});

// ── silence ────────────────────────────────────────────────────────────────

test('SHADOW is silent by default; the executing modes are not', () => {
  assert.equal(m.isSilent(rules(), 'shadow'), true);
  assert.equal(m.isSilent(rules(), 'assist'), false);
  assert.equal(m.isSilent(rules(), 'live'), false);
});

test('shadow silence can be turned off explicitly', () => {
  const r = rules();
  r.autonomyModes.shadow.silent = false;
  assert.equal(m.isSilent(r, 'shadow'), false);
});

// ── playbooks ──────────────────────────────────────────────────────────────

test('CONTROL trades only the playbooks on its allowlist', () => {
  assert.equal(m.isPlaybookAllowed(rules(), 'live', 'A'), true);
  assert.equal(m.isPlaybookAllowed(rules(), 'live', 'B'), true);
  assert.equal(m.isPlaybookAllowed(rules(), 'live', 'LTF-ENGULF'), true);
  assert.equal(m.isPlaybookAllowed(rules(), 'live', 'C-ADX'), false);
});

// 2026-09-01: a 'C' arriving at the gate is an engulf SETUP, never the
// validity gate. It used to alias to LTF-ENGULF; every always-on engulf
// watcher is Playbook A now, so both 'C' and the retired id resolve there.
test("the UI's 'C' is an engulf setup and resolves to Playbook A through the alias", () => {
  // playbook-spec marks the real Playbook C isGate:true and planEntry refuses
  // it, so a 'C' arriving at an execution gate is always the engulf setup.
  assert.equal(m.isPlaybookAllowed(rules(), 'live', 'C'), true);
});

test('a missing playbook list does NOT silently mean "all playbooks"', () => {
  // It means "no per-mode restriction configured" and defers to the caller's
  // own gates — a dropped config key must not widen the grant on its own.
  const r = rules();
  delete r.autonomyModes.control.playbooks;
  // Falls back to the module defaults.
  assert.equal(m.isPlaybookAllowed(r, 'live', 'C-ADX'), false);
});

// ── labels ─────────────────────────────────────────────────────────────────

test('labels never drift between a badge and a log line', () => {
  assert.equal(m.label('off'), 'MYSELF');
  assert.equal(m.label('shadow'), 'SHADOW');
  assert.equal(m.label('assist'), 'ASSIST');
  assert.equal(m.label('live'), 'CONTROL');
  assert.equal(m.label('garbage'), 'MYSELF');
});
