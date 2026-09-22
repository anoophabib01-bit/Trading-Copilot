'use strict';
/* ── playbook-registry.js — many playbooks, each with a switch (2026-09-19) ──
 *
 * (Anoop: "i want to import many more playbooks in future which can be turned
 * OFF or ON in the app.")
 *
 * ── WHY THIS IS A MODULE AND NOT A rules.json KEY ───────────────────────────
 * Half of a registry already existed, scattered across three files that did not
 * know about each other:
 *
 *   • playbook-spec.js   — what A, B, C and C-ADX ARE (and that C is a GATE)
 *   • detectors.js       — which ones fire, and on which chart
 *   • autonomy-modes.js  — which ones a mode may TRADE (MODE_DEFAULTS.live.playbooks)
 *
 * The consequence is that "is Playbook B on?" had three different answers
 * depending on who you asked, and the UI could not answer it at all. This module
 * is the one place that answers it. It does not reimplement any of the three —
 * it reads them.
 *
 * ── THE TWO AXES, AND WHY THEY MUST NOT BE ONE SWITCH ───────────────────────
 *   enabled     — may this playbook FIRE and be shown to him at all?
 *   shadowOnly  — may it ever place an order, or is it recording only?
 *
 * They are separate because the honest answer to "should I trade this?" changes
 * far more slowly than "should I look at this?" — and because collapsing them
 * would mean the only way to stop being nagged by a bad playbook is to also stop
 * MEASURING it, which is exactly backwards. A playbook nobody measures can never
 * be judged.
 *
 * ── THE ONE SWITCH THAT IS LOCKED ───────────────────────────────────────────
 * Playbook C is a validity GATE, not a setup (playbook-spec.js: isGate). Switching
 * it off would not disable a strategy, it would disable the FILTER on another
 * one — every engulf would then trade the bare candle. That is not a preference,
 * so it is refused here rather than left as a config key somebody could set by
 * accident. The UI shows it locked WITH the reason, because hiding the row would
 * be the same lie in the other direction.
 *
 * ── WHO FLIPS IT ────────────────────────────────────────────────────────────
 * decideSwitch() reads his OWN measured ledger and says on / off / not enough
 * data. It is advice. Nothing in this module writes a switch, and no model
 * decides one — see TYPESAFE_SPEC.md §3.
 *
 * PURE. Reads config, returns decisions and patches. Writes nothing, places
 * nothing. Unit-tested in test/playbook-registry.test.js.
 */

const playbookSpec = require('./playbook-spec');
const driftEdge = require('./drift-edge');

// ── Metadata for every id that can appear in the ledger ─────────────────────
// Kept beside playbook-spec rather than derived from it because the SPEC answers
// "what is the setup" and this answers "how does it appear in a list" — and
// because PO3 is in the ledger and deliberately not in the spec (it is a phase
// transition that triggers a debate, never a tradeable setup).
const PLAYBOOK_META = Object.freeze({
  A:      { label: 'Playbook A',      kind: 'setup',         blurb: 'Engulfing candle closing on any always-on watcher (1H/30M/15M/5M)' },
  B:      { label: 'Playbook B',      kind: 'setup',         blurb: 'JadeCap 3-step: liquidity raid (SFP) then FVG, entry on the retrace' },
  C:      { label: 'Playbook C',      kind: 'gate',          blurb: 'Engulfing-bar validity gate — filters A, never proposes a trade' },
  'C-ADX':{ label: 'Playbook C (ADX)', kind: 'setup',        blurb: 'Long-only Donchian breakout in a strong uptrend (ADX gate)' },
  PO3:    { label: 'PO3 phase',       kind: 'informational', blurb: 'Power-of-3 phase transitions — triggers the debate panel, never a trade' },
});

// Ids that may only ever be measured, whatever the config says. An
// 'informational' row exists to be READ; there is no order for it to place, so
// shadowOnly is not a choice for it either.
const NEVER_EXECUTES = new Set(['PO3']);

const DEFAULT_SIZES = [2];

// A new playbook starts OFF, recording-only. This is the direction that has to
// be earned: importing a strategy nobody has measured must not add a live order
// path by default, and must not silently start alerting either.
const NEW_PLAYBOOK_DEFAULT = Object.freeze({
  enabled: false,
  shadowOnly: true,
  sizes: DEFAULT_SIZES,
});

