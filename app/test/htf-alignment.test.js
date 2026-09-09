'use strict';
// ── The one gate above every playbook ─────────────────────────────────────
// Anoop's spec, 2026-09-03: "The structure HH-HL/LL-LH is read in one hour —
// change it to 15 mins which should agree with 1hr not 4hr... i will check 4hr
// and daily candle manually."
//
// These pin the three things that make that true: structure comes from the
// 15M, the 1H is read and reported, and an unreadable 15M refuses rather than
// guesses.
//
// The CONFIRMING timeframe cannot veto. That was settled for the 4H on
// 2026-09-01 ("trigger it on even if 4hr does not confirm stating the same as
// evidence") and the 1H inherits the same role when it takes the 4H's place —
// measured, because a 1H veto would open the gate on only 21.1% of checks
// against 71.3% ungated, which is the "most of the current watching does not
// trigger" complaint that prompted the move in the first place. So the tests
// below assert that a disagreeing 1H lets the trade through AND is recorded
// on it.
//
// ── WHY THESE FIXTURES ARE ZIGZAGS AND NOT RAMPS ──────────────────────────
// They used to be strictly monotonic ramps (every bar higher than the last).
// That is not market structure — it is a straight line, and a straight line
// contains NO swing pivots at all. The ramps passed against the old
// consecutive-candle trend read and would have passed against almost anything,
// which is exactly why they did not catch the gate being wired to a function
// calibrated for a 5-bar window and fed 39.
//
// Every fixture below is a wave: a repeating 6-bar swing plus a drift, so it
// actually contains higher highs and higher lows the way a chart does. The
// swing amplitude (±30pt) is deliberately well above findPivots' 0.05%
// collapse tolerance (~14.5pt at MNQ 29,000), so consecutive pivots stay
// distinct instead of merging into one.
const test = require('node:test');
const assert = require('node:assert');
const htf = require('../htf-alignment.js');
const { classifyStructureFromPivots } = require('../detectors.js');

const SHAPE = [0, 3, 6, 3, 0, -3];   // one 6-bar swing: peak at i%6===2, trough at 5
function zig(n, drift, base = 29000, amp = 10) {
  return Array.from({ length: n }, (_, i) => {
    const lvl = base + drift * i + SHAPE[i % 6] * amp;
    return { time: i * 900, open: lvl - 2, high: lvl + 1, low: lvl - 1, close: lvl + 2 };
  });
}
const up = (n) => zig(n, 10);     // ascending swing highs AND lows
const down = (n) => zig(n, -10);  // descending both
const flat = (n) => zig(n, 0);    // same swing forever — no directional structure

