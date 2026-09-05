'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ED = require('../exit-drift');

const MIN = 60000;
const T0 = 1788180000000;                       // arbitrary fixed base — no clock in tests
const bar = (mins, h, l, c) => ({ t: T0 + mins * MIN, h, l, c, o: c });
const trade = (side, xp, exitMin) => ({ side, xp, x: T0 + exitMin * MIN });

// Exit at 29400. Bars afterwards drift up to 29420.
const UP_BARS = [bar(1, 29405, 29398, 29404), bar(2, 29412, 29403, 29410), bar(3, 29422, 29409, 29420)];
const DOWN_BARS = [bar(1, 29402, 29392, 29394), bar(2, 29396, 29384, 29386), bar(3, 29390, 29378, 29380)];

test('a LONG exit that kept running is EARLY — money left on the table', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE);
  assert.strictEqual(d.quality, ED.QUALITY.EARLY);
  assert.strictEqual(d.netDrift, 20);
  assert.strictEqual(d.atrUnits, 2);
});

test('a LONG exit followed by a drop is a GOOD exit', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: DOWN_BARS, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.BELOW);
  assert.strictEqual(d.quality, ED.QUALITY.WELL);
});

test('SHORT inverts exit quality against the same drift', () => {
  const up = ED.computeExitDrift({ lastTrade: trade('SHORT', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN });
  const down = ED.computeExitDrift({ lastTrade: trade('SHORT', 29400, 0), bars: DOWN_BARS, atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(up.quality, ED.QUALITY.WELL, 'short + price up = the exit saved him');
  assert.strictEqual(down.quality, ED.QUALITY.EARLY, 'short + price down = he cut it early');
});

test('TRAP 1: drift under the ATR threshold is NO_READ, not a direction', () => {
  // 4 points on a 20-point ATR is 0.2 ATR — noise.
  const flat = [bar(1, 29403, 29397, 29401), bar(2, 29405, 29398, 29404)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: flat, atr: 20, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.verdict, ED.VERDICT.NO_READ);
  assert.match(d.reason, /noise, not a direction/);
});

test('TRAP 1: the same points ARE a read in a quieter regime', () => {
  const flat = [bar(1, 29403, 29397, 29401), bar(2, 29405, 29398, 29404)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: flat, atr: 4, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE, 'ATR normalisation is the whole point');
});

test('TRAP 2: inside the cooldown the verdict is withheld, however big the drift', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 5 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.COOLING);
  assert.strictEqual(d.netDrift, 20, 'the number is still computed for later review');
  assert.match(d.reason, /how a re-entry starts/);
});

test('cooldown is configurable and 0 disables it', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 5 * MIN,
    cfg: { cooldownMinutes: 0 },
  });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE);
});

test('a fold-only trade has no exit price, so there is no read', () => {
  const d = ED.computeExitDrift({
    lastTrade: { side: null, xp: null, x: T0, source: 'live-fold-only' },
    bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.UNKNOWN);
  assert.match(d.reason, /reconstructed from balance moves/);
});

test('bars at or before the exit are excluded — that movement was not post-exit', () => {
  const straddling = [bar(-5, 29500, 29300, 29450), bar(1, 29405, 29398, 29404), bar(2, 29412, 29403, 29410)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: straddling, atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.barsUsed, 2);
  assert.strictEqual(d.maxUp, 12, 'the pre-exit 29500 high must not inflate the range');
});

test('too few bars is an honest "not yet", not a zero drift', () => {
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: [bar(1, 29405, 29398, 29404)], atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.verdict, ED.VERDICT.UNKNOWN);
  assert.match(d.reason, /not enough to call a drift/);
});

test('no ATR means no verdict — it does not fall back to a point threshold', () => {
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: null, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.verdict, ED.VERDICT.NO_READ);
  assert.match(d.reason, /No ATR/);
});

test('no trade at all is handled without throwing', () => {
  const d = ED.computeExitDrift({ lastTrade: null, bars: UP_BARS, atr: 10, nowMs: T0 });
  assert.strictEqual(d.verdict, ED.VERDICT.UNKNOWN);
  assert.match(d.reason, /No completed trade/);
});

