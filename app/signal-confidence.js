'use strict';
// ── Signal confidence (2026-08-26) ─────────────────────────────────────────
// Anoop: "there is no current plan in the system that give me entry signal
// with confidence, how confident are these entries".
//
// He is right that nothing scores them. Every watcher in server.js fires a
// binary alert — the candle is either there or it is not — and the ledger
// captures rich context (structure, 1H trend, session tier, news blackout,
// hour edge) at fire time that NOTHING then reads. This module is the reader.
//
// ── THE SPLIT THAT MAKES THIS HONEST ───────────────────────────────────────
// "Confidence" is two different claims and conflating them is how a scorecard
// becomes a liability:
//
//   CONFLUENCE (always computable) — how many of the conditions this playbook
//   says should be true actually ARE true right now. It is a deterministic
//   count of observable facts. It can be audited line by line against the
//   chart. It is NOT a probability and this module never calls it one.
//
//   HIT RATE (only from evidence) — what fraction of past signals in this
//   bucket actually reached target. This is the number a trader really wants,
//   and it is the one that CANNOT be produced from a rule. It comes from
//   resolved outcomes: the signal-outcome ledger and the backtest.
//
// Reporting a 78% next to a setup because it ticked 7 of 9 boxes would be
// exactly the failure TRUST-PROTOCOL.md Rule 1 exists to prevent — a
// plausible-looking number that no measurement supports, in a format
// indistinguishable from one that does. So: confluence always, hit rate only
// with a real sample behind it, and the two never blended into one figure.
//
// ── WHY A HIGH CONFLUENCE SCORE MUST NOT IMPLY A GOOD TRADE ────────────────
// As of 2026-08-26 the backtest over real MNQ bars shows all three playbooks
// with negative expectancy on the sample available. A confluence score is a
// measure of AGREEMENT WITH THE PLAYBOOK, and agreeing perfectly with a
// playbook that has not been shown to work is not an edge. That sentence is
// in the returned object as `caveat` so it travels with the number, because
// the number will be read on a phone during a session, not here.
//
// PURE. No I/O, no clock — `now` is passed in.

// Weights are DELIBERATELY equal and integral. A weighted blend tuned by hand
// would encode a belief about which factor matters most, and no such belief
// is currently supported by evidence — the whole point of the outcome ledger
// is to eventually replace these with measured ones. Equal weights are the
// honest prior: "these are the things the rulebook says to check", counted.
const FACTORS = [
  { key: 'structure',    label: 'HTF structure agrees with direction' },
  { key: 'htfBias',      label: '1H bias agrees with direction' },
  { key: 'session',      label: 'inside a defined session window' },
  { key: 'newsClear',    label: 'not in a news blackout' },
  { key: 'liquidity',    label: 'target-side liquidity still intact' },
  { key: 'riskFits',     label: 'stop fits the per-trade risk limit' },
  { key: 'freshness',    label: 'setup is fresh, not a re-fire' },
];

const MIN_SAMPLE_FOR_HIT_RATE = 20;

function agreesWithDirection(trendLabel, direction) {
  const t = String(trendLabel || '').toUpperCase();
  const d = String(direction || '').toUpperCase();
  if (!t || !d) return null;                       // unknown, not false
  const bullish = /BULL|STRONG BULL|HH-HL/.test(t);
  const bearish = /BEAR|STRONG BEAR|LL-LH/.test(t);
  if (!bullish && !bearish) return null;           // NEUTRAL/mixed/ranging → unknown
  return (bullish && d === 'BULLISH') || (bearish && d === 'BEARISH');
}

/**
 * @param {object} signal  a ledger-shaped row plus the plan:
 *   { playbook, direction, tf, structure, hourTrend, sessionTier, newsBlackout,
 *     liquiditySwept, riskUsd, isRefire }
 * @param {object} rules   rules.json
 * @param {object} evidence optional { n, targetRate, source } from resolved
 *                 outcomes for THIS playbook+tf bucket. Omit when unknown —
 *                 never pass a placeholder.
 */
