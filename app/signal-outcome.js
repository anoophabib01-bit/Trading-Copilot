'use strict';
// ── Signal outcome resolution (2026-08-23) ─────────────────────────────────
// Answers, for a signal the ledger already recorded: WHAT HAPPENED NEXT.
//
// WHY THIS EXISTS — the selection-bias hole. signal-ledger.js already records
// every watcher fire and every Playbook C rejection with its context, and
// signal-join.js already matches TAKEN trades back to the signal that armed
// them. So the system can say "this trade was signal-backed" — but only for
// signals Anoop acted on. Nothing scores the ones he skipped.
//
// That gap makes adaptation impossible in the precise sense that matters: you
// cannot learn "Playbook B on 5m fires twelve times a day and nine of them
// would have lost" from a sample containing only the three he took. Judging a
// detector by the trades it produced is judging it on the subset his
// discretion already filtered — which measures his filtering, not the
// detector. MFE/MAE resolved for EVERY armed signal, taken or not, is the
// counterfactual that makes per-playbook statistics mean something.
//
// PURE. No I/O, no TradingView. The server fetches bars (getFullBars, which
// already owns the chart lock and timeframe restore) and persists results;
// this module only does the arithmetic.
//
// MFE/MAE are in POINTS, not dollars, and deliberately so: points are what
// the chart shows and what a stop is set in, and they stay comparable across
// contracts with different multipliers. Dollars are a later multiplication by
// a point value the app cross-checks separately (point-value-verify.js).

// Only these events ever ARMED a setup — the same set signal-join.js uses,
// and for the same reason: a rejection, a raid-alone or a phase change never
// proposed an entry, so there is nothing to score for them. Kept as its own
// constant rather than imported so the two can diverge deliberately if the
// vocabularies ever do; a silent shared coupling would be worse.
const tradeForensics = require('./trade-forensics'); // shared excursion kernel (F1)

// 'c-adx-fire' ADDED 2026-09-21. C-ADX was the one playbook whose fire event
// was missing from this set, and the consequence was invisible for a specific
// reason worth recording: the shadow router (typesafe-router.js) reads the same
// armed setups this set decides whether to SCORE, and it had logged three live
// C-ADX reads against an outcome ledger that could never contain a C-ADX row.
// Measured live that day: 3 router rows, 2 outcomes, 0 joined. The join key was
// correct (both ledgers key on the same setupId format); the POPULATIONS simply
// never overlapped, so the router's whole justification — "does the ranking
// predict outcomes?" — could accumulate nothing.
//
// The row is scoreable on the same terms as any other arming event: server.js's
// adx-breakout monitor writes it through armSetup with a real entry and stop
// from planEntry (see the G19 note on that write), and the resolver anchors on
// `entry` when present.
const ARMING_EVENTS = new Set(['engulf-fire', 'fvg-fire', 'playbook-b-confirm', 'c-adx-fire']);

function isArmingEvent(event) {
  return ARMING_EVENTS.has(String(event || ''));
}

function dirSign(direction) {
  const d = String(direction || '').toUpperCase();
  if (d === 'BULLISH') return 1;
  if (d === 'BEARISH') return -1;
  return 0;
}

// Bar width in seconds for a timeframe code ('1','5','15','30','60','240').
function tfToSeconds(tf) {
  const n = Number(tf);
  return Number.isFinite(n) && n > 0 ? n * 60 : null;
}

/**
 * Resolve one signal against the bars that followed it.
 *
 * @param {object} signal  ledger row: { ts, event, direction, level, tf, ... }
 * @param {Array}  bars    ALL bars for the instrument, {time, high, low, close}
 *                         (seconds). Bars at or before the signal are ignored.
 * @param {object} opts    { horizonBars=12, stopPoints=null, targetPoints=null }
 */
