const test = require('node:test');
const assert = require('node:assert');
const BT = require('../bias-tracker.js');

const RULES = { biasAdherence: { enabled: true, targetPct: 75, warnPct: 60, minTradesToJudge: 2 } };
const T = (side, pnl) => ({ side: side, pnl: pnl, size: 2, flags: [] });

// ── Direction of record ───────────────────────────────────────────────────────

test('daily bias sets the direction; 4H/1H are context only', () => {
  // Anoop's call 2026-08-13. This is his ACTUAL record from that day.
  const r = BT.directionOfRecord({ bias: 'Bullish', h4: 'Bullish', h1: 'Conflicted' });
  assert.strictEqual(r.dir, 'LONG');
  assert.strictEqual(r.confidence, 'partial'); // 1H Conflicted → not full confidence
  assert.strictEqual(r.agree, 1);
  assert.strictEqual(r.disagree, 0);
});

test('all three aligned reads as full confidence', () => {
  const r = BT.directionOfRecord({ bias: 'Bearish', h4: 'Bearish', h1: 'Bearish' });
  assert.strictEqual(r.dir, 'SHORT');
  assert.strictEqual(r.confidence, 'full');
});

test('an HTF pointing the other way is contradicted, but does NOT veto the direction', () => {
  const r = BT.directionOfRecord({ bias: 'Bullish', h4: 'Bearish', h1: 'Bullish' });
  assert.strictEqual(r.dir, 'LONG');          // daily still wins — his decision
  assert.strictEqual(r.confidence, 'contradicted');
  assert.strictEqual(r.disagree, 1);
});

test('"Conflicted — wait" as the daily bias means no tradeable direction', () => {
  const r = BT.directionOfRecord({ bias: 'Conflicted — wait', h4: 'Bullish', h1: 'Bullish' });
  assert.strictEqual(r.dir, null);
  assert.strictEqual(r.confidence, 'none');
});

test('a blank/absent checklist yields no direction and does not throw', () => {
  assert.strictEqual(BT.directionOfRecord({}).dir, null);
  assert.strictEqual(BT.directionOfRecord(null).dir, null);
});

// ── Adherence ─────────────────────────────────────────────────────────────────

test('adherence counts trades in the declared direction', () => {
  const d = BT.dayAdherence({ bias: 'Bullish', date: '2026-08-12' },
    [T('LONG', 100), T('LONG', -20), T('SHORT', 50), T('LONG', 10)], RULES);
  assert.strictEqual(d.total, 4);
  assert.strictEqual(d.alignedN, 3);
  assert.strictEqual(d.counterN, 1);
  assert.strictEqual(d.adherencePct, 75);
  assert.strictEqual(d.alignedPnl, 90);
  assert.strictEqual(d.counterPnl, 50);
  assert.strictEqual(d.netPnl, 140);
});

test('a single-trade day is NOT judged — one counter-trend scratch is not a pattern', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('SHORT', -5)], RULES);
  assert.strictEqual(d.adherencePct, 0);
  assert.strictEqual(d.judged, false);
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.UNJUDGED);
});

test('trades without a side are ignored rather than counted as violations', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('LONG', 10), { pnl: 5 }, null], RULES);
  assert.strictEqual(d.total, 1);
  assert.strictEqual(d.alignedN, 1);
});

test('no declared direction means nothing is judged', () => {
  const d = BT.dayAdherence({ bias: '' }, [T('LONG', 10), T('SHORT', 10)], RULES);
  assert.strictEqual(d.adherencePct, null);
  assert.strictEqual(d.judged, false);
});

// ── Read verdict ──────────────────────────────────────────────────────────────

test('declaring a direction and never trading it is UNTESTED, not wrong', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('SHORT', -50), T('SHORT', -20)], RULES);
  assert.strictEqual(BT.readVerdict(d), 'UNTESTED');
});

test('read is RIGHT/WRONG based on what the in-direction trades did', () => {
  const good = BT.dayAdherence({ bias: 'Bullish' }, [T('LONG', 80), T('LONG', 20)], RULES);
  assert.strictEqual(BT.readVerdict(good), 'RIGHT');
  const bad = BT.dayAdherence({ bias: 'Bullish' }, [T('LONG', -80), T('LONG', 20)], RULES);
  assert.strictEqual(BT.readVerdict(bad), 'WRONG');
});

// ── The quadrant matrix ───────────────────────────────────────────────────────

