'use strict';
// Tests for cli/econ-calendar.js — the blackout gate.
// Run with:  node --test "cli/test/*.test.js"
//
// The fail-closed cases are the important ones. A guard that opens when its
// data source breaks is not a guard, and that failure is invisible in normal
// use: on a quiet morning "no calendar" and "no releases" produce the same
// silence. These tests are the only thing that distinguishes them.

const test = require('node:test');
const assert = require('node:assert');
const EC = require('../econ-calendar');
const Y = require('../yahoo');

// ── release classification ─────────────────────────────────────────────────
test('classify recognises the releases that move MNQ and MGC', () => {
  assert.equal(EC.classify('Employment Situation').key, 'NFP');
  assert.equal(EC.classify('Consumer Price Index').key, 'CPI');
  assert.equal(EC.classify('Producer Price Index').key, 'PPI');
  assert.equal(EC.classify('FOMC Press Conference').key, 'FOMC');
  assert.equal(EC.classify('Gross Domestic Product').key, 'GDP');
});

// ── G27: the wider blackout list (2026-09-09) ────────────────────────────────
// Each `match` below is the EXACT release_name FRED reports (verified live, not
// guessed), so a regex that doesn't match here would silently drop a mover.
test('G27: classify recognises the newly-added movers by their FRED names', () => {
  assert.equal(EC.classify('G.17 Industrial Production and Capacity Utilization').key, 'INDPROD');
  assert.equal(EC.classify('New Residential Construction').key, 'HOUSING');
  assert.equal(EC.classify("Manufacturer's Shipments, Inventories, and Orders (M3) Survey").key, 'DURABLE');
  assert.equal(EC.classify('Surveys of Consumers').key, 'MICH');
  assert.equal(EC.classify('Empire State Manufacturing Survey').key, 'EMPIRE');
  assert.equal(EC.classify('Manufacturing Business Outlook Survey').key, 'PHILLY');
});

test('G27: the Philly Fed entry does not match the Nonmanufacturing services survey', () => {
  // "Nonmanufacturing Business Outlook Survey" is a DIFFERENT release (services).
  // The ^ anchor keeps the two from collapsing into one blackout.
  assert.equal(EC.classify('Manufacturing Business Outlook Survey').key, 'PHILLY');
  assert.equal(EC.classify('Nonmanufacturing Business Outlook Survey'), null);
});

test('G27: every entry carries a valid ET wall-clock time', () => {
  for (const r of EC.RELEASES) {
    assert.ok(Number.isInteger(r.etHour) && r.etHour >= 0 && r.etHour <= 23, r.key + ' etHour');
    assert.ok(Number.isInteger(r.etMin) && r.etMin >= 0 && r.etMin <= 59, r.key + ' etMin');
    assert.ok(Number.isInteger(r.before) && r.before >= 0, r.key + ' before');
    assert.ok(Number.isInteger(r.after) && r.after >= 0, r.key + ' after');
  }
});

test('G27: tier-3 regional surveys black out less time than a tier-1 print', () => {
  const nfp = EC.classify('Employment Situation');
  const empire = EC.classify('Empire State Manufacturing Survey');
  assert.equal(empire.tier, 3);
  assert.ok(empire.before < nfp.before && empire.after < nfp.after,
    'a single-region survey must not black out as much as a national tier-1 print');
});

test('classify ignores releases that do not move these instruments', () => {
  assert.equal(EC.classify('Beige Book'), null);
  assert.equal(EC.classify('Agricultural Prices'), null);
  assert.equal(EC.classify(''), null);
});

test('tier-1 releases carry wider blackouts than tier-3', () => {
  const nfp = EC.classify('Employment Situation');
  const claims = EC.classify('Jobless Claims');
  assert.equal(nfp.tier, 1);
  assert.equal(claims.tier, 3);
  assert.ok(nfp.before > claims.before && nfp.after > claims.after,
    'a tier-1 print must black out more time than a tier-3');
});

test('blackout windows are asymmetric — longer after the print than before', () => {
  for (const r of EC.RELEASES) {
    assert.ok(r.after >= r.before,
      r.key + ': the minutes after a print are when the chasing happens, so the '
      + 'window after must not be shorter than the window before');
  }
});

