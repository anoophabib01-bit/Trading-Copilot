'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TP = require('../trust-protocol');
const FO = require('../renderer/fold-only');

const RULES = { sizeCap: 2, commissionPerContractPerSide: 0.95 };

// ── The real 2026-08-31 record, verbatim from DATA/accounts/s2/ ──────────────
// This is the regression case. Every one of these numbers was on screen and
// presented as fact; the broker export said something different for all of them.
const REAL_FOLD_TRADES = [
  { t: 1788186756907, size: 5, pnl: -61.4, side: null, hold: 0, evidence: 'fold', source: 'live-fold-only', flags: ['oversize'] },
  { t: 1788187088066, size: 5, pnl: -1.5, side: 'LONG', hold: 116, evidence: 'fold', source: 'live-fold-only', flags: ['oversize', 'revenge'] },
];
const REAL_DAY = {
  date: '2026-08-31', n: 2, pnl: -62.9, gross: -43.9, wins: 1, losses: 1,
  maxSize: 5, avgWin: 8, avgLoss: -51.9, medHold: 0, disc: 63, revenge: 1, contracts: 10,
};

test('T1 catches the exact 2026-08-31 failure: per-trade stats from balance moves', () => {
  const r = TP.checkTradeDetailSupported(REAL_DAY, REAL_FOLD_TRADES);
  assert.strictEqual(r.sev, TP.SEV.FAIL);
  assert.match(r.msg, /balance moves only/);
  assert.match(r.msg, /best|worst|medHold|W\/1L/);
});

test('T1 passes once the day correctly publishes no per-trade statistics', () => {
  const suppressed = { date: '2026-08-31', n: 2, pnl: -62.9 };
  assert.strictEqual(TP.checkTradeDetailSupported(suppressed, REAL_FOLD_TRADES).sev, TP.SEV.OK);
});

test('T1 leaves a genuine trade-level day alone', () => {
  const trades = [{ size: 2, pnl: 30, side: 'LONG', hold: 35 }, { size: 1, pnl: -12, side: 'SHORT', hold: 9 }];
  assert.strictEqual(TP.checkTradeDetailSupported({ best: 30, worst: -12, wins: 1, losses: 1 }, trades).sev, TP.SEV.OK);
});

test('T1 treats an empty day as empty, never as unreconciled', () => {
  assert.strictEqual(TP.checkTradeDetailSupported({}, []).sev, TP.SEV.OK);
});

test('T2 fails the app recommending 5 contracts against a cap of 2', () => {
  const r = TP.checkSizeAdviceWithinCap({ size: 5 }, RULES);
  assert.strictEqual(r.sev, TP.SEV.FAIL);
  assert.match(r.msg, /5 contracts against a hard sizeCap of 2/);
});

test('T2 passes advice at or under the cap, and when no advice is given', () => {
  assert.strictEqual(TP.checkSizeAdviceWithinCap({ size: 2 }, RULES).sev, TP.SEV.OK);
  assert.strictEqual(TP.checkSizeAdviceWithinCap({ size: null }, RULES).sev, TP.SEV.OK);
});

test('T3 fails when EVERY trade lacks a side against a declared bias', () => {
  const bias = { total: 0, direction: { dir: 'LONG' } };
  const noSide = [{ pnl: -61.4, side: null }, { pnl: -1.5, side: null }];
  const r = TP.checkBiasComputable(bias, noSide);
  assert.strictEqual(r.sev, TP.SEV.FAIL);
  assert.match(r.msg, /no recorded side/);
  assert.match(r.msg, /could not be measured at all/);
});

test('T3 warns rather than fails when only some sides are missing', () => {
  const bias = { total: 1, direction: { dir: 'LONG' } };
  const r = TP.checkBiasComputable(bias, [{ side: 'LONG' }, { side: null }]);
  assert.strictEqual(r.sev, TP.SEV.WARN);
});

test('T3 stays quiet when no direction of record was declared', () => {
  assert.strictEqual(TP.checkBiasComputable({ direction: { dir: null } }, [{ side: null }]).sev, TP.SEV.OK);
});

test('T4 catches the understated gross from a wrong contract count', () => {
  // Real figures: gross -43.90 recorded against 10 contracts, but net was
  // -62.90. -43.90 - (10 x 0.95 x 2) = -62.90 would balance; the stored
  // contract count is what is wrong, and the drift is what exposes it.
  const r = TP.checkCommissionConsistency({ gross: -43.9, pnl: -62.9, contracts: 16 }, RULES);
  assert.strictEqual(r.sev, TP.SEV.WARN);
  assert.match(r.msg, /drift/);
});

test('T4 passes a self-consistent day', () => {
  // Broker truth: gross -31.00 over 16 contracts nets -61.40.
  const r = TP.checkCommissionConsistency({ gross: -31, pnl: -61.4, contracts: 16 }, RULES);
  assert.strictEqual(r.sev, TP.SEV.OK);
});

test('T5 flags numbers written while the feed knew it was degraded', () => {
  const r = TP.checkFeedTrustAtWrite({ brokerSummaryStale: true, closedRoundTripsScored: 0, tradeCount: 2 });
  assert.strictEqual(r.sev, TP.SEV.WARN);
  assert.match(r.msg, /stale/);
  assert.match(r.msg, /without a single scored round-trip/);
});