// A straight line, no swings. Kept as a named fixture because it is the shape
// the old tests used, and the regression test below depends on it.
const ramp = (n) => Array.from({ length: n }, (_, i) =>
  ({ time: i * 900, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));

test('15M up + 1H up = bullish bias', () => {
  const r = htf.readHTF(up(40), up(20));
  assert.equal(r.ok, true);
  assert.equal(r.bias, 'bullish');
  assert.equal(r.structure15m, 'bullish');
  assert.equal(r.structure1h, 'bullish');
});

test('15M down + 1H down = bearish bias', () => {
  const r = htf.readHTF(down(40), down(20));
  assert.equal(r.bias, 'bearish');
});

// ── THE STRUCTURE READ IS THE 15M, AND ONLY THE 15M (2026-09-03) ──────────
// The load-bearing assertion of the whole change: swapping the two arguments
// must swap the bias. If a refactor ever quietly restored the 1H as the
// decider, every other test here would still pass — they mostly feed the same
// direction to both — and this one would not.
test('the 15M decides the bias; the 1H is the second argument and cannot', () => {
  assert.equal(htf.readHTF(up(40), down(20)).bias, 'bullish', '15M up wins');
  assert.equal(htf.readHTF(down(40), up(20)).bias, 'bearish', '15M down wins');
});

// ── THE 1H IS EVIDENCE, NOT PERMISSION ───────────────────────────────────
// It used to be the 4H holding this role and it used to be a veto. Neither is
// true now. These pin BOTH halves: the trade is allowed, AND the
// non-confirmation is recorded and stated.
test('a DISAGREEING 1H no longer blocks — it fires and is recorded as evidence', () => {
  const r = htf.readHTF(up(40), down(20));
  assert.equal(r.ok, true, 'the 1H may not veto a clean 15M bias');
  assert.equal(r.bias, 'bullish', 'the bias is the 15M read, alone');
  assert.equal(r.confirmation, htf.CONFIRMATION.DISAGREES);
  // and it still reports BOTH reads, so the evidence is auditable
  assert.equal(r.structure15m, 'bullish');
  assert.equal(r.structure1h, 'bearish');
  // the setup is genuinely allowed through, not merely flagged
  assert.equal(htf.checkSetup(r, 'BULLISH').allowed, true);
});

test('an UNCLEAR 1H does not confirm, but no longer refuses either', () => {
  const r = htf.readHTF(up(40), flat(20));
  assert.equal(r.ok, true);
  assert.equal(r.confirmation, htf.CONFIRMATION.UNCLEAR,
    'silence is still not agreement — it is just not a veto');
});

test('a MISSING 1H fires too, and says unavailable rather than disagrees', () => {
  const r = htf.readHTF(up(40), []);
  assert.equal(r.ok, true);
  assert.equal(r.confirmation, htf.CONFIRMATION.UNAVAILABLE);
  assert.equal(r.structure1h, null);
  // The distinction the module exists to protect: no bars is not an opinion.
  assert.notEqual(r.confirmation, htf.CONFIRMATION.DISAGREES);
});

test('a CONFIRMING 1H is marked as such, so the two cases are separable later', () => {
  const r = htf.readHTF(up(40), up(20));
  assert.equal(r.confirmation, htf.CONFIRMATION.CONFIRMED);
});

test('confirmationNote STATES the evidence — a 15M-only fire must say so', () => {
  assert.match(htf.confirmationNote(htf.readHTF(up(40), down(20))), /15M ONLY/);
  assert.match(htf.confirmationNote(htf.readHTF(up(40), down(20))), /1H DISAGREES/);
  assert.match(htf.confirmationNote(htf.readHTF(up(40), flat(20))), /15M ONLY/);
  assert.match(htf.confirmationNote(htf.readHTF(up(40), [])), /15M ONLY/);
  // the aligned case must NOT claim to be 15M-only
  const aligned = htf.confirmationNote(htf.readHTF(up(40), up(20)));
  assert.match(aligned, /WITH the higher timeframe/);
  assert.doesNotMatch(aligned, /15M ONLY/);
  // and nothing that never opened the gate gets a note at all
  assert.equal(htf.confirmationNote(htf.readHTF(flat(40), up(20))), '');
});

test('no bias means no confirmation — the 1H has nothing to have an opinion on', () => {
  const r = htf.readHTF(flat(40), up(20));
  assert.equal(r.ok, false);
  assert.equal(r.confirmation, null,
    'an unclear 15M and an unclear 1H must not read as mutually "confirmed"');
  assert.equal(htf.readHTF(flat(40), flat(20)).confirmation, null);
});

test('an unclear 15M yields no bias regardless of the 1H', () => {
  const r = htf.readHTF(flat(40), up(20));
  assert.equal(r.ok, false);
  assert.equal(r.bias, null);
  assert.equal(r.reason, htf.REASONS.UNCLEAR_15M);
});

test('missing 15M data REFUSES, and says so distinctly from a rule refusal', () => {
  const no15 = htf.readHTF([], up(20));
  assert.equal(no15.ok, false);
  assert.equal(no15.reason, htf.REASONS.NO_15M_DATA);

  // The distinction is the point: a degraded app must never look like a
  // working rule, or the trader learns to override the rule. The 15M is the
  // only timeframe that can still produce this refusal.
  const unclear = htf.readHTF(flat(40), up(20));
  assert.equal(unclear.reason, htf.REASONS.UNCLEAR_15M);
  assert.notEqual(no15.reason, unclear.reason);
});

test('too few 15M bars is treated as missing, not as unclear', () => {
  assert.equal(htf.readHTF(up(5), up(20)).reason, htf.REASONS.NO_15M_DATA);
  // 23 is one short of MIN_BARS_15M. The floor is 24 because a 12-bar window
  // reads cleanly on 1.4% of real MNQ 15M bars — see the module header.
  assert.equal(htf.readHTF(up(htf.MIN_BARS_15M - 1), up(20)).reason, htf.REASONS.NO_15M_DATA);
  assert.notEqual(htf.readHTF(up(htf.MIN_BARS_15M), up(20)).reason, htf.REASONS.NO_15M_DATA);
  // too few 1H bars is not a refusal at all — it is evidence
  const thin1h = htf.readHTF(up(40), up(3));
  assert.equal(thin1h.ok, true);
  assert.equal(thin1h.confirmation, htf.CONFIRMATION.UNAVAILABLE);
});

// ── checkSetup: every playbook judged against the SAME computed bias ───────
test('a setup matching the bias passes', () => {
  const r = htf.checkSetup(htf.readHTF(up(40), up(20)), 'BULLISH');
  assert.equal(r.allowed, true);
  assert.equal(r.bias, 'bullish');
});

test('a setup against the bias is refused', () => {
  const r = htf.checkSetup(htf.readHTF(up(40), up(20)), 'BEARISH');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, htf.REASONS.SETUP_DISAGREES);
});

