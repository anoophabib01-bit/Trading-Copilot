'use strict';
// Tier model: free | local | cloud.
//
// THE ONE RULE THAT MATTERS: when no licence file is present the tier is
// 'local' -- full enforcement -- so an existing install behaves EXACTLY as it
// did before this module existed. Nothing about this file can loosen a live
// guard by accident. A free tier only ever happens because a licence file
// explicitly says so.
//
// This module is pure apart from readLicence(), which touches disk once.

const fs = require('node:fs');
const path = require('node:path');

const FREE = 'free';
const LOCAL = 'local';
const CLOUD = 'cloud';
const VALID = [FREE, LOCAL, CLOUD];

// Absent licence => full enforcement. Deliberate, and the safe direction.
const DEFAULT_TIER = LOCAL;

const DEFAULT_LICENCE_PATH = path.join(__dirname, 'licence.json');

/**
 * Normalise anything into a known tier. Unknown/missing input falls back to the
 * DEFAULT, which is the ENFORCING one -- never silently downgrade to free.
 */
function resolveTier(input) {
  if (input == null) return DEFAULT_TIER;
  let raw = input;
  if (typeof input === 'object') raw = input.tier;
  const t = String(raw || '').trim().toLowerCase();
  return VALID.indexOf(t) >= 0 ? t : DEFAULT_TIER;
}

/**
 * Read the licence file. Any failure (missing file, bad JSON, unreadable) is
 * treated as "no licence" and therefore as the default enforcing tier.
 */
function readLicence(licencePath) {
  const p = licencePath || DEFAULT_LICENCE_PATH;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { present: true, tier: resolveTier(parsed), raw: parsed, path: p };
  } catch (e) {
    return { present: false, tier: DEFAULT_TIER, raw: null, path: p };
  }
}

/** True when this tier actually refuses trades. Free advises; it does not block. */
function isEnforcing(tier) {
  return resolveTier(tier) !== FREE;
}

/**
 * The gate. Wrap a checkTradeAllowed() verdict in the tier's behaviour.
 *
 * Paid tiers: returned UNCHANGED, field for field. This is what guarantees the
 *            live app cannot change behaviour because of this module.
 * Free tier:  a refusal becomes an advisory -- the trade is permitted, and the
 *            verdict that WOULD have stopped it is carried forward so the UI
 *            can show exactly what the paid tier would have done.
 *
 * The returned shape deliberately matches the advisory contract already in
 * trade-confirm-rules.js (the degraded-count path): {allowed, reason, advisory,
 * warning}. Extra fields are additive for the UI.
 */
function applyTier(verdict, tier) {
  const t = resolveTier(tier);
  const v = verdict || { allowed: true, reason: null };

  if (t !== FREE) return v;
  if (v.allowed !== false) return v;

  const why = v.reason || 'a rule was broken';
  return {
    allowed: true,
    reason: null,
    advisory: true,
    wouldBlock: true,
    blockedReason: why,
    tier: FREE,
    warning:
      'This trade breaks one of your own rules and would have been refused on the paid tier: ' +
      why + '. Nothing was stopped -- free tier advises, it does not enforce.'
  };
}

module.exports = {
  FREE: FREE,
  LOCAL: LOCAL,
  CLOUD: CLOUD,
  VALID_TIERS: VALID,
  DEFAULT_TIER: DEFAULT_TIER,
  DEFAULT_LICENCE_PATH: DEFAULT_LICENCE_PATH,
  resolveTier: resolveTier,
  readLicence: readLicence,
  isEnforcing: isEnforcing,
  applyTier: applyTier
};
