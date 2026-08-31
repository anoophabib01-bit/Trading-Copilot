'use strict';
/**
 * broker-verify.js tests.
 *
 * 2026-08-26. Anoop: "it should verify with live broker data ... if not API
 * will read wrong data and token is simply wasted. before every output it
 * should verify."
 *
 * The bar: this must never report "verified" for something it did not
 * actually check. Every number failure this app has shipped came from a
 * source nobody cross-checked, and a verifier that says "fine" when it is
 * merely blind is worse than no verifier at all — it converts a silent
 * failure into a confident one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const BV = require('../broker-verify.js');
const DR = require('../renderer/day-rollup.js');
const TI = require('../renderer/trade-identity.js');

const COMM = 1.9;  // round turn, $0.95 a side
const row = (o) => Object.assign({ t: 1000, x: 2000, size: 2, pnl: 100, pnlBasis: 'gross' }, o || {});

// ── "unverified" is never "verified" ────────────────────────────────────────

test('no broker evidence at all is UNVERIFIED, never a pass', () => {
  const r = BV.verifyDay({ appRows: [row()], commPerCt: COMM, walkClosed: null, brokerRealized: null });
  assert.strictEqual(r.verdict, 'unverified');
  assert.strictEqual(r.ranCount, 0);
});

test('the unverified wording tells the agent it is NOT the same as correct', () => {
  const r = BV.verifyDay({ appRows: [row()], commPerCt: COMM, walkClosed: null, brokerRealized: null });
  const txt = BV.formatVerificationContext(r);
  assert.ok(/NOT VERIFIED/.test(txt), txt);
  assert.ok(/NOT the same as correct/.test(txt), txt);
  assert.ok(/do not compute with it/.test(txt), txt);
});

test('an empty day with broker evidence still verifies', () => {
  const r = BV.verifyDay({ appRows: [], commPerCt: COMM, walkClosed: [], brokerRealized: 0 });
  assert.strictEqual(r.verdict, 'verified');
});

// ── The failures this exists to have caught ────────────────────────────────

test('catches the 2026-08-24 trade-count fabrication (15 vs 7)', () => {
  const app = Array.from({ length: 15 }, (_, i) => row({ t: i, x: i, pnl: 1 }));
  const walk = Array.from({ length: 7 }, () => ({ size: 2 }));
  const r = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: walk, brokerRealized: null });
  assert.strictEqual(r.verdict, 'mismatch');
  assert.ok(r.failed.includes('trade count'));
});

test('catches the 2026-08-25 double-charged commission ($114 on 60 contracts)', () => {
  // Eleven live rows whose pnl is NET. If anything treats them as gross the
  // day comes out one full commission low.
  const app = Array.from({ length: 11 }, (_, i) =>
    row({ t: i, x: i, size: 6, pnl: 10, pnlBasis: 'net' }));
  const walk = Array.from({ length: 11 }, () => ({ size: 6 }));
  const trueNet = 11 * 10;
  const ok = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: walk, brokerRealized: trueNet });
  assert.strictEqual(ok.verdict, 'verified', JSON.stringify(ok.checks));
  const wrong = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: walk, brokerRealized: trueNet - 66 * COMM });
  assert.strictEqual(wrong.verdict, 'mismatch');
  assert.ok(wrong.failed.includes('day P&L'));
});

test('catches a day whose trades never reached the record (2026-08-26)', () => {
  const r = BV.verifyDay({ appRows: [], commPerCt: COMM, walkClosed: [{ size: 2 }], brokerRealized: null });
  assert.strictEqual(r.verdict, 'mismatch');
  assert.ok(r.failed.includes('trade count'));
});

// ── Not crying wolf ─────────────────────────────────────────────────────────

test('an OPEN position does not report a false trade-count mismatch', () => {
  // The walk cannot close a round trip that is still running, so the app
  // legitimately holds one more. Reporting that would fire every time he is
  // in a trade, and an alarm that always fires is not an alarm.
  const app = [row({ t: 1 }), row({ t: 2 })];
  const walk = [{ size: 2 }];
  const r = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: walk, brokerRealized: null, openSize: 2 });
  assert.strictEqual(r.checks.find(c => c.name === 'trade count').status, 'skip');
  assert.notStrictEqual(r.verdict, 'mismatch');
});

test('unobserved sizes are reported as a gap, not a contradiction', () => {
  // size 0 means "never observed", so the app total is low BY CONSTRUCTION.
  const app = [row({ size: 0 }), row({ t: 2, size: 2 })];
  const walk = [{ size: 4 }, { size: 2 }];
  const r = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: walk, brokerRealized: null });
  assert.strictEqual(r.checks.find(c => c.name === 'contracts').status, 'skip');
});

test('sub-dollar rounding drift is not a mismatch', () => {
  const app = [row({ size: 1, pnl: 100 })];
  const r = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: [{ size: 1 }], brokerRealized: 100 - COMM + 0.004 });
  assert.strictEqual(r.verdict, 'verified');
});

// ── Mixed-basis days ────────────────────────────────────────────────────────

test('a mixed gross/net day reconciles to ONE coherent net', () => {
  const app = [row({ t: 1, size: 2, pnl: 100, pnlBasis: 'gross' }),
               row({ t: 2, size: 2, pnl: 100, pnlBasis: 'net' })];
  // gross = 100 + (100 + 2*1.9) = 203.80 ; net = 203.80 - 4*1.9 = 196.20
  const r = BV.verifyDay({ appRows: app, commPerCt: COMM, walkClosed: [{ size: 2 }, { size: 2 }], brokerRealized: 196.20 });
  assert.strictEqual(r.verdict, 'verified', JSON.stringify(r.checks));
});

test('unstamped rows are WARNED about, since their basis is only inferred', () => {
  const r = BV.verifyDay({ appRows: [{ t: 1, x: 1, size: 2, pnl: 10 }], commPerCt: COMM, walkClosed: [{ size: 2 }], brokerRealized: 10 - 2 * COMM });
  const basis = r.checks.find(c => c.name === 'P&L basis');
  assert.strictEqual(basis.status, 'warn');
  assert.ok(/no pnlBasis stamp/.test(basis.detail));
  assert.ok(/pnlBasis/.test(BV.formatVerificationContext(r)));
});

// ── The mismatch instruction is the token-saving half ──────────────────────

test('a mismatch instructs the agent NOT to compute or advise on the figures', () => {
  const r = BV.verifyDay({ appRows: [], commPerCt: COMM, walkClosed: [{ size: 2 }], brokerRealized: null });
  const txt = BV.formatVerificationContext(r);
  assert.ok(/DO NOT TRUST THESE NUMBERS/.test(txt), txt);
  assert.ok(/[Dd]o NOT compute with these figures/.test(txt), txt);
  assert.ok(/do NOT give sizing or stop advice/.test(txt), txt);
  assert.ok(/read the broker panel directly/.test(txt), txt);
});

test('a clean verify says how much of the suite actually ran', () => {
  const r = BV.verifyDay({ appRows: [row()], commPerCt: COMM, walkClosed: [{ size: 2 }], brokerRealized: 100 - 2 * COMM });
  const txt = BV.formatVerificationContext(r);
  assert.ok(/VERIFIED/.test(txt));
  assert.ok(new RegExp(r.ranCount + ' of ' + r.totalCount + ' checks').test(txt), txt);
});

// ── One definition of "basis" across three files ───────────────────────────

test('broker-verify, day-rollup and trade-identity agree on pnlBasis', () => {
  // Three copies exist so no consumer depends on script load order. If they
  // ever drift, a row counted net by one and gross by another produces a day
  // total that reconciles against nothing — which is the whole bug class.
  [{ pnlBasis: 'net' }, { pnlBasis: 'gross' }, { evidence: 'fold' },
   { source: 'live-fold-only' }, { pnlBasis: 'gross', evidence: 'fold' }, {}, null].forEach(r => {
    const a = BV.pnlBasisOf(r), b = DR.pnlBasisOf(r), c = TI.pnlBasisOf(r);
    assert.strictEqual(a, b, 'verify vs rollup: ' + JSON.stringify(r));
    assert.strictEqual(a, c, 'verify vs identity: ' + JSON.stringify(r));
  });
});

test('grossOf matches day-rollup for both bases', () => {
  const net = { size: 3, pnl: 50, pnlBasis: 'net' };
  const gross = { size: 3, pnl: 50, pnlBasis: 'gross' };
  assert.strictEqual(BV.grossOf(net, COMM), DR.grossOf(net, COMM));
  assert.strictEqual(BV.grossOf(gross, COMM), DR.grossOf(gross, COMM));
  assert.strictEqual(BV.grossOf(net, COMM), 50 + 3 * COMM);
});

// ── Real data ───────────────────────────────────────────────────────────────

test('replays the repaired 2026-08-26 day against an agreeing broker', () => {
  const fs = require('fs');
  const path = require('path');
  const f = path.join(__dirname, '..', '..', 'DATA', 'accounts', 's1', 'day_trades.json');
  if (!fs.existsSync(f)) return;                      // not every checkout has his data
  const rows = (JSON.parse(fs.readFileSync(f, 'utf8')) || {})['2026-08-26'];
  if (!Array.isArray(rows) || !rows.length) return;
  // Derive the expected net from the rows themselves rather than hardcoding a
  // figure: this asserts that the reconciliation is self-consistent on REAL
  // row shapes (mixed gross/net, size 0, null sides), not that his data is
  // frozen in one particular state.
  const expectedNet = Math.round((
    rows.reduce((a, x) => a + BV.grossOf(x, COMM), 0)
    - rows.reduce((a, x) => a + (Number(x.size) || 0), 0) * COMM) * 100) / 100;
  const r = BV.verifyDay({
    appRows: rows, commPerCt: COMM,
    walkClosed: rows.map(x => ({ size: x.size })),
    brokerRealized: expectedNet,
  });
  assert.strictEqual(r.verdict, 'verified', JSON.stringify(r.checks, null, 1));
});