function scoreSignal(signal, rules, evidence) {
  const s = signal || {};
  const r = rules || {};
  const values = {};
  const reasons = [];

  // Each factor is true / false / null. NULL IS NOT ZERO — a factor that
  // could not be evaluated is excluded from the denominator entirely, so a
  // signal fired while the 1H read was unavailable scores 4/6, not 4/7. The
  // alternative silently punishes missing data as if it were adverse
  // evidence, which would make the score drift down whenever the chart feed
  // hiccuped and make a data outage look like a bad setup.
  values.structure = agreesWithDirection(s.structure, s.direction);
  values.htfBias = agreesWithDirection(s.hourTrend, s.direction);
  values.session = s.sessionTier ? s.sessionTier !== 'outside-session' : null;
  values.newsClear = s.newsBlackout == null ? null : !s.newsBlackout;
  values.liquidity = s.liquiditySwept == null ? null : !s.liquiditySwept;
  values.riskFits = (typeof s.riskUsd === 'number' && r.perTradeMaxLoss)
    ? s.riskUsd <= r.perTradeMaxLoss : null;
  values.freshness = s.isRefire == null ? null : !s.isRefire;

  let met = 0, applicable = 0;
  const components = [];
  for (const f of FACTORS) {
    const v = values[f.key];
    if (v === null || v === undefined) {
      components.push({ key: f.key, label: f.label, value: null, note: 'not evaluable — excluded from the score' });
      continue;
    }
    applicable++;
    if (v) met++; else reasons.push(f.label.replace(/^/, 'FAILS: '));
    components.push({ key: f.key, label: f.label, value: v });
  }

  const confluence = applicable ? met / applicable : null;

  // Bands describe AGREEMENT WITH THE PLAYBOOK, not likelihood of profit.
  // Named so they cannot be mistaken for a probability.
  let band = 'UNKNOWN';
  if (confluence != null) {
    if (applicable < 3) band = 'TOO LITTLE DATA';
    else if (confluence >= 0.85) band = 'FULL AGREEMENT';
    else if (confluence >= 0.6) band = 'PARTIAL AGREEMENT';
    else band = 'CONFLICTS WITH PLAYBOOK';
  }

  // ── The measured half ────────────────────────────────────────────────────
  // Returned only with a real sample behind it. Below the threshold the field
  // is null AND carries the reason, so a UI can say "not enough history yet"
  // rather than rendering a blank that reads as zero.
  const ev = evidence || {};
  const hasSample = Number.isFinite(ev.n) && ev.n >= MIN_SAMPLE_FOR_HIT_RATE && Number.isFinite(ev.targetRate);
  const measured = hasSample
    ? { targetRate: ev.targetRate, n: ev.n, source: ev.source || 'resolved outcomes' }
    : null;

  return {
    playbook: s.playbook || null,
    direction: s.direction || null,
    tf: s.tf || null,

    // What is true right now, and auditable against the chart.
    confluence: confluence != null ? Math.round(confluence * 100) / 100 : null,
    confluenceMet: met,
    confluenceApplicable: applicable,
    band,
    components,
    reasons,

    // What history says — or an explicit null and why.
    measured,
    measuredUnavailableReason: hasSample ? null
      : `needs >=${MIN_SAMPLE_FOR_HIT_RATE} resolved outcomes for ${s.playbook || 'this playbook'}/${s.tf || '?'}; have ${Number.isFinite(ev.n) ? ev.n : 0}`,

    caveat: 'Confluence measures agreement with the playbook, NOT probability of profit. '
          + 'No playbook in this app has demonstrated positive expectancy yet (see DATA/bars backtest).',
  };
}

// Build the `evidence` argument from resolved signal-outcome rows for one
// playbook+tf bucket. Kept here so the live path and the backtest compute it
// identically. `aggregateOutcomes` rows come from signal-outcome.js.
function evidenceFromAggregates(aggRows, playbook, tf) {
  for (const a of Array.isArray(aggRows) ? aggRows : []) {
    if (a && a.playbook === playbook && String(a.tf) === String(tf)) {
      return { n: a.n, targetRate: a.targetRate, source: 'signal-outcome ledger' };
    }
  }
  return { n: 0, targetRate: null };
}

module.exports = { scoreSignal, evidenceFromAggregates, FACTORS, MIN_SAMPLE_FOR_HIT_RATE };