test('EARNED_IT: followed the plan, read was right', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('LONG', 100), T('LONG', 50), T('LONG', 30), T('SHORT', -5)], RULES);
  assert.strictEqual(d.adherencePct, 75);
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.EARNED_IT);
});

test('HONEST_MISS: followed the plan, read was wrong — process is still a win', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('LONG', -100), T('LONG', -50)], RULES);
  assert.strictEqual(d.adherencePct, 100);
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.HONEST_MISS);
});

test('THE DANGEROUS ONE — GOT_AWAY_WITH_IT: broke the plan and got paid', () => {
  // This is the cell that teaches the wrong lesson. A profitable counter-trend
  // day must never read as a good day.
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('SHORT', 200), T('SHORT', 150), T('LONG', -10)], RULES);
  assert.strictEqual(d.adherencePct, 33);
  assert.ok(d.counterPnl > 0);
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.GOT_AWAY_WITH_IT);
});

test('DOUBLE_FAILURE: wrong read and traded against it anyway', () => {
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('SHORT', -200), T('SHORT', -150), T('LONG', -10)], RULES);
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.DOUBLE_FAILURE);
});

test('the target threshold comes from rules.json, never hardcoded', () => {
  const trades = [T('LONG', 50), T('LONG', 50), T('SHORT', -5)]; // 67% adherence
  const strict = BT.quadrantFor(BT.dayAdherence({ bias: 'Bullish' }, trades, RULES), RULES);
  const loose = BT.quadrantFor(
    BT.dayAdherence({ bias: 'Bullish' }, trades, { biasAdherence: { targetPct: 60, minTradesToJudge: 2 } }),
    { biasAdherence: { targetPct: 60, minTradesToJudge: 2 } });
  assert.strictEqual(strict, BT.QUADRANT.DOUBLE_FAILURE); // 67 < 75 → broke it, counter lost
  assert.strictEqual(loose, BT.QUADRANT.EARNED_IT);       // 67 >= 60 → followed it, read right
});

// ── Matrix aggregation ────────────────────────────────────────────────────────

test('buildMatrix answers the persuasive question: does following the plan pay HIM?', () => {
  const ckh = [
    { date: '2026-08-10', bias: 'Bullish' },
    { date: '2026-08-11', bias: 'Bearish' }
  ];
  const dt = {
    '2026-08-10': [T('LONG', 100), T('LONG', 60), T('SHORT', -40)],
    '2026-08-11': [T('SHORT', 40), T('LONG', -120)]
  };
  const m = BT.buildMatrix(ckh, dt, RULES);
  assert.strictEqual(m.rows.length, 2);
  assert.strictEqual(m.alignedTrades, 3);
  assert.strictEqual(m.counterTrades, 2);
  assert.strictEqual(m.alignedPnl, 200);
  assert.strictEqual(m.counterPnl, -160);
  assert.ok(m.alignedPerTrade > m.counterPerTrade);
});

test('buildMatrix tolerates days with a checklist but no trades, and vice versa', () => {
  const m = BT.buildMatrix(
    [{ date: '2026-08-10', bias: 'Bullish' }, { date: '2026-08-11', bias: '' }],
    { '2026-08-99': [T('LONG', 10)] }, RULES);
  assert.strictEqual(m.rows.length, 2);
  assert.strictEqual(m.daysJudged, 0);
  assert.strictEqual(m.avgAdherencePct, null);
});

test('buildMatrix on empty/garbage input does not throw', () => {
  assert.strictEqual(BT.buildMatrix(null, null, RULES).rows.length, 0);
  assert.strictEqual(BT.buildMatrix([null, { nodate: 1 }], {}, RULES).rows.length, 0);
});

test('precedentFor returns the most recent matching day, excluding today', () => {
  const ckh = [
    { date: '2026-08-05', bias: 'Bullish' },
    { date: '2026-08-06', bias: 'Bullish' },
    { date: '2026-08-07', bias: 'Bullish' }
  ];
  const bad = [T('SHORT', 200), T('SHORT', 100)];
  const m = BT.buildMatrix(ckh, { '2026-08-05': bad, '2026-08-06': bad, '2026-08-07': bad }, RULES);
  const p = BT.precedentFor(m, BT.QUADRANT.GOT_AWAY_WITH_IT, '2026-08-07');
  assert.strictEqual(p.date, '2026-08-06');
});

// ── Formatting ────────────────────────────────────────────────────────────────