function resolveSignalOutcome(signal, bars, opts) {
  const o = opts || {};
  const horizonBars = Number.isFinite(o.horizonBars) ? o.horizonBars : 12;
  const stopPoints = Number.isFinite(o.stopPoints) ? o.stopPoints : null;
  const targetPoints = Number.isFinite(o.targetPoints) ? o.targetPoints : null;

  const sign = dirSign(signal && signal.direction);
  // NOT plain Number(): Number(null) and Number('') are both 0, which is
  // finite — so a signal with no level would resolve AT ZERO and report a
  // nonsense MFE of the full price. Caught by this module's own tests.
  //
  // ANCHOR ON `entry` WHEN IT IS PRESENT (2026-08-26). Excursion has to be
  // measured from the price the trade would actually have gone on at.
  // `level` means different things per playbook — for playbook-b-confirm it
  // is the SWEPT LEVEL, i.e. beyond the stop — so scoring from it measured
  // the wrong distance entirely. Falls back to `level` so every row written
  // before this field existed still resolves exactly as it used to.
  const rawLevel = signal ? (signal.entry != null ? signal.entry : signal.level) : undefined;
  const level = (rawLevel != null && rawLevel !== '') ? Number(rawLevel) : NaN;
  const signalSec = signal && signal.ts ? Math.floor(Date.parse(signal.ts) / 1000) : NaN;

  if (!sign || !Number.isFinite(level) || !Number.isFinite(signalSec)) {
    return { resolved: false, reason: 'signal lacks direction, level or timestamp' };
  }
  if (!isArmingEvent(signal.event)) {
    return { resolved: false, reason: 'not an arming event — nothing was proposed to score' };
  }

  // STRICTLY AFTER the signal. A bar that was already forming when the signal
  // fired contains price action from before it, and counting that would let
  // the outcome peek at movement the detector could not have caused.
  const after = (Array.isArray(bars) ? bars : [])
    .filter((b) => b && typeof b.time === 'number' && b.time > signalSec)
    .sort((a, b) => a.time - b.time);

  if (!after.length) return { resolved: false, reason: 'no bars after the signal yet' };

  // F0.1 staleness bound: the first bar after the signal must be within a few
  // bar-widths of it. A signal from Aug-28 resolved against Sep-05 bars is a
  // different market scored as if continuous.
  const tfSec = tfToSeconds(signal.tf);
  if (tfSec && (after[0].time - signalSec) > tfSec * 3) {
    return { resolved: false, reason: 'stale bars — first bar is ' + Math.round((after[0].time - signalSec) / 3600) + 'h after the signal' };
  }

  const window = after.slice(0, horizonBars);
  // Refuse to resolve on a partial window: a signal scored over 3 of its 12
  // bars is not a small-sample version of the same measurement, it is a
  // different one, and mixing the two silently biases every aggregate toward
  // whatever the most recent (least resolved) signals did.
  if (window.length < horizonBars) {
    return { resolved: false, reason: `only ${window.length}/${horizonBars} bars available yet`, pending: true };
  }

  // F1 shared kernel: mfe/mae via trade-forensics.excursion (one fix fixes
  // both signal scoring and per-trade forensics).
  const ex = tradeForensics.excursion(window, level, sign, null, null);
  const mfe = ex.mfe;
  const mae = ex.mae;
  let hit = null;        // 'target' | 'stop' | null
  let hitBarIndex = null;

  for (let i = 0; i < window.length; i++) {
    const b = window[i];
    const hi = Number(b.high);
    const lo = Number(b.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;

    // Favourable/adverse excursion in the signal's own direction.
    const fav = sign === 1 ? hi - level : level - lo;
    const adv = sign === 1 ? level - lo : hi - level;

    if (hit == null && (stopPoints != null || targetPoints != null)) {
      const hitTarget = targetPoints != null && fav >= targetPoints;
      const hitStop = stopPoints != null && adv >= stopPoints;
      // SAME-BAR AMBIGUITY: when one bar's range spans both levels, bar data
      // cannot say which came first. Resolved as the STOP, always. The
      // optimistic reading is how backtests manufacture edges that evaporate
      // live, and this ledger's whole purpose is to be trusted when it says a
      // playbook is failing.
      if (hitStop) { hit = 'stop'; hitBarIndex = i; }
      else if (hitTarget) { hit = 'target'; hitBarIndex = i; }
    }
  }

  const lastClose = Number(window[window.length - 1].close);
  const atHorizon = Number.isFinite(lastClose) ? (lastClose - level) * sign : null;

  return {
    resolved: true,
    playbook: signal.playbook || null,
    event: signal.event || null,
    tf: signal.tf || null,
    direction: signal.direction || null,
    level,
    signalTs: signal.ts,
    horizonBars,
    mfe,
    mae,
    atHorizon,
    // Positive-at-horizon is the crude verdict; hit/hitBarIndex is the honest
    // one when a stop and target were supplied.
    favourable: atHorizon != null ? atHorizon > 0 : null,
    hit,
    hitBarIndex,
    // MFE/MAE ratio is the number that says whether a setup gave room before
    // it went wrong. Null rather than Infinity when MAE is zero, so averaging
    // a batch can never produce Infinity.
    edgeRatio: mae > 0 ? mfe / mae : null,
    // 2026-09-19: carried through so the shadow router's rows (which are keyed
    // by setupId) can be joined to this outcome EXACTLY rather than by
    // signalTs|playbook|tf — two engulf fires on one timeframe in one second
    // are one bucket under the composite key, and a mismatch there would score
    // the router against the wrong signal. Additive: every existing reader keys
    // on the fields it already used.
    setupId: signal.setupId || null,
    resolvedAt: new Date().toISOString(),
  };
}

// Aggregate resolved outcomes per playbook+timeframe. This is what a weekly
// review reads, and what a "has this setup failed?" threshold is checked
// against. Unresolved rows are excluded, never counted as neutral.
function aggregateOutcomes(rows) {
  const buckets = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.resolved) continue;
    const key = `${r.playbook || 'unknown'}|${r.tf || 'unknown'}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        playbook: r.playbook || 'unknown', tf: r.tf || 'unknown',
        n: 0, favourable: 0, mfeSum: 0, maeSum: 0, atHorizonSum: 0,
        targets: 0, stops: 0,
      });
    }
    const b = buckets.get(key);
    b.n++;
    if (r.favourable) b.favourable++;
    b.mfeSum += Number(r.mfe) || 0;
    b.maeSum += Number(r.mae) || 0;
    b.atHorizonSum += Number(r.atHorizon) || 0;
    if (r.hit === 'target') b.targets++;
    if (r.hit === 'stop') b.stops++;
  }
  return Array.from(buckets.values()).map((b) => ({
    playbook: b.playbook,
    tf: b.tf,
    n: b.n,
    winRate: b.n ? b.favourable / b.n : null,
    avgMfe: b.n ? b.mfeSum / b.n : null,
    avgMae: b.n ? b.maeSum / b.n : null,
    avgAtHorizon: b.n ? b.atHorizonSum / b.n : null,
    targetRate: (b.targets + b.stops) ? b.targets / (b.targets + b.stops) : null,
    targets: b.targets,
    stops: b.stops,
  })).sort((a, b) => b.n - a.n);
}

/**
 * Do two instrument symbols refer to the same contract family (MNQ vs MGC)?
 * The ledger stores the full form ("CME_MINI:MNQ1!") while the live chart may
 * report a shorter form ("MNQ1!") or a different month ("MNQU6"); all three are
 * the same instrument for the purpose of "did I resolve this signal against the
 * right bars". Empty on either side returns TRUE ("unknown must not block") so a
 * symbol-less row falls back to the previous symbol-agnostic behaviour instead
 * of silently never resolving.
 */
function sameInstrument(a, b) {
  if (a == null || b == null) return true;
  const root = (s) => {
    let x = String(s).toUpperCase().trim();
    const i = x.lastIndexOf(':');
    if (i >= 0) x = x.slice(i + 1);           // drop exchange prefix (CME_MINI:)
    const m = x.match(/[A-Z]+/);              // leading letters, stops at the month digit/number
    const letters = m ? m[0] : x.replace(/[^A-Z0-9]/g, '');
    return letters.slice(0, 3);               // MNQ / MGC — the contract month (U/Z/H/M) is the 4th char
  };
  const ra = root(a), rb = root(b);
  if (!ra || !rb) return true;                // unreadable either side → don't block
  return ra === rb;
}

module.exports = { resolveSignalOutcome, aggregateOutcomes, isArmingEvent, sameInstrument, tfToSeconds, ARMING_EVENTS };