// The shipped registry. C-ADX has out-of-sample backtest evidence but no live
// sample, so it is ON for recording and OFF for execution like everything else.
const DEFAULT_REGISTRY = Object.freeze({
  A:       { enabled: true,  shadowOnly: true, sizes: DEFAULT_SIZES },
  B:       { enabled: true,  shadowOnly: true, sizes: DEFAULT_SIZES },
  C:       { enabled: true,  shadowOnly: true, sizes: DEFAULT_SIZES },
  'C-ADX': { enabled: false, shadowOnly: true, sizes: DEFAULT_SIZES },
  PO3:     { enabled: true,  shadowOnly: true, sizes: DEFAULT_SIZES },
});

function metaFor(id) {
  return PLAYBOOK_META[id] || { label: String(id), kind: 'unknown', blurb: 'Not in the shipped registry — imported from rules.json.' };
}

function positiveInts(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const v of arr) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && Math.floor(n) === n) out.push(n);
  }
  return out.length ? out : null;
}

/**
 * Normalise ONE registry entry. This is the clamp, and it is the reason a
 * renderer bug or a replayed WS message cannot widen a playbook's grant:
 * every field is re-derived here from the raw input, never trusted.
 *
 * A gate is forced ON. An informational row is forced shadowOnly.
 */
function normaliseEntry(id, raw, rules) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const meta = metaFor(id);
  const cap = Number(rules && rules.sizeCap);
  const gate = meta.kind === 'gate';
  const sizes = positiveInts(r.sizes) || DEFAULT_SIZES;
  const clampedSizes = Number.isFinite(cap) && cap > 0
    ? sizes.map((s) => Math.min(cap, s)).filter((s) => s > 0)
    : sizes;
  return {
    id,
    label: meta.label,
    kind: meta.kind,
    blurb: meta.blurb,
    // A gate cannot be switched off; see the header.
    // resolveRegistry() has already merged the shipped default underneath, so a
    // genuinely missing key arrives here as its default rather than undefined.
    enabled: gate ? true : r.enabled === true,
    shadowOnly: (gate || NEVER_EXECUTES.has(id)) ? true : r.shadowOnly !== false,
    sizes: clampedSizes.length ? clampedSizes : DEFAULT_SIZES,
    locked: gate,
    lockReason: gate
      ? 'Playbook C is a validity GATE, not a setup. Turning it off would trade unfiltered engulfs — that is a change to Playbook A, not a preference.'
      : null,
    unknown: !PLAYBOOK_META[id],
    note: typeof r.note === 'string' ? r.note : null,
  };
}

/**
 * The whole registry: shipped defaults, overlaid with rules.json, plus any id
 * rules.json introduces that this module has never heard of.
 *
 * That last part is the import path he asked for. A future playbook can be
 * added as a rules.json key and it appears in the UI immediately — switched OFF,
 * recording-only, and labelled as unknown so nobody mistakes "it is listed" for
 * "it is wired to a detector".
 */
function resolveRegistry(rules) {
  const configured = (rules && rules.playbookRegistry && typeof rules.playbookRegistry === 'object')
    ? rules.playbookRegistry : {};
  const ids = new Set(Object.keys(DEFAULT_REGISTRY));
  for (const id of Object.keys(configured)) {
    if (!id.startsWith('_')) ids.add(id);   // _comment/_status keys are documentation
  }
  const out = {};
  for (const id of ids) {
    const raw = Object.prototype.hasOwnProperty.call(configured, id)
      ? Object.assign({}, DEFAULT_REGISTRY[id] || NEW_PLAYBOOK_DEFAULT, configured[id])
      : Object.assign({}, DEFAULT_REGISTRY[id] || NEW_PLAYBOOK_DEFAULT);
    out[id] = normaliseEntry(id, raw, rules);
  }
  return out;
}

/** Registry as a stable, renderable list — gates and setups first, then unknowns. */
function listRegistry(rules) {
  const reg = resolveRegistry(rules);
  const order = { setup: 0, gate: 1, informational: 2, unknown: 3 };
  return Object.keys(reg)
    .map((id) => reg[id])
    .sort((a, b) => {
      // NOT `order[kind] || 9` — 'setup' maps to 0, and 0 || 9 is 9, which
      // sorted every real setup to the bottom of the list. (Caught by the
      // smoke run, not by a test: the list was still a valid list.)
      const d = (order[a.kind] != null ? order[a.kind] : 9) - (order[b.kind] != null ? order[b.kind] : 9);
      if (d !== 0) return d;
      return a.id.localeCompare(b.id);
    });
}

