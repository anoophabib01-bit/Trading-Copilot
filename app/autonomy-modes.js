'use strict';
// ── Autonomy modes — the four rungs, and what each one is allowed to do ────
// Anoop, 2026-08-29: "i want to continue building the 3 mode Myself, shadow,
// control ... each should be separate and should function differently but will
// share the same data of the account."
//
// Full design: AUTONOMY_MODES_SPEC.md. This module is the CONFIG half of it —
// autonomy-gate.js decides whether a mode may be entered, this decides what the
// mode is permitted to do once it is.
//
// ── WHY FOUR AND NOT THREE ─────────────────────────────────────────────────
// The three modes he named leave a cliff in the middle: SHADOW places nothing
// at all, CONTROL places real orders unattended, and there is no step between
// them where real money meets a machine decision while a human is still
// looking. Everything you would want to learn before trusting an unattended
// system — do the entries actually fill, does the stop land where it should,
// does slippage eat the edge — is only observable on the far side of that
// cliff. So ASSIST sits in the gap: the machine decides, Anoop approves each
// ticket, the app places it. Locked with him 2026-08-29.
//
//   MYSELF (off) -> SHADOW -> ASSIST -> CONTROL (live)
//
// Each rung adds exactly ONE new thing that can go wrong, so when something
// breaks it is obvious which capability broke.
//
// ── THE SAFETY PROPERTY THIS MODULE EXISTS TO GUARANTEE ────────────────────
// A per-mode config may only ever be TIGHTER than the global rules, never
// looser. riskCapUsd() returns the MINIMUM of the mode's cap and the global
// perTradeMaxLoss, so a typo in the autonomyModes block cannot widen the
// account's risk — the worst a bad edit can do is refuse trades. Every other
// limit in this repo is a single number in rules.json; this is the first place
// where two numbers could disagree, and the disagreement must resolve toward
// safety without anyone having to remember that it should.
//
// PURE. Reads config, returns decisions. Places nothing, writes nothing.

// Internal mode ids. 'live' rather than 'control' is deliberate and load-
// bearing: DATA/autonomy/state.json already persists 'live', autonomy-gate.js
// already ships MODES containing 'live', and a stored state that no longer
// matches the known list reads as 'off'. Renaming the persisted value would
// silently reset the toggle for anyone mid-flight. The UI says CONTROL; the
// wire and the disk say 'live'; CONFIG_KEY below is the only place the two
// vocabularies meet.
const MODES = ['off', 'shadow', 'assist', 'live'];

// Modes that can put an order in front of the broker at all. OFF and SHADOW
// are absent by construction, not by configuration — no rules.json edit can
// add them.
const EXECUTING_MODES = new Set(['assist', 'live']);

// mode id -> the key it is configured under in rules.json.autonomyModes
const CONFIG_KEY = { shadow: 'shadow', assist: 'assist', live: 'control' };

// Human-facing names, so a badge and a log line never drift apart.
const LABELS = { off: 'MYSELF', shadow: 'SHADOW', assist: 'ASSIST', live: 'CONTROL' };

// Defaults are the SAFE end of every axis: disabled, silent, no execution.
// A missing or malformed autonomyModes block must therefore behave exactly
// like the feature is switched off, which is the same failure direction
// autonomy-store takes on a corrupt state file.
const MODE_DEFAULTS = {
  shadow: { enabled: false, silent: true, sizes: [2], perTradeRiskCapUsd: null },
  assist: { enabled: false, silent: false, sizes: [2], perTradeRiskCapUsd: null },
  live: {
    enabled: false, silent: false, sizes: [2],
    perTradeRiskCapUsd: 200,
    dailyLossCeilingUsd: 200,
    autoResetDaily: false,
    playbooks: ['A', 'B', 'LTF-ENGULF'],
  },
};

function normaliseMode(mode) {
  const m = String(mode || 'off').toLowerCase();
  return MODES.includes(m) ? m : 'off';
}

function label(mode) { return LABELS[normaliseMode(mode)] || 'MYSELF'; }

function canExecute(mode) { return EXECUTING_MODES.has(normaliseMode(mode)); }

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n ? n : null;
}

function positiveNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A strict numeric read, for values where "absent" must NOT become zero.
//
// Number(null), Number(''), Number([]) and Number(false) are all 0, and 0 is
// finite — so a plain Number.isFinite(Number(v)) check reads a MISSING risk
// figure as a $0 risk and waves it through every cap. Caught by
// test/autonomy-modes.test.js on the first run of this module; on the live path
// it would have meant an order whose risk failed to compute being treated as
// the safest possible order rather than the most suspect one.
function strictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Resolved config for one mode. Never throws and never returns undefined —
 * a caller on the live path must be able to use the result without guarding.
 */