test('when the gate never opened, NO setup passes in either direction', () => {
  const blocked = htf.readHTF(flat(40), up(20));   // 15M unreadable
  for (const dir of ['BULLISH', 'BEARISH']) {
    const r = htf.checkSetup(blocked, dir);
    assert.equal(r.allowed, false, `${dir} must not pass a closed gate`);
    // it inherits the GATE's reason, not a setup-mismatch reason — the setup
    // was never the problem
    assert.equal(r.reason, htf.REASONS.UNCLEAR_15M);
  }
});

test('checkSetup carries the 1H evidence through to the caller', () => {
  const r = htf.checkSetup(htf.readHTF(up(40), down(20)), 'BULLISH');
  assert.equal(r.allowed, true);
  assert.equal(r.confirmation, htf.CONFIRMATION.DISAGREES,
    'the caller must be able to label the alert without re-reading the 1H');
  assert.equal(r.structure15m, 'bullish');
  assert.equal(r.structure1h, 'bearish');
});

test('a missing/garbage htf read refuses rather than throwing', () => {
  assert.equal(htf.checkSetup(null, 'BULLISH').allowed, false);
  assert.equal(htf.checkSetup({}, 'BULLISH').allowed, false);
  assert.equal(htf.checkSetup(htf.readHTF(up(40), up(20)), 'sideways').allowed, false);
});

test('explain() names the numbers, not just the verdict', () => {
  const fired = htf.explain(htf.readHTF(up(40), down(20)));
  assert.match(fired, /bias bullish/);
  assert.match(fired, /1H DISAGREES/);
  const missing = htf.explain(htf.readHTF([], up(20)));
  assert.match(missing, /UNAVAILABLE/);
  assert.match(missing, /Refusing rather than guessing/);
});

// ── HISTORICAL REASON CODES STAY RESOLVABLE ───────────────────────────────
// DATA/signals/*.jsonl already holds rows stamped htf-1h-unclear and
// htf-4h-disagrees-with-1h from the two days the 1H decided and the 4H
// confirmed. Those codes are unreachable now, but a reader of that history
// must still get a sentence rather than a raw slug — and the sentence must say
// it is historical, so nobody debugging a live gate goes hunting for a branch
// that cannot fire.
test('a ledger row written before 2026-09-03 still explains itself', () => {
  for (const reason of [htf.REASONS.NO_1H_DATA, htf.REASONS.UNCLEAR_1H,
    htf.REASONS.NO_4H_DATA, htf.REASONS.H4_DISAGREES]) {
    const line = htf.explain({ reason, structure1h: 'bullish', structure4h: 'bearish' });
    assert.match(line, /historical row/, reason + ' must be labelled historical');
    assert.doesNotMatch(line, /^HTF: /, reason + ' must not fall through to the raw slug');
  }
});