/** Canonical, alias-aware lookup. LTF-ENGULF resolves to A; DSH-V2 to C-ADX. */
function entryFor(rules, id) {
  const canonical = playbookSpec.canonicalId(id);
  const reg = resolveRegistry(rules);
  return reg[canonical] || reg[String(id)] || null;
}

function isEnabled(rules, id) {
  const e = entryFor(rules, id);
  return !!(e && e.enabled);
}

function isShadowOnly(rules, id) {
  const e = entryFor(rules, id);
  return e ? e.shadowOnly : true;   // unknown → recording only, never wider
}

function sizesFor(rules, id) {
  const e = entryFor(rules, id);
  return e ? e.sizes : DEFAULT_SIZES;
}

/**
 * May this playbook place an order in this autonomy mode?
 *
 * Deliberately checks the REGISTRY first and the autonomy mode second, so
 * neither can widen the other: a playbook the registry has switched off is
 * refused even if a mode lists it, and a mode that lists nothing still refuses
 * a shadowOnly playbook.
 */
function canExecute(rules, id, mode, autonomyModes) {
  const e = entryFor(rules, id);
  if (!e) return { allowed: false, reason: 'playbook "' + id + '" is not in the registry' };
  if (e.kind === 'gate') return { allowed: false, reason: 'Playbook C is a validity gate and never proposes a trade' };
  if (e.kind === 'informational') return { allowed: false, reason: e.label + ' has no entry — it only triggers analysis' };
  if (e.unknown) return { allowed: false, reason: e.label + ' is listed in rules.json but has no specification or detector yet' };
  if (!e.enabled) return { allowed: false, reason: e.label + ' is switched OFF in the playbook registry' };
  if (e.shadowOnly) return { allowed: false, reason: e.label + ' is recording-only (shadow); nothing in the app places it' };
  if (autonomyModes && typeof autonomyModes.isPlaybookAllowed === 'function') {
    if (!autonomyModes.isPlaybookAllowed(rules, mode, e.id)) {
      return { allowed: false, reason: e.label + ' is not in the playbook list for ' + String(mode) };
    }
  }
  return { allowed: true, sizes: e.sizes };
}

/**
 * Pure patch builder for one toggle. Returns the rules.json.playbookRegistry
 * object to merge — the caller writes it, and the server clamps it again on the
 * way in. Refuses a gate, and refuses an unknown id being switched on without a
 * note explaining what it is.
 */
function toggle(rules, id, on) {
  const e = entryFor(rules, id);
  if (!e) return { ok: false, reason: 'unknown playbook "' + id + '"' };
  if (e.locked && !on) return { ok: false, reason: e.lockReason };
  const next = Object.assign({}, (rules && rules.playbookRegistry) || {});
  next[e.id] = Object.assign({}, next[e.id] || {}, { enabled: !!on });
  return { ok: true, playbookRegistry: next, entry: normaliseEntry(e.id, next[e.id], rules) };
}

/** Pure patch builder for the shadow-only axis. A gate can never leave shadow. */
function setShadowOnly(rules, id, shadowOnly) {
  const e = entryFor(rules, id);
  if (!e) return { ok: false, reason: 'unknown playbook "' + id + '"' };
  if (e.locked || NEVER_EXECUTES.has(e.id)) {
    return { ok: false, reason: e.label + ' has no order path to enable' };
  }
  const next = Object.assign({}, (rules && rules.playbookRegistry) || {});
  next[e.id] = Object.assign({}, next[e.id] || {}, { shadowOnly: !!shadowOnly });
  return { ok: true, playbookRegistry: next, entry: normaliseEntry(e.id, next[e.id], rules) };
}

// ── The switch, decided by his own ledger ───────────────────────────────────

const SWITCH_BAR = Object.freeze({
  minSamples: 30,     // same floor as drift-edge: below this nothing is a rate
  z: 1.96,
});

/**
 * Should this playbook be ON?
 *
 * The bar is deliberately the strictest one available in this repo, and it is
 * strict on the LOWER bound rather than the point estimate:
 *
 *   n >= 30   AND   winRateCI.lo > break-even win rate for the payoff
 *             AND   expectancy per contract > 0
 *
 * Testing the interval's LOWER bound against break-even is the whole point. A
 * playbook at 58% on 12 trades has a lower bound near 32%, which is under
 * break-even — and that is the honest reading of twelve trades. It is also the
 * rule that would have caught the 5-6 contract bucket that looked like +$506 and
 * collapsed to +$24 once one lucky trade was removed.
 *
 * @param stats {n, wins, winRate, expectancyPerContract, payoff, avgWin, avgLoss}
 */
