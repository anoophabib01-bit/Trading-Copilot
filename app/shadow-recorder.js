'use strict';
// ── Shadow recorder (2026-08-26) ───────────────────────────────────────────
// Anoop: "i want the shadow to record how i trades which can be used to build
// stratergy dublicate of good trades only."
//
// ── WHAT SHADOW MODE IS FOR — my answer to his question ────────────────────
// I built it for one purpose and he wants a second. Both are right, they share
// the same plumbing, and TOGETHER they are worth more than either alone.
//
//   MACHINE SHADOW (what I built it for): the app writes down the exact order
//   it WOULD have sent, and price then scores it. This is how autonomy gets
//   EARNED instead of granted — a track record that costs nothing to build.
//
//   HUMAN SHADOW (what he asked for): every trade HE takes, recorded with the
//   full market and behavioural context as it was at the moment of entry.
//
// The real prize is the third thing, which neither gives you on its own:
// **the DIFFERENCE between them.** On the same signal, the machine did X and
// Anoop did Y. Over enough trades that delta answers the only question that
// actually decides whether he should hand over control — does his discretion
// ADD value or subtract it? If he consistently beats the mechanical version,
// the machine should be his assistant. If he consistently loses to it, the
// machine should be trading. Nothing in this repo can currently tell him
// which, and it is the single most decision-relevant number available.
//
// ── WHY "DUPLICATE GOOD TRADES ONLY" CANNOT WORK AS STATED ─────────────────
// This is the important part and it is worth being blunt about, because the
// naive version of this idea is the most common way a trader builds a
// "strategy" from their own history and ends up with nothing.
//
// If you collect only the WINNERS and look for what they had in common, you
// will always find something. Every winner was in a session. Every winner had
// a trend reading. Every winner had a size. The question that decides whether
// any of it MATTERS is: did the LOSERS have it too? If 80% of his winners
// happened in the NY session and 80% of his losers did as well, "trade the NY
// session" is not an edge — it is a description of when he trades.
//
// A feature only has predictive value if it SEPARATES the two groups. That
// requires the losers as a control. So this module records EVERY trade, and
// the analysis compares winners AGAINST losers rather than describing winners
// alone. Same discipline as signal-outcome.js scoring the signals he skipped:
// judging a thing only on the subset that already worked measures nothing.
//
// ── WHAT GETS RECORDED, AND WHY THESE FIELDS ───────────────────────────────
// Both market context and BEHAVIOURAL context, because this account's
// documented failure modes are behavioural, not analytical (Prop Trading/
// CLAUDE.md: profitable days 6-12 trades, blow-up days 65 trades and a 20%
// win rate; revenge clusters; size increases after losses). The most likely
// discriminator between his good and bad trades is not which candle pattern
// fired — it is which trade of the day it was, how soon after a loss it came,
// and how big it was. Recording only chart features would miss the thing the
// evidence says matters most.
//
// PURE. Builds rows; autonomy-store.js writes them.

// Every trade, winner or loser. `context` is captured AT ENTRY and must never
// be reconstructed afterwards — the whole point is what was true at the moment
// the decision was made.
function buildHumanTradeRecord(trade, context) {
  const t = trade || {};
  const c = context || {};
  const pnl = Number(t.pnl);
  const band = Number(c.breakEvenBandUsd) || 0;

  return {
    kind: 'human-trade',
    ts: new Date().toISOString(),
    day: c.day || null,
    at: t.at != null ? t.at : null,
    entryAt: t.entryAt != null ? t.entryAt : null,

    // ── the trade ────────────────────────────────────────────────────────
    side: t.side || null,
    size: t.size != null ? t.size : null,
    entry: t.ep != null ? t.ep : null,
    exit: t.xp != null ? t.xp : null,
    pnl: Number.isFinite(pnl) ? pnl : null,
    holdSeconds: t.hold != null ? t.hold : null,
    // Outcome as three states, not two. A trade inside the break-even band is
    // neither a win to copy nor a loss to avoid — rules.json calls these "not
    // a trade" and on 2026-08-25 eight of eleven landed there. Lumping them in
    // with winners would fill the "good trades" set with noise that returned
    // nothing but commission.
    outcome: !Number.isFinite(pnl) ? null
      : (pnl > band ? 'win' : (pnl < -band ? 'loss' : 'breakeven')),

    // ── market context at entry ──────────────────────────────────────────
    sessionTier: c.sessionTier || null,
    istHour: c.istHour != null ? c.istHour : null,
    hourTrend: c.hourTrend || null,
    fourHourTrend: c.fourHourTrend || null,
    adx: c.adx != null ? c.adx : null,
    diPlusOverMinus: c.diPlusOverMinus != null ? c.diPlusOverMinus : null,
    newsBlackout: c.newsBlackout != null ? !!c.newsBlackout : null,
    symbol: c.symbol || null,

    // ── did a playbook actually call this trade? ─────────────────────────
    signalBacked: c.signalBacked != null ? !!c.signalBacked : null,
    signalPlaybook: c.signalPlaybook || null,
    minutesFromSignal: c.minutesFromSignal != null ? c.minutesFromSignal : null,

    // ── behavioural context — where this account's failure modes live ────
    tradeNumberToday: c.tradeNumberToday != null ? c.tradeNumberToday : null,
    contractsSoFarToday: c.contractsSoFarToday != null ? c.contractsSoFarToday : null,
    dayPnlBefore: c.dayPnlBefore != null ? c.dayPnlBefore : null,
    minutesSincePrevTrade: c.minutesSincePrevTrade != null ? c.minutesSincePrevTrade : null,
    prevTradeOutcome: c.prevTradeOutcome || null,
    // The classic revenge signature: a fast re-entry straight after a loss.
    // Derived here rather than left to the analysis so it means the same thing
    // everywhere it is read.
    fastReentryAfterLoss: (c.prevTradeOutcome === 'loss' && Number.isFinite(c.minutesSincePrevTrade))
      ? c.minutesSincePrevTrade <= 15 : null,
    sizeUpAfterLoss: (c.prevTradeOutcome === 'loss' && Number.isFinite(c.prevSize) && Number.isFinite(t.size))
      ? t.size > c.prevSize : null,
    checklistScore: c.checklistScore != null ? c.checklistScore : null,
    tradingMode: c.tradingMode || null,
  };
}

