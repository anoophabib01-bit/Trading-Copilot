const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tier = require('../tier.js');
const { checkTradeAllowed } = require('../trade-confirm-rules.js');

/* ------------------------------------------------------------------ *
 * The safety property. If this file only had one test, it would be
 * the first one below: an install with no licence must keep its teeth.
 * ------------------------------------------------------------------ */

test('NO LICENCE MEANS FULL ENFORCEMENT — an existing install cannot be loosened by this module', () => {
  const lic = tier.readLicence(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.json'));
  assert.strictEqual(lic.present, false);
  assert.strictEqual(lic.tier, 'local');
  assert.strictEqual(tier.isEnforcing(lic.tier), true);
});

test('the default tier is the ENFORCING one, not free', () => {
  assert.strictEqual(tier.DEFAULT_TIER, 'local');
  assert.notStrictEqual(tier.DEFAULT_TIER, tier.FREE);
});

test('garbage input falls back to the enforcing default, never to free', () => {
  const junk = [undefined, null, '', 'ultra', 'FREE-TRIAL', 42, {}, { tier: 'nope' }, []];
  junk.forEach(function (j) {
    assert.strictEqual(tier.resolveTier(j), 'local', 'resolveTier(' + JSON.stringify(j) + ') must not open the gate');
  });
});

test('valid tiers resolve, and are case/whitespace tolerant', () => {
  assert.strictEqual(tier.resolveTier('free'), 'free');
  assert.strictEqual(tier.resolveTier('  FREE '), 'free');
  assert.strictEqual(tier.resolveTier('Local'), 'local');
  assert.strictEqual(tier.resolveTier('cloud'), 'cloud');
  assert.strictEqual(tier.resolveTier({ tier: 'free' }), 'free');
});

test('isEnforcing is true for every tier except free', () => {
  assert.strictEqual(tier.isEnforcing('free'), false);
  assert.strictEqual(tier.isEnforcing('local'), true);
  assert.strictEqual(tier.isEnforcing('cloud'), true);
});

/* ------------------------------------------------------------ *
 * Paid tiers must pass the verdict through BYTE FOR BYTE.
 * ------------------------------------------------------------ */

test('a paid tier returns the refusal object completely unchanged', () => {
  const refusal = { allowed: false, reason: 'size 6 exceeds sizeCap 4' };
  ['local', 'cloud'].forEach(function (tt) {
    const out = tier.applyTier(refusal, tt);
    assert.strictEqual(out, refusal, tt + ' must return the very same object, not a copy');
  });
});

test('a paid tier leaves an allowed verdict alone and adds no advisory fields', () => {
  const ok = { allowed: true, reason: null };
  const out = tier.applyTier(ok, 'local');
  assert.strictEqual(out, ok);
  assert.strictEqual(out.advisory, undefined);
  assert.strictEqual(out.wouldBlock, undefined);
});

test('a paid tier preserves an existing advisory verdict', () => {
  const adv = { allowed: true, reason: null, advisory: true, warning: 'degraded count' };
  const out = tier.applyTier(adv, 'local');
  assert.strictEqual(out, adv);
  assert.strictEqual(out.warning, 'degraded count');
});

/* ------------------------------------------------------------ *
 * Free tier: the refusal becomes advice, and the evidence survives.
 * ------------------------------------------------------------ */

test('free tier converts a refusal into an advisory and still permits the trade', () => {
  const refusal = { allowed: false, reason: 'day P&L -320.00 already at/past day-stop -300' };
  const out = tier.applyTier(refusal, 'free');
  assert.strictEqual(out.allowed, true, 'free tier must not block');
  assert.strictEqual(out.advisory, true);
  assert.strictEqual(out.wouldBlock, true);
  assert.strictEqual(out.blockedReason, refusal.reason, 'the original reason must survive for the UI');
  assert.strictEqual(out.reason, null, 'reason stays null to match the advisory contract the UI already reads');
  assert.match(out.warning, /would have been refused/);
  assert.match(out.warning, /day-stop/, 'the warning must name the actual rule that was broken');
});

test('free tier does NOT touch a verdict that was already allowed', () => {
  const ok = { allowed: true, reason: null };
  const out = tier.applyTier(ok, 'free');
  assert.strictEqual(out, ok);
  assert.strictEqual(out.wouldBlock, undefined);
});

test('free tier does not double-wrap an existing advisory', () => {
  const adv = { allowed: true, reason: null, advisory: true, warning: 'degraded count' };
  const out = tier.applyTier(adv, 'free');
  assert.strictEqual(out.wouldBlock, undefined, 'an already-allowed advisory is not a blocked trade');
});

test('free tier survives a malformed verdict without throwing', () => {
  const out = tier.applyTier(null, 'free');
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.wouldBlock, undefined);
});

/* ------------------------------------------------------------ *
 * End to end against the REAL rule engine.
 * ------------------------------------------------------------ */

const RULES = {
  sizeCap: 4,
  sizeFloor: 1,
  tradesPerDay: 5,
  dayStop: { eval: 300, funded: 200 },
  dailyLossTiers: { yellow: -250, red: -350, hard: -500 }
};

test('INTEGRATION: the same oversize trade is refused on local and merely warned on free', () => {
  const raw = checkTradeAllowed(RULES, 'eval', [], 6);

  assert.strictEqual(raw.allowed, false, 'the rule engine itself must still refuse');
  assert.match(raw.reason, /exceeds sizeCap/);

  const paid = tier.applyTier(raw, 'local');
  assert.strictEqual(paid.allowed, false, 'local keeps the refusal');

  const free = tier.applyTier(raw, 'free');
  assert.strictEqual(free.allowed, true, 'free lets it through');
  assert.strictEqual(free.wouldBlock, true);
  assert.match(free.blockedReason || free.warning, /sizeCap/);
});

test('INTEGRATION: a compliant trade is identical on every tier', () => {
  const raw = checkTradeAllowed(RULES, 'eval', [], 2);
  assert.strictEqual(raw.allowed, true);
  ['free', 'local', 'cloud'].forEach(function (tt) {
    const out = tier.applyTier(raw, tt);
    assert.strictEqual(out.allowed, true);
    assert.strictEqual(out.wouldBlock, undefined, tt + ' must not flag a compliant trade');
  });
});

test('INTEGRATION: free tier still surfaces the day-stop breach with the real number', () => {
  const trades = [{ size: 2, pnl: -320 }];
  const raw = checkTradeAllowed(RULES, 'eval', trades, 2);
  assert.strictEqual(raw.allowed, false);

  const free = tier.applyTier(raw, 'free');
  assert.strictEqual(free.allowed, true);
  assert.match(free.blockedReason, /-?320/, 'the actual P&L must reach the warning');
});

/* ------------------------------------------------------------ *
 * Licence file handling.
 * ------------------------------------------------------------ */

test('readLicence reads a real file, and a corrupt one is treated as no licence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tier-'));
  try {
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ tier: 'free', key: 'ABC-123' }));
    const lic = tier.readLicence(good);
    assert.strictEqual(lic.present, true);
    assert.strictEqual(lic.tier, 'free');
    assert.strictEqual(lic.raw.key, 'ABC-123');

    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ this is not json');
    const broken = tier.readLicence(bad);
    assert.strictEqual(broken.present, false);
    assert.strictEqual(broken.tier, 'local', 'a corrupt licence must not open the gate');

    const unknown = path.join(dir, 'unknown.json');
    fs.writeFileSync(unknown, JSON.stringify({ tier: 'enterprise-plus' }));
    assert.strictEqual(tier.readLicence(unknown).tier, 'local', 'an unrecognised tier must not open the gate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