// ── THE REGRESSION (2026-09-01) ───────────────────────────────────────────
// The gate shipped reading structure with classifyTrendFromBars, which counts
// consecutive bar-to-bar transitions. Fed the ~40 bars readHTFNow() supplies,
// it demanded a run of consecutive higher highs AND higher lows that real
// price action almost never produces, and most of every block the gate issued
// was "structure unclear" — the app unable to read the chart, reported as
// though a rule had refused a trade. These pin the fix so it cannot silently
// revert.
test('structure is read from SWING PIVOTS, not consecutive candles', () => {
  // A straight line has no swings, so it has no structure to report. The old
  // consecutive-candle read called this a perfect uptrend; it is not one, and
  // a gate that calls it one will also call 40 bars of chop a downtrend.
  assert.equal(classifyStructureFromPivots(ramp(40)), 'unclear');
  assert.equal(htf.readHTF(ramp(40), ramp(20)).reason, htf.REASONS.UNCLEAR_15M);

  // A real wave with rising swings IS bullish, and stays bullish at the long
  // window the live gate actually uses — the property the old read lost.
  assert.equal(classifyStructureFromPivots(up(39)), 'bullish');
  assert.equal(classifyStructureFromPivots(down(39)), 'bearish');
});

test('a window too short to hold two swings is unclear, never a guess', () => {
  // A 12-bar window cannot fit a 6-bar swing twice, so there are fewer than
  // two pivots to compare. It must refuse, not invent a direction from the
  // single swing it can see. This is also why MIN_BARS_15M is 24 and not 12.
  assert.equal(classifyStructureFromPivots(up(12)), 'unclear');
  assert.equal(classifyStructureFromPivots([]), 'unclear');
  assert.equal(classifyStructureFromPivots(null), 'unclear');
});


// ── G4: per-playbook unclearPolicy (added 2026-09-08) ─────────────────────
// RESTORED NOTE: the 21 tests ABOVE were deleted when this block was first
// written and are restored here. They all pass against the G4 code — they
// were not broken by it. They pin the doctrine this module exists to hold
// (the 15M decides, the 1H cannot veto, a direction mismatch is always
// refused, missing data is distinct from unclear, and a pre-2026-09-03
// ledger row still explains itself). Add to this file; do not replace it.

function unclear(structure1h) {
  return { ok: false, bias: null, reason: htf.REASONS.UNCLEAR_15M, structure15m: 'unclear', structure1h, confirmation: null };
}

test('refuse-unless-1h-clean + 15M unclear + 1H bullish + bullish setup -> ALLOWED', () => {
  const r = htf.checkSetup(unclear('bullish'), 'BULLISH', 'refuse-unless-1h-clean');
  assert.equal(r.allowed, true);
  assert.equal(r.htfConfirmation, 'unclear', 'must be marked so it cannot pass as a clean-bias setup');
});

test('refuse-unless-1h-clean + 1H unclear -> REFUSED', () => {
  const r = htf.checkSetup(unclear('unclear'), 'BULLISH', 'refuse-unless-1h-clean');
  assert.equal(r.allowed, false);
});

test('refuse-unless-1h-clean + 1H bearish (setup bullish) -> REFUSED', () => {
  const r = htf.checkSetup(unclear('bearish'), 'BULLISH', 'refuse-unless-1h-clean');
  assert.equal(r.allowed, false);
});

test('policy "refuse" + 15M unclear -> REFUSED (byte-identical to today)', () => {
  const r = htf.checkSetup(unclear('bullish'), 'BULLISH', 'refuse');
  assert.equal(r.allowed, false);
});

test('absent policy defaults to refuse', () => {
  const r = htf.checkSetup(unclear('bullish'), 'BULLISH');
  assert.equal(r.allowed, false);
});

test('setup-against-htf-bias is REFUSED under every policy value', () => {
  const clean = { ok: true, bias: 'bullish', reason: htf.REASONS.OK, structure15m: 'bullish', structure1h: 'bearish', confirmation: 'disagrees' };
  for (const p of ['refuse', 'refuse-unless-1h-clean', 'alert-unlabelled']) {
    const r = htf.checkSetup(clean, 'BEARISH', p);
    assert.equal(r.allowed, false, 'direction must never relax under ' + p);
    assert.equal(r.reason, htf.REASONS.SETUP_DISAGREES);
  }
});

test('a clean 15M that agrees with the setup is ALLOWED regardless of policy', () => {
  const clean = { ok: true, bias: 'bullish', reason: htf.REASONS.OK, structure15m: 'bullish', structure1h: 'bullish', confirmation: 'confirmed' };
  for (const p of ['refuse', 'refuse-unless-1h-clean']) {
    const r = htf.checkSetup(clean, 'BULLISH', p);
    assert.equal(r.allowed, true);
  }
});