// MNQ: 0.25 index points per tick, $0.50 per tick per contract ($2.00/point).
// Verified 117/117 against real fills — see point-value-verify.js. Passed in
// rather than assumed so a different contract (MGC: 0.1 / $1.00) is a config
// change, not a code change.
const DEFAULT_TICK_SIZE = 0.25;

// Points -> {points, ticks, usd}. Ticks are what the order ticket takes and
// what a stop is nudged in; dollars are what the risk rules are written in.
// Anoop asked for both because reading only one means converting the other in
// your head at the exact moment you are least able to.
function riskUnits(points, tickSize, pointValue, contracts) {
  if (!Number.isFinite(points)) return null;
  const ts = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : DEFAULT_TICK_SIZE;
  const pv = Number.isFinite(pointValue) ? pointValue : 2;
  const c = Number.isFinite(contracts) ? contracts : 1;
  return {
    points: Math.round(points * 100) / 100,
    ticks: Math.round(points / ts),
    usd: Math.round(points * pv * c * 100) / 100,
  };
}

// An order the MACHINE would have sent. `submitted` is stamped false by
// autonomy-store; nothing here can place anything.
function buildMachineOrder(plan, context) {
  const p = plan || {};
  const c = context || {};
  // Stable identity so a resolution written later can be matched back to the
  // exact order it belongs to. Contracts are part of it because the SAME
  // signal is recorded at every shadow size and each one resolves to its own
  // P&L — 4c and 6c are two different orders, not one order counted twice.
  const id = [c.day || 'noday', p.playbook || 'nopb', p.setupId || (p.entry != null ? String(p.entry) : 'noentry'),
              c.contracts != null ? c.contracts + 'c' : 'nosize'].join('|');

  return {
    kind: 'machine-order',
    id,
    day: c.day || null,
    playbook: p.playbook || null,
    setupId: p.setupId || null,
    direction: p.direction || null,
    tf: p.tf || null,
    contracts: c.contracts != null ? c.contracts : null,
    entry: p.entry != null ? p.entry : null,
    stop: p.stop != null ? p.stop : null,
    target: p.target != null ? p.target : null,
    riskPoints: p.riskPoints != null ? p.riskPoints : null,
    riskUsd: (Number.isFinite(p.riskPoints) && Number.isFinite(c.contracts) && Number.isFinite(c.pointValue))
      ? p.riskPoints * c.pointValue * c.contracts : null,

    // ── The ticket, in the units it is actually placed and risked in ───────
    stopDistance: riskUnits(p.riskPoints, c.tickSize, c.pointValue, c.contracts),
    targetDistance: riskUnits(
      (Number.isFinite(p.target) && Number.isFinite(p.entry)) ? Math.abs(p.target - p.entry) : NaN,
      c.tickSize, c.pointValue, c.contracts),
    rMultiple: (Number.isFinite(p.target) && Number.isFinite(p.entry) && Number.isFinite(p.riskPoints) && p.riskPoints > 0)
      ? Math.round((Math.abs(p.target - p.entry) / p.riskPoints) * 100) / 100 : null,

    // ── WHY this setup was confirmed ──────────────────────────────────────
    // The specific gates that passed, with their actual values, captured at
    // fire time. Not a template: a ticket that cannot say why it exists is
    // indistinguishable from a random entry, and reviewing it later means
    // re-deriving a judgement from bars that have since moved.
    why: Array.isArray(c.why) ? c.why : [],
    sessionTier: c.sessionTier || null,
    hourTrend: c.hourTrend || null,
    adx: c.adx != null ? c.adx : null,
    // Filled in later by the outcome resolver. Recorded as explicitly
    // unresolved so a half-finished row can never be mistaken for a scratch.
    resolved: false,
    netUsd: null,
  };
}