function modeConfig(rules, mode) {
  const m = normaliseMode(mode);
  if (m === 'off') {
    return { mode: 'off', label: 'MYSELF', enabled: true, silent: false, canExecute: false, sizes: [] };
  }
  const defaults = MODE_DEFAULTS[m] || {};
  let raw = {};
  try {
    const block = (rules && rules.autonomyModes) || {};
    raw = block[CONFIG_KEY[m]] || {};
  } catch (e) { raw = {}; }

  const sizes = (Array.isArray(raw.sizes) ? raw.sizes : defaults.sizes || [])
    .map(positiveInt).filter((n) => n != null);

  return Object.assign({}, defaults, {
    mode: m,
    label: LABELS[m],
    // Strict === true, not truthiness: a mode is enabled only when the config
    // says so in as many words. "yes", 1 and "true" are configuration typos,
    // and a typo must not arm an executing mode.
    enabled: raw.enabled === true,
    silent: raw.silent != null ? raw.silent === true : defaults.silent === true,
    canExecute: EXECUTING_MODES.has(m),
    // An empty/invalid sizes list falls back to the defaults rather than to
    // "no size", which would silently record nothing at all — the exact
    // failure the [4,6] misconfiguration produced for shadow's whole life.
    sizes: sizes.length ? sizes : (defaults.sizes || []),
    perTradeRiskCapUsd: positiveNum(raw.perTradeRiskCapUsd) != null
      ? positiveNum(raw.perTradeRiskCapUsd) : (defaults.perTradeRiskCapUsd || null),
    dailyLossCeilingUsd: positiveNum(raw.dailyLossCeilingUsd) != null
      ? positiveNum(raw.dailyLossCeilingUsd) : (defaults.dailyLossCeilingUsd || null),
    autoResetDaily: raw.autoResetDaily === true,
    playbooks: Array.isArray(raw.playbooks) && raw.playbooks.length
      ? raw.playbooks.map(String) : (defaults.playbooks || null),
  });
}

// Is this mode both permitted by the master switch AND switched on itself?
// Both are required: autonomyEnabled is the hard kill switch (rules.json), the
// per-mode flag is what lets shadow run while control is not even rendered.
function isModeEnabled(rules, mode) {
  const m = normaliseMode(mode);
  if (m === 'off') return true;
  try { if ((rules || {}).autonomyEnabled !== true) return false; } catch (e) { return false; }
  return modeConfig(rules, m).enabled;
}

// The contract sizes this mode records/trades at.
function sizesFor(rules, mode) { return modeConfig(rules, mode).sizes; }

// Should this mode stay quiet — no tickets in chat, no badge churn, no push?
// Only shadow defaults to true. It is the one mode that runs WHILE Anoop is
// trading his own account, and on 2026-08-26 its tickets in the chat were what
// made a live session confusing enough that he switched the whole feature off.
function isSilent(rules, mode) { return modeConfig(rules, mode).silent === true; }

/**
 * The per-trade risk ceiling in force for a mode, in dollars.
 *
 * ALWAYS the tighter of {mode cap, global perTradeMaxLoss}. See the header:
 * a mode config may narrow the account's risk, never widen it.
 */
function riskCapUsd(rules, mode) {
  const global = positiveNum((rules || {}).perTradeMaxLoss);
  const modeCap = positiveNum(modeConfig(rules, mode).perTradeRiskCapUsd);
  if (global == null) return modeCap;      // no global configured
  if (modeCap == null) return global;      // mode inherits the global
  return Math.min(global, modeCap);
}

/**
 * May this mode take an order risking `riskUsd`?
 *
 * Returns a REASON on refusal rather than a bare false, because these refusals
 * are recorded and read back: "how often did a detector propose a setup the
 * mode is forbidden to take" is a finding about the detector, and it is
 * unanswerable if every refusal collapses to the same word.
 */
function checkOrderRisk(rules, mode, riskUsd) {
  const cap = riskCapUsd(rules, mode);
  const r = strictNumber(riskUsd);
  if (r == null) {
    // Unknown risk is never "small enough". Same discipline as oversize-guard
    // treating an unreadable size as unknown rather than as zero.
    return { allowed: false, reason: 'risk is not computable — refusing rather than assuming it is small' };
  }
  if (cap != null && r > cap) {
    return {
      allowed: false,
      cap,
      reason: `$${r.toFixed(0)} risk exceeds the $${cap} per-trade limit for ${label(mode)}`,
    };
  }
  return { allowed: true, cap };
}

// May this mode trade this playbook? A null playbook list means "no per-mode
// restriction configured" and defers to whatever gates the caller already
// applies — it does NOT mean "all playbooks", which would let a dropped config
// key quietly widen the grant.
function isPlaybookAllowed(rules, mode, playbook) {
  const cfg = modeConfig(rules, mode);
  if (!Array.isArray(cfg.playbooks)) return true;
  const p = String(playbook || '');
  // A 'C' arriving here is an ENGULF SETUP, never the validity gate —
  // playbook-spec.js marks the real C as isGate:true and planEntry() refuses
  // it outright. Until 2026-09-01 that engulf was LTF-ENGULF; now every
  // always-on engulf watcher is Playbook A, so 'C' and the retired
  // 'LTF-ENGULF' both resolve there. Same aliasing armSetup does.
  const alias = (p === 'C' || p === 'LTF-ENGULF') ? 'A' : p;
  return cfg.playbooks.includes(p) || cfg.playbooks.includes(alias);
}

module.exports = {
  MODES, EXECUTING_MODES, CONFIG_KEY, LABELS, MODE_DEFAULTS,
  normaliseMode, label, canExecute,
  modeConfig, isModeEnabled, sizesFor, isSilent,
  riskCapUsd, checkOrderRisk, isPlaybookAllowed,
};