test('T5 is quiet on a healthy feed', () => {
  assert.strictEqual(TP.checkFeedTrustAtWrite({ brokerSummaryStale: false, closedRoundTripsScored: 10, tradeCount: 10 }).sev, TP.SEV.OK);
});

test('evaluate() on the real 2026-08-31 state reports FAIL and names the causes', () => {
  const out = TP.evaluate({
    day: REAL_DAY,
    trades: REAL_FOLD_TRADES,
    advice: { size: 5 },
    bias: { total: 1, direction: { dir: 'LONG' } },
    feed: { brokerSummaryStale: true, closedRoundTripsScored: 0, tradeCount: 2 },
  }, RULES);
  assert.strictEqual(out.severity, TP.SEV.FAIL);
  assert.ok(out.failed >= 2, 'T1 and T2 must both fail on this day');
  assert.match(out.summary, /TRUST FAIL/);
});

test('evaluate() on a clean day reports OK', () => {
  const out = TP.evaluate({
    day: { gross: -31, pnl: -61.4, contracts: 16, best: 30, worst: -59, wins: 6, losses: 4, medHold: 9 },
    trades: [{ size: 1, pnl: 30, side: 'LONG' }, { size: 2, pnl: -59, side: 'SHORT' }],
    advice: { size: 2 },
    bias: { total: 2, direction: { dir: 'LONG' } },
    feed: { brokerSummaryStale: false, closedRoundTripsScored: 10, tradeCount: 10 },
  }, RULES);
  assert.strictEqual(out.severity, TP.SEV.OK);
  assert.match(out.summary, /TRUST OK/);
});

// ── the shared predicate ────────────────────────────────────────────────────

test('fold-only: the real 2026-08-31 rows classify as fold-only and untrustworthy', () => {
  const c = FO.classify(REAL_FOLD_TRADES);
  assert.strictEqual(c.foldOnly, true);
  assert.strictEqual(c.unreconciled, true);
  assert.strictEqual(c.tradeDetailTrustworthy, false);
  assert.strictEqual(c.foldN, 2);
});

test('fold-only: an empty day is empty, not unreconciled', () => {
  const c = FO.classify([]);
  assert.strictEqual(c.foldOnly, false);
  assert.strictEqual(c.unreconciled, false);
  assert.strictEqual(FO.explain([]), null);
});

test('fold-only: a mixed day is unreconciled but reported differently', () => {
  const c = FO.classify([{ pnl: 1, source: 'live-fold-only' }, { pnl: 2, side: 'LONG' }]);
  assert.strictEqual(c.foldOnly, false);
  assert.strictEqual(c.mixed, true);
  assert.strictEqual(c.unreconciled, true);
  assert.match(FO.explain([{ source: 'live-fold-only' }, { side: 'LONG' }]), /only partly reconciled/);
});

test('fold-only: either marker is enough — evidence:fold without source', () => {
  assert.strictEqual(FO.isFoldRow({ evidence: 'fold' }), true);
  assert.strictEqual(FO.isFoldRow({ source: 'live-fold-only' }), true);
  assert.strictEqual(FO.isFoldRow({ side: 'LONG' }), false);
});

test('fold-only: explain() names the cause and the remedy, not just "unavailable"', () => {
  const msg = FO.explain(REAL_FOLD_TRADES);
  // Updated 2026-09-02: explain() no longer says "no trade detail" wholesale.
  // A fold knows P&L and size; it does not know price, side or hold. The
  // message must draw that line, because the earlier blanket wording is what
  // led the recap to blank four true tiles while printing one false one.
  assert.match(msg, /STILL ACCURATE/i);
  assert.match(msg, /per-trade P&L/i);
  assert.match(msg, /NOT AVAILABLE/i);
  assert.match(msg, /hold times/i);
  assert.match(msg, /unknown, not zero seconds/i);
  assert.match(msg, /Reconcile with a broker export/i);
});

test('fieldTrust: a fold knows money and size, but not timing, price or side', () => {
  const t = FO.fieldTrust(REAL_FOLD_TRADES);
  assert.strictEqual(t.money, true, 'balance deltas are real P&L');
  assert.strictEqual(t.size, true, 'contract counts are real');
  assert.strictEqual(t.timing, false, 'hold:0 means unknown, not zero seconds');
  assert.strictEqual(t.price, false);
  assert.strictEqual(t.side, false);
  assert.strictEqual(t.unreconciled, true);
});

test('fieldTrust: a fully reconciled day trusts everything', () => {
  const t = FO.fieldTrust([{ size: 2, pnl: 30, side: 'LONG', hold: 35, ep: 1, xp: 2 }]);
  assert.strictEqual(t.timing, true);
  assert.strictEqual(t.side, true);
  assert.strictEqual(t.unreconciled, false);
});

test('fieldTrust: an empty day claims no trust in anything', () => {
  const t = FO.fieldTrust([]);
  assert.strictEqual(t.money, false, 'no trades means no money facts to trust');
  assert.strictEqual(t.size, false);
});