test('maxUp and maxDown report the full post-exit range, not just the close', () => {
  const whipsaw = [bar(1, 29450, 29350, 29400), bar(2, 29430, 29370, 29405)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: whipsaw, atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.maxUp, 50);
  assert.strictEqual(d.maxDown, 50);
  assert.strictEqual(d.netDrift, 5, 'net is where it ENDED, range is where it WENT');
});

test('formatExitDrift leads with exit quality, not with the direction hint', () => {
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN });
  const s = ED.formatExitDrift(d);
  assert.ok(s.indexOf('left') < s.indexOf('ABOVE'), 'the decision he can learn from comes before the hint');
  assert.match(s, /Range since/);
});

test('formatExitDrift says nothing suggestive while cooling', () => {
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 2 * MIN });
  assert.match(ED.formatExitDrift(d), /held back/);
});

test('atrFromBars includes the gap from the prior close, not just bar range', () => {
  const bars = [bar(0, 100, 90, 95), bar(1, 120, 115, 118)];
  // Bar range is 5, but the gap from the prior close of 95 up to 120 is 25.
  assert.strictEqual(ED.atrFromBars(bars, 14), 25);
});

test('atrFromBars refuses to invent a value from too little data', () => {
  assert.strictEqual(ED.atrFromBars([], 14), null);
  assert.strictEqual(ED.atrFromBars([bar(0, 100, 90, 95)], 14), null);
});

test('atrFromBars averages only the last `period` true ranges', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(bar(i, 100 + i, 90 + i, 95 + i));
  const a = ED.atrFromBars(many, 5);
  assert.ok(a > 0 && a < 20, 'a sane ATR, bounded by the bar construction');
});

// ── strength score (1-10 from candle movement) ──────────────────────────────

test('a clean one-way run scores higher than a whipsaw ending in the same place', () => {
  const clean = [bar(1, 29406, 29400, 29405), bar(2, 29412, 29405, 29411), bar(3, 29421, 29411, 29420)];
  const choppy = [bar(1, 29460, 29340, 29350), bar(2, 29455, 29345, 29440), bar(3, 29470, 29360, 29420)];
  const a = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: clean, atr: 10, nowMs: T0 + 30 * MIN });
  const b = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: choppy, atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(a.netDrift, b.netDrift, 'identical net drift...');
  assert.ok(a.strength.score > b.strength.score, '...but the clean run must score higher');
  assert.ok(a.strength.efficiency > b.strength.efficiency);
});

test('the score is null whenever the verdict is not a real read', () => {
  const noise = [bar(1, 29403, 29397, 29401), bar(2, 29405, 29398, 29404)];
  const nr = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: noise, atr: 20, nowMs: T0 + 30 * MIN });
  assert.strictEqual(nr.verdict, ED.VERDICT.NO_READ);
  assert.strictEqual(nr.strength, null, 'a 3/10 over noise claims more than NO_READ does');

  const cooling = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 2 * MIN });
  assert.strictEqual(cooling.strength, null);
});

test('the score stays inside 1-10 at both extremes', () => {
  const huge = [bar(1, 30000, 29400, 29900), bar(2, 30500, 29900, 30400), bar(3, 31000, 30400, 30900)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: huge, atr: 10, nowMs: T0 + 30 * MIN });
  assert.ok(d.strength.score >= 1 && d.strength.score <= 10);
  assert.strictEqual(d.strength.label, 'decisive');
});

test('consistency walks CLOSES — a wick the right way that closes back does not count', () => {
  // Each bar wicks up hard but closes lower than the one before it.
  const rejected = [bar(1, 29480, 29380, 29390), bar(2, 29470, 29370, 29380), bar(3, 29460, 29360, 29370)];
  const d = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: rejected, atr: 10, nowMs: T0 + 30 * MIN });
  assert.strictEqual(d.verdict, ED.VERDICT.BELOW);
  assert.ok(d.strength.consistency >= 0.9, 'closes all moved down, so the DOWN drift is consistent');
});

test('scoreDrift refuses a result it was not given a verdict for', () => {
  assert.strictEqual(ED.scoreDrift(null, []), null);
  assert.strictEqual(ED.scoreDrift({ verdict: 'NO_READ' }, []), null);
});