// ── ET conversion across DST ───────────────────────────────────────────────
// FRED gives a release DATE; the time of day comes from the agency's fixed ET
// schedule. Converting that to an instant with a hardcoded offset breaks twice
// a year — the same class of bug already recorded against this repo's IST
// session windows.
test('etEpochFor lands on 08:30 ET in summer (EDT, UTC-4)', () => {
  const t = EC.etEpochFor('2026-09-04', 8, 30);
  const p = Y.etParts(t);
  assert.equal(p.H, 8);
  assert.equal(p.M, 30);
  assert.equal(p.dayKey, '2026-09-04');
});

test('etEpochFor lands on 08:30 ET in winter (EST, UTC-5)', () => {
  const t = EC.etEpochFor('2026-01-09', 8, 30);
  const p = Y.etParts(t);
  assert.equal(p.H, 8, 'must still be 08:30 ET after the DST shift');
  assert.equal(p.M, 30);
  assert.equal(p.dayKey, '2026-01-09');
});

test('etEpochFor handles the 14:00 ET FOMC slot', () => {
  const t = EC.etEpochFor('2026-09-16', 14, 0);
  const p = Y.etParts(t);
  assert.equal(p.H, 14);
  assert.equal(p.M, 0);
});

test('etEpochFor rejects a malformed date rather than guessing', () => {
  assert.equal(EC.etEpochFor('not-a-date', 8, 30), null);
  assert.equal(EC.etEpochFor('04-09-2026', 8, 30), null);
});

// ── the fail-closed contract ───────────────────────────────────────────────
test('isBlackout fails CLOSED when no calendar is loaded', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    const v = EC.isBlackout(bad, 1757000000);
    assert.equal(v.blocked, true, 'an unusable calendar must BLOCK, never permit');
    assert.match(v.reason, /failing closed/);
  }
});

test('an empty calendar is not a blackout — absence of releases is real data', () => {
  const v = EC.isBlackout([], 1757000000);
  assert.equal(v.blocked, false);
  assert.equal(v.next, null);
});

// ── window arithmetic ──────────────────────────────────────────────────────
// NFP at 08:30 ET on 2026-09-04, blacked out 30 min before to 60 min after.
const NFP_AT = EC.etEpochFor('2026-09-04', 8, 30);
const WINDOWS = [{
  key: 'NFP', name: 'Employment Situation', tier: 1,
  at: NFP_AT, atLabel: Y.fmtBoth(NFP_AT),
  from: NFP_AT - 30 * 60, to: NFP_AT + 60 * 60,
  beforeMin: 30, afterMin: 60,
}];

test('blocked inside the pre-release window, and says how many minutes out', () => {
  const v = EC.isBlackout(WINDOWS, NFP_AT - 20 * 60);
  assert.equal(v.blocked, true);
  assert.match(v.reason, /releases in 20 minutes/);
});

test('blocked after the print too — the chase window', () => {
  const v = EC.isBlackout(WINDOWS, NFP_AT + 45 * 60);
  assert.equal(v.blocked, true);
  assert.match(v.reason, /released 45 minutes ago/);
});

test('clear outside the window, and reports what is next', () => {
  const before = EC.isBlackout(WINDOWS, NFP_AT - 4 * 3600);
  assert.equal(before.blocked, false);
  assert.equal(before.next.key, 'NFP');
  assert.equal(before.next.inMinutes, 210, '4h out minus the 30m pre-window');

  const after = EC.isBlackout(WINDOWS, NFP_AT + 3 * 3600);
  assert.equal(after.blocked, false);
  assert.equal(after.next, null, 'nothing left in the window');
});

test('window boundaries are inclusive — the edge blocks', () => {
  assert.equal(EC.isBlackout(WINDOWS, WINDOWS[0].from).blocked, true);
  assert.equal(EC.isBlackout(WINDOWS, WINDOWS[0].to).blocked, true);
  assert.equal(EC.isBlackout(WINDOWS, WINDOWS[0].from - 1).blocked, false);
  assert.equal(EC.isBlackout(WINDOWS, WINDOWS[0].to + 1).blocked, false);
});

test('fetchCalendar without a key reports auth, and never returns windows', async () => {
  // No FRED_API_KEY is set in this environment, so this exercises the real
  // failure path rather than a mock.
  const cal = await EC.fetchCalendar({ days: 7 });
  if (!cal.ok) {
    assert.deepEqual(cal.windows, [], 'a failed fetch must not yield windows');
    assert.ok(cal.reason && cal.reason.length > 0, 'a failure must explain itself');
    // And the verdict built from it must block.
    assert.equal(EC.isBlackout(null).blocked, true);
  }
});