test('post-checklist reminder states the direction and the target', () => {
  const txt = BT.formatPostChecklist({ bias: 'Bullish', h4: 'Bullish', h1: 'Conflicted' }, null, RULES);
  assert.match(txt, /LONG/);
  assert.match(txt, /75%/);
  assert.match(txt, /partial-confidence/);
});

test('post-checklist reminder calls out a contradicted higher timeframe', () => {
  const txt = BT.formatPostChecklist({ bias: 'Bullish', h4: 'Bearish', h1: 'Bullish' }, null, RULES);
  assert.match(txt, /points the OTHER way/);
});

test('no declared bias produces a prompt to set one, not a crash', () => {
  const txt = BT.formatPostChecklist({ bias: '' }, null, RULES);
  assert.match(txt, /did not declare a tradeable Daily Bias/);
});

test('context tells Jessi NOT to congratulate a profitable counter-trend day', () => {
  const ck = { date: '2026-08-13', bias: 'Bullish' };
  const trades = [T('SHORT', 200), T('SHORT', 150), T('LONG', -10)];
  const txt = BT.formatContext(ck, trades, BT.buildMatrix([ck], { '2026-08-13': trades }, RULES), RULES);
  assert.match(txt, /GOT AWAY WITH IT/);
  assert.match(txt, /Do NOT congratulate/);
});

test('context grades a disciplined losing day as a process win', () => {
  const ck = { date: '2026-08-13', bias: 'Bullish' };
  const trades = [T('LONG', -100), T('LONG', -50)];
  const txt = BT.formatContext(ck, trades, null, RULES);
  assert.match(txt, /HONEST MISS/);
  assert.match(txt, /READ needs work, not the rules/);
});

test('context warns below the warnPct floor from rules.json', () => {
  const ck = { date: '2026-08-13', bias: 'Bullish' };
  const trades = [T('SHORT', -10), T('SHORT', -10), T('LONG', 5)]; // 33%
  const txt = BT.formatContext(ck, trades, null, RULES);
  assert.match(txt, /BELOW his own 60% floor/);
});

test('no checklist today means Jessi is told there is no direction of record', () => {
  const txt = BT.formatContext(null, [], null, RULES);
  assert.match(txt, /no pre-trade checklist recorded today/);
});

test('the whole feature can be switched off from rules.json', () => {
  assert.strictEqual(BT.formatContext({ bias: 'Bullish' }, [], null, { biasAdherence: { enabled: false } }), '');
});

test('REGRESSION: declared LONG, took only profitable SHORTs — the most extreme got-away-with-it', () => {
  // This escaped classification as UNJUDGED before 2026-08-13: because zero
  // in-direction trades meant the READ was untestable, the whole day fell
  // through and the matrix stayed silent about the single worst pattern in it.
  const d = BT.dayAdherence({ bias: 'Bullish' }, [T('SHORT', 200), T('SHORT', 100)], RULES);
  assert.strictEqual(d.alignedN, 0);
  assert.strictEqual(d.adherencePct, 0);
  assert.strictEqual(BT.readVerdict(d), 'UNTESTED');
  assert.strictEqual(BT.quadrantFor(d, RULES), BT.QUADRANT.GOT_AWAY_WITH_IT);
});

test('rows with no side are counted, not silently dropped', () => {
  // The 2026-08-31 shape: broker feed lost trade-level detail, so every row
  // carried side:null. Filtering them away left zero judgeable trades and the
  // day reported nothing — indistinguishable from a clean day.
  const ck = { date: '2026-08-31', bias: 'Bullish', h4: 'Bullish', h1: 'Bullish' };
  const out = BT.dayAdherence(ck, [
    { pnl: -61.4, side: null }, { pnl: -1.5, side: null },
  ], {});
  assert.strictEqual(out.unknownSide, 2);
  assert.strictEqual(out.unknownSideAll, true);
  assert.strictEqual(out.total, 0, 'still nothing judgeable...');
  assert.notStrictEqual(out.unknownSide, 0, '...but the reason is now visible');
});

test('a fully-sided day reports unknownSide 0', () => {
  const ck = { date: '2026-08-31', bias: 'Bullish', h4: 'Bullish', h1: 'Bullish' };
  const out = BT.dayAdherence(ck, [{ pnl: 5, side: 'LONG' }, { pnl: -2, side: 'SHORT' }], {});
  assert.strictEqual(out.unknownSide, 0);
  assert.strictEqual(out.unknownSideAll, false);
  assert.strictEqual(out.total, 2);
});