// ── REGRESSION: seconds-vs-milliseconds bar timestamps (bug found 2026-09-02) ─
//
// Every test above builds bars with `t` already in MILLISECONDS, which is why
// the suite was fully green while the live panel had never once rendered.
// The real source, data_get_ohlcv, returns `{time: <SECONDS>, open, high, low,
// close}` — a shape no test used. Compared raw against a ms exit stamp, every
// bar failed the post-exit filter, so barsAfter returned 0 and the verdict was
// UNKNOWN forever. The renderer hides the box on UNKNOWN, so the failure was
// silent: not a wrong number, no number at all.
//
// These tests pin the LIVE shape specifically. Do not "tidy" them to use the
// bar() helper above — using it is what let the bug through.
const sbar = (secs, h, l, c) => ({ time: secs, high: h, low: l, close: c, open: c });
const T0_SEC = T0 / 1000;

test('REGRESSION: bars timestamped in SECONDS are counted as post-exit', () => {
  const bars = [sbar(T0_SEC + 60, 29405, 29398, 29404),
                sbar(T0_SEC + 120, 29412, 29403, 29410),
                sbar(T0_SEC + 180, 29422, 29409, 29420)];
  assert.strictEqual(ED.barsAfter(bars, T0, null, T0 + 30 * MIN).length, 3,
    'a seconds-stamped bar after the exit must not be filtered out');
});

test('REGRESSION: the live data_get_ohlcv shape produces a real verdict, not UNKNOWN', () => {
  const bars = [sbar(T0_SEC + 60, 29405, 29398, 29404),
                sbar(T0_SEC + 120, 29412, 29403, 29410),
                sbar(T0_SEC + 180, 29422, 29409, 29420)];
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE);
  assert.strictEqual(d.quality, ED.QUALITY.EARLY);
  assert.strictEqual(d.netDrift, 20);
  assert.strictEqual(d.barsUsed, 3);
});

test('REGRESSION: seconds and millisecond bars agree on the same verdict', () => {
  const ms  = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN });
  const sec = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), atr: 10, nowMs: T0 + 30 * MIN,
    bars: UP_BARS.map((b) => ({ time: b.t / 1000, high: b.h, low: b.l, close: b.c, open: b.o })),
  });
  assert.strictEqual(sec.verdict, ms.verdict);
  assert.strictEqual(sec.netDrift, ms.netDrift);
  assert.strictEqual(sec.maxUp, ms.maxUp);
  assert.strictEqual(sec.maxDown, ms.maxDown);
});

test('REGRESSION: a seconds bar BEFORE the exit is still excluded', () => {
  const bars = [sbar(T0_SEC - 120, 29500, 29490, 29495),   // before exit — must not count
                sbar(T0_SEC + 60, 29405, 29398, 29404),
                sbar(T0_SEC + 120, 29412, 29403, 29410)];
  const used = ED.barsAfter(bars, T0, null, T0 + 30 * MIN);
  assert.strictEqual(used.length, 2, 'pre-exit movement is not post-exit drift');
  assert.ok(used.every((b) => b.time > T0_SEC));
});

test('toMs: identity for milliseconds, scales seconds, and null stays null', () => {
  assert.strictEqual(ED.toMs(1788187088066), 1788187088066);
  assert.strictEqual(ED.toMs(1788187088), 1788187088000);
  assert.strictEqual(ED.toMs(null), null);
  assert.strictEqual(ED.toMs(undefined), null);
});

test('barsAfter stays clock-free when nowMs is supplied with a window', () => {
  const bars = [sbar(T0_SEC + 60, 29405, 29398, 29404),
                sbar(T0_SEC + 6000, 29412, 29403, 29410)];
  // A 30-min window measured from a CALLER-SUPPLIED now, not the wall clock:
  // without threading nowMs this assertion would depend on the day it runs.
  const used = ED.barsAfter(bars, T0, 30, T0 + 120 * MIN);
  assert.strictEqual(used.length, 1);
});