// ── The discriminator ──────────────────────────────────────────────────────
// For each feature: how often is it present among WINNERS vs among LOSERS?
// A feature that appears equally in both is worthless no matter how common it
// is in the winners. `lift` is the gap between the two rates, and it is the
// only column that means anything.
//
// Break-even trades are EXCLUDED from both groups — they are neither the
// behaviour to copy nor the behaviour to avoid, and including them would drag
// every rate toward whatever his churn happens to look like.
function discriminate(records, opts) {
  const o = opts || {};
  const minSample = Number.isFinite(o.minSample) ? o.minSample : 20;
  const rows = (Array.isArray(records) ? records : []).filter((r) => r && (r.outcome === 'win' || r.outcome === 'loss'));
  const wins = rows.filter((r) => r.outcome === 'win');
  const losses = rows.filter((r) => r.outcome === 'loss');

  // Boolean-valued views of the record. Each returns true / false / null,
  // and null means "not knowable for this trade" — excluded, never counted
  // as absent, for the same reason signal-confidence.js excludes rather than
  // penalises an unevaluable factor.
  const FEATURES = {
    'signal-backed (a playbook called it)': (r) => r.signalBacked,
    'in a defined session': (r) => (r.sessionTier == null ? null : r.sessionTier !== 'outside-session'),
    'agreed with the 1H trend': (r) => agree(r.hourTrend, r.side),
    'agreed with the 4H trend': (r) => agree(r.fourHourTrend, r.side),
    'ADX >= 25 (trending)': (r) => (r.adx == null ? null : r.adx >= 25),
    'first 3 trades of the day': (r) => (r.tradeNumberToday == null ? null : r.tradeNumberToday <= 3),
    'taken while the day was green': (r) => (r.dayPnlBefore == null ? null : r.dayPnlBefore > 0),
    'fast re-entry after a loss': (r) => r.fastReentryAfterLoss,
    'sized up after a loss': (r) => r.sizeUpAfterLoss,
    'held under 15 minutes': (r) => (r.holdSeconds == null ? null : r.holdSeconds <= 900),
    'no news blackout': (r) => (r.newsBlackout == null ? null : !r.newsBlackout),
  };

  const out = [];
  for (const [name, fn] of Object.entries(FEATURES)) {
    const w = wins.map(fn).filter((v) => v !== null && v !== undefined);
    const l = losses.map(fn).filter((v) => v !== null && v !== undefined);
    if (!w.length || !l.length) {
      out.push({ feature: name, winRate: null, lossRate: null, lift: null, n: w.length + l.length, verdict: 'no data' });
      continue;
    }
    const wr = w.filter(Boolean).length / w.length;
    const lr = l.filter(Boolean).length / l.length;
    const lift = wr - lr;
    out.push({
      feature: name,
      winRate: round3(wr), lossRate: round3(lr), lift: round3(lift),
      n: w.length + l.length,
      // A verdict is only offered with enough trades behind it. Below that the
      // lift is reported but explicitly not interpreted — TRUST-PROTOCOL Rule 1.
      verdict: (w.length + l.length) < minSample ? `too few trades (${w.length + l.length}/${minSample})`
        : Math.abs(lift) < 0.15 ? 'no separation — present equally in wins and losses'
        : lift > 0 ? 'MORE common in winners' : 'MORE common in losers',
    });
  }
  return out.sort((a, b) => Math.abs(b.lift || 0) - Math.abs(a.lift || 0));
}

function agree(trendLabel, side) {
  const t = String(trendLabel || '').toUpperCase();
  const s = String(side || '').toUpperCase();
  if (!t || !s) return null;
  const bull = /BULL|HH-HL/.test(t), bear = /BEAR|LL-LH/.test(t);
  if (!bull && !bear) return null;
  const long = s === 'LONG' || s === 'BUY';
  const short = s === 'SHORT' || s === 'SELL';
  if (!long && !short) return null;
  return (bull && long) || (bear && short);
}

function round3(v) { return Math.round(v * 1000) / 1000; }

module.exports = { buildHumanTradeRecord, buildMachineOrder, discriminate, riskUnits, DEFAULT_TICK_SIZE };