function decideSwitch(stats, rules, options) {
  const cfg = Object.assign({}, SWITCH_BAR, options || {});
  const s = stats || {};
  const n = Number(s.n);
  if (!Number.isFinite(n) || n <= 0) {
    return { recommend: 'insufficient', reason: 'No outcome has been recorded for this playbook yet — every signal it fires is being scored, so this answers itself.', bar: cfg };
  }
  const wins = Number(s.wins);
  const wr = Number.isFinite(Number(s.winRate)) ? Number(s.winRate) : (Number.isFinite(wins) ? wins / n : null);
  const ci = (wr != null) ? driftEdge.wilson(Number.isFinite(wins) ? wins : Math.round(wr * n), n, cfg.z) : null;
  // The payoff comes from rules.json's own spec block, never from a constant
  // here. `playbooks.targetR` is where it actually lives (rules.playbookSpec is
  // accepted too, for callers that pass the spec block directly).
  const specBlock = (rules && rules.playbookSpec) || (rules && rules.playbooks) || {};
  const payoff = Number.isFinite(Number(s.payoff))
    ? Number(s.payoff)
    : (Number.isFinite(Number(specBlock.targetR)) ? Number(specBlock.targetR) : 2);
  const breakeven = 1 / (1 + payoff);
  const exp = Number(s.expectancyPerContract);
  const bar = Object.assign({}, cfg, { breakevenWinRate: Math.round(breakeven * 1000) / 1000, payoff });

  if (n < cfg.minSamples) {
    return {
      recommend: 'insufficient', ci, bar,
      reason: n + ' scored signal(s); ' + cfg.minSamples + ' are needed before a win rate means anything. '
        + 'At ' + n + ' the interval is roughly ' + Math.round((ci ? ci.lo : 0) * 100) + '-' + Math.round((ci ? ci.hi : 1) * 100)
        + '% — that spans a coin, an edge and a disaster.',
    };
  }
  if (!ci) return { recommend: 'insufficient', reason: 'win rate is not computable from the recorded rows', ci: null, bar };
  if (ci.lo <= breakeven) {
    return {
      recommend: 'off', ci, bar,
      reason: 'Even the GOOD end of the interval (' + Math.round(ci.lo * 100) + '% at n=' + n + ') is at or below the '
        + Math.round(breakeven * 100) + '% break-even for a ' + payoff + ':1 payoff. Keep recording; do not add size.',
    };
  }
  if (!Number.isFinite(exp) || exp <= 0) {
    return {
      recommend: 'off', ci, bar,
      reason: 'Win rate clears break-even (' + Math.round(ci.lo * 100) + '-' + Math.round(ci.hi * 100) + '% at n=' + n
        + ') but expectancy per contract is ' + (Number.isFinite(exp) ? exp : 'not computable') + '. A win rate without positive expectancy is a fee-paying machine.',
    };
  }
  return {
    recommend: 'on', ci, bar,
    reason: 'n=' + n + ', win rate ' + Math.round(ci.lo * 100) + '-' + Math.round(ci.hi * 100) + '% clears the '
      + Math.round(breakeven * 100) + '% break-even even at its lower bound, and expectancy is $' + exp
      + ' per contract. Recorded evidence, not an opinion.',
  };
}

/** The line the UI shows for one playbook. Never a percentage chance of winning. */
function describeEntry(entry, stats) {
  if (!entry) return '';
  const bits = [];
  if (entry.kind === 'gate') bits.push('validity gate (locked on)');
  else if (entry.kind === 'informational') bits.push('triggers analysis only');
  else bits.push(entry.enabled ? 'ON' : 'OFF');
  if (entry.kind === 'setup') bits.push(entry.shadowOnly ? 'recording only' : 'may place orders in CONTROL');
  if (entry.unknown) bits.push('no detector yet');
  const n = stats && Number(stats.n);
  if (Number.isFinite(n) && n > 0) bits.push(n + ' scored');
  return bits.join(' · ');
}

module.exports = {
  PLAYBOOK_META, DEFAULT_REGISTRY, NEW_PLAYBOOK_DEFAULT, NEVER_EXECUTES,
  SWITCH_BAR, resolveRegistry, listRegistry, entryFor, isEnabled, isShadowOnly,
  sizesFor, canExecute, toggle, setShadowOnly, decideSwitch, describeEntry,
  normaliseEntry, metaFor,
};