// ── Coverage honesty (2026-09-02) ────────────────────────────────────────────
// runExitDrift asks for a FIXED 120 bars, so on a 1m chart they span ~2 hours
// while the exit being anchored on can be days old. maxUp/maxDown are then a
// range over the bars we happen to hold, and calling that "Range since your
// exit" is precisely the confident-wrong-answer this repo's trust protocol
// exists to prevent. netDrift is unaffected — it only needs the latest close.
test('bars that start after the exit are reported as PARTIAL coverage', () => {
  // Exit at T0; the only bars available begin 24h later.
  const late = 24 * 60;
  const bars = [bar(late + 1, 29405, 29398, 29404),
                bar(late + 2, 29412, 29403, 29410),
                bar(late + 3, 29422, 29409, 29420)];
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars, atr: 10, nowMs: T0 + (late + 30) * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE);
  assert.strictEqual(d.partialCoverage, true);
  assert.strictEqual(d.coverageMinutes, 2, 'the true span of the bars, not the age of the exit');
  assert.strictEqual(d.minutesSince, late + 30, 'minutesSince still measures from the exit');
  assert.match(ED.formatExitDrift(d), /Range over the last 2 min/);
  assert.doesNotMatch(ED.formatExitDrift(d), /Range since/);
});

test('bars reaching back to the exit report FULL coverage', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.partialCoverage, false);
  assert.strictEqual(d.coverageMinutes, d.minutesSince);
  assert.match(ED.formatExitDrift(d), /Range since/);
});

test('coverage fields are present on every early-return path, never undefined', () => {
  const noTrade = ED.computeExitDrift({ lastTrade: null, nowMs: T0 });
  const noExit  = ED.computeExitDrift({ lastTrade: { side: 'LONG', xp: null, x: T0 }, nowMs: T0 });
  const fewBars = ED.computeExitDrift({ lastTrade: trade('LONG', 29400, 0), bars: [], atr: 10, nowMs: T0 + 30 * MIN });
  for (const d of [noTrade, noExit, fewBars]) {
    assert.strictEqual(d.coverageMinutes, null);
    assert.strictEqual(d.partialCoverage, false);
  }
});

// ── Tick distance (2026-09-02) ───────────────────────────────────────────────
// The tick size is supplied by the caller from TradingView's symbol_info, never
// hardcoded here: MNQ ticks at 0.25 and MGC at 0.10, and this module cannot see
// which symbol is on the chart. Absent a tick size the reading stays in points.
test('ticks are derived from the supplied tick size, not assumed', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN, tickSize: 0.25,
  });
  assert.strictEqual(d.netDrift, 20);
  assert.strictEqual(d.tickSize, 0.25);
  assert.strictEqual(d.ticks, 80, '20 points at 0.25/tick is 80 ticks');
  assert.strictEqual(d.maxUpTicks, 88);   // 22 pts
  assert.strictEqual(d.maxDownTicks, 8);  //  2 pts
});

test('a different contract tick size gives a different tick count for the same points', () => {
  const mgc = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN, tickSize: 0.1,
  });
  assert.strictEqual(mgc.netDrift, 20);
  assert.strictEqual(mgc.ticks, 200, 'the same 20 points is 200 ticks at 0.10 — why it is never hardcoded');
});

test('no tick size means NO tick count — points only, nothing invented', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.tickSize, null);
  assert.strictEqual(d.ticks, null);
  assert.strictEqual(d.maxUpTicks, null);
  assert.strictEqual(d.netDrift, 20, 'the point reading is unaffected');
  assert.doesNotMatch(ED.formatExitDrift(d), /ticks/);
});

test('a zero or negative tick size is refused rather than dividing by it', () => {
  for (const ts of [0, -0.25]) {
    const d = ED.computeExitDrift({
      lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN, tickSize: ts,
    });
    assert.strictEqual(d.tickSize, null);
    assert.strictEqual(d.ticks, null);
  }
});

test('the formatted line states both units when ticks are known', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 30 * MIN, tickSize: 0.25,
  });
  assert.match(ED.formatExitDrift(d), /20 pts \/ 80 ticks/);
});

test('toTicks rounds float dust to a whole tick', () => {
  assert.strictEqual(ED.toTicks(195, 0.25), 780);
  assert.strictEqual(ED.toTicks(-195, 0.25), -780);
  assert.strictEqual(ED.toTicks(0, 0.25), 0);
  assert.strictEqual(ED.toTicks(null, 0.25), null);
  assert.strictEqual(ED.toTicks(10, null), null);
});

test('tick fields exist on refused paths too, never undefined', () => {
  const cooling = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: UP_BARS, atr: 10, nowMs: T0 + 2 * MIN, tickSize: 0.25,
  });
  assert.strictEqual(cooling.verdict, ED.VERDICT.COOLING);
  assert.strictEqual(cooling.ticks, 80, 'numbers stay available to a post-session view');
  const none = ED.computeExitDrift({ lastTrade: null, nowMs: T0 });
  assert.strictEqual(none.ticks, null);
  assert.strictEqual(none.tickSize, null);
});

// ── Instrument mismatch (2026-09-02, found live) ─────────────────────────────
// The chart is not a fixed instrument: the PO3 secondary-symbol watch flips it
// between MNQ and MGC, and data_get_ohlcv returns whatever is on screen. Read
// during an MGC window, an MNQ exit at 29406 against gold bars at ~4371 would
// have been reported as a confident 25,035-point drift, complete with an ATR
// figure, a 1-10 score and a bias comparison built on top of it.
const goldBar = (mins, h, l, c) => ({ t: T0 + mins * MIN, h, l, c, o: c });
const GOLD_BARS = [goldBar(1, 4375, 4368, 4371), goldBar(2, 4378, 4370, 4374), goldBar(3, 4380, 4372, 4377)];

test('an MNQ exit read against MGC bars is refused, not reported as a drift', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29406.5, 0), bars: GOLD_BARS, atr: 3,
    nowMs: T0 + 30 * MIN, tickSize: 0.1, symbol: 'MGC1!',
  });
  assert.strictEqual(d.verdict, ED.VERDICT.MISMATCH);
  assert.strictEqual(d.netDrift, null, 'no drift number is computed at all');
  assert.strictEqual(d.strength, null, 'and therefore no score');
  assert.match(d.reason, /different instrument/);
  assert.match(d.reason, /MGC1!/, 'the refusal names the symbol it actually found');
});

test('the mismatch refusal survives into the formatted line', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29406.5, 0), bars: GOLD_BARS, atr: 3, nowMs: T0 + 30 * MIN, symbol: 'MGC1!',
  });
  assert.match(ED.formatExitDrift(d), /different instrument/);
});

test('a mismatched read yields no bias alignment', () => {
  const AL = require('../exit-bias-align');
  const BT = require('../bias-tracker');
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29406.5, 0), bars: GOLD_BARS, atr: 3, nowMs: T0 + 30 * MIN, symbol: 'MGC1!',
  });
  const a = AL.alignExitDrift(d, BT.directionOfRecord({ bias: 'Bearish', h4: 'Bearish', h1: 'Bearish' }), {});
  assert.strictEqual(a.status, AL.ALIGN.NO_DRIFT, 'nonsense must not feed the bias read');
});

// The guard must never fire on a real move, however violent.
test('a huge but real MNQ drift is still a drift, not a mismatch', () => {
  // 29400 -> 26500: a 10% collapse, far larger than any real session.
  const crash = [goldBar(1, 29400, 26400, 26500), goldBar(2, 26600, 26300, 26450), goldBar(3, 26500, 26200, 26350)];
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 29400, 0), bars: crash, atr: 200, nowMs: T0 + 30 * MIN,
  });
  assert.strictEqual(d.verdict, ED.VERDICT.BELOW, 'a 10% move is real and must still read');
  assert.notStrictEqual(d.verdict, ED.VERDICT.MISMATCH);
});

test('MGC traded and MGC on the chart reads normally', () => {
  const d = ED.computeExitDrift({
    lastTrade: trade('LONG', 4370, 0), bars: GOLD_BARS, atr: 3, nowMs: T0 + 30 * MIN, tickSize: 0.1, symbol: 'MGC1!',
  });
  assert.strictEqual(d.verdict, ED.VERDICT.ABOVE);
  assert.strictEqual(d.netDrift, 7);
  assert.strictEqual(d.ticks, 70);
});
