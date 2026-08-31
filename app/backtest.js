'use strict';
// ── Playbook backtest engine (2026-08-26) ──────────────────────────────────
// Answers the question Anoop asked directly: "i have not back tested my
// current playbooks and check if they actually work."
//
// ── THE ONE DESIGN RULE ────────────────────────────────────────────────────
// This engine does not contain a single detector of its own. It imports
// detectors.js and playbook-c.js — the EXACT functions the live monitors in
// server.js fire on — and playbook-spec.js for where the entry/stop/target
// are. A reimplemented detector would produce a number about code that never
// trades. Two Pine backtests already exist in Prop Trading/ and both carry
// headers admitting they are "best-effort codification" of the discretionary
// rules; that gap between what was tested and what fires is precisely what
// this avoids. If a result here is wrong, it is wrong because the live
// detector is wrong, which is the only kind of wrong worth learning from.
//
// ── HOW A TRADE IS SIMULATED, AND WHERE IT IS DELIBERATELY PESSIMISTIC ─────
// Every ambiguity resolves AGAINST the strategy. A backtest exists to tell
// you when to stop trading something, so its failure mode must be "says no
// when the answer is yes", never the reverse:
//   • Same-bar stop AND target → counted as the STOP. Bar data cannot say
//     which came first (same rule signal-outcome.js already applies).
//   • Playbook B's limit entry must actually be TOUCHED by a later bar's
//     range within the fill window, or the setup is recorded as NO TRADE —
//     not as a scratch, and not as a win because price later went the right
//     way without you. An unfilled setup is the single largest source of
//     fake edge in FVG backtests.
//   • Entry at the bar CLOSE for market entries, never at the bar's best
//     price.
//   • Commission is charged both sides at the real verified rate.
//   • Slippage is charged against entry AND exit.
//   • A setup whose bars run out before it resolves is EXCLUDED, never
//     counted as a scratch — the same refusal signal-outcome.js makes on a
//     partial horizon, and for the same reason: a partially-observed trade
//     is a different measurement, not a small version of the same one.
//
// ── WHAT IT CANNOT TELL YOU ────────────────────────────────────────────────
// The rulebook's real exit is "exit at marker levels" — hand-drawn zones no
// code can read. Targets here are an R multiple from rules.json. So read
// every result as "does the ENTRY and STOP have an edge", never as "does my
// exit process work". That distinction is the difference between a useful
// number and a misleading one.
//
// PURE except for the bars handed in. No I/O, no TradingView, no clock.

const detectors = require('./detectors');
const playbookC = require('./playbook-c');
const spec = require('./playbook-spec');

const MNQ_POINT_VALUE = 2;      // $/point/contract — verified, see point-value-verify.js
const IST_OFFSET_SEC = 5.5 * 3600;

// ── Hard overnight flatten (2026-08-26) ────────────────────────────────────
// Anoop: "all the trades should end by 3 am indian standard time. the trades
// should not be carried over night."
//
// This is not a reporting nicety — it changes which results were ever
// ACHIEVABLE. A 12-bar horizon on 30M is six hours, so any setup arming after
// roughly 21:00 IST would, unconstrained, be scored on price action that
// happened after the position was required to be flat. Counting those points
// would credit the playbook with money the rule forbids it to earn.
//
// Returns the absolute unix second of the first 03:00 IST at or after
// `fromSec`. A trade entered at 04:00 IST gets until 03:00 IST TOMORROW; one
// entered at 23:00 IST gets four hours.
function nextFlattenSec(fromSec, flattenMinutesIST) {
  const mins = Number.isFinite(flattenMinutesIST) ? flattenMinutesIST : 180;
  const istSec = fromSec + IST_OFFSET_SEC;
  const dayStartIst = Math.floor(istSec / 86400) * 86400;
  let cutoffIst = dayStartIst + mins * 60;
  if (cutoffIst <= istSec) cutoffIst += 86400;   // already past today's cutoff
  return cutoffIst - IST_OFFSET_SEC;
}
const DEFAULT_SLIPPAGE_POINTS = 0.5;

// ── Would Anoop's own rules even ALLOW this trade? ─────────────────────────
// A backtest of trades he is not permitted to take is worse than no backtest:
// it reports an edge he cannot legally harvest, and the trades it leans on
// are the oversized ones his rulebook exists to prevent. Both gates below
// came out of the first honest run of this harness on real 30M bars, where
// Playbook B's detected stops ranged from 3.00 points to 114.75:
//
//   • TOO BIG — a 114.75-point stop at 2 contracts is $459 of risk, against
//     a `perTradeMaxLoss` of $300 in rules.json. sizeFloor is also 2, so he
//     cannot size down to fit. The rule-compliant action is to SKIP, so the
//     harness skips, and counts how often that happens. "Playbook B is
//     profitable" would be a false statement if a third of its profit came
//     from trades the app is supposed to block.
//
//   • TOO SMALL — five of fifteen setups came back with riskPoints of
//     exactly 3.00, which is the stop buffer and nothing else. That happens
//     when the SFP wick and the near gap edge are the same price, i.e. the
//     raid candle and the third candle of the FVG are the SAME BAR — there
//     is no displacement leg between them, so it is not the playbook. It
//     also makes slippage (1.0pt round trip) a third of total risk. All five
//     lost. They are excluded and counted separately rather than deleted,
//     because "the live monitor confirms Playbook B on bars where the raid
//     and the displacement coincide" is a finding about the DETECTOR that
//     the numbers must not bury.
function riskGate(plan, rules, contracts, pointValue) {
  const minPts = (rules && rules.playbooks && rules.playbooks.minRiskPoints) || 0;
  const maxUsd = (rules && rules.perTradeMaxLoss) || Infinity;
  const riskUsd = plan.riskPoints * pointValue * contracts;
  if (minPts && plan.riskPoints < minPts) {
    return { ok: false, code: 'risk-too-small', reason: `stop is only ${plan.riskPoints.toFixed(2)}pt (min ${minPts}) — raid and displacement are likely the same bar` };
  }
  if (riskUsd > maxUsd) {
    return { ok: false, code: 'risk-too-big', reason: `${plan.riskPoints.toFixed(2)}pt = $${riskUsd.toFixed(0)} risk at ${contracts} contracts, over the $${maxUsd} per-trade max loss` };
  }
  return { ok: true, riskUsd };
}

// Align a higher-timeframe bar series to a given moment WITHOUT looking into
// the future. Returns only HTF bars that had already CLOSED at `atSec`.
//
// This is the single most common way a multi-timeframe backtest cheats: it
// reads "the 4H trend" from a 4H candle that, at the moment the 1H signal
// fired, still had three hours left to run. The resulting bias is partly a
// function of what happened after the entry. Filtering on
// `barTime + duration <= atSec` is what makes the 4H read here the same one
// a human would have had on screen at that instant.
function htfBarsAsOf(htfBars, atSec, htfSeconds) {
  const out = [];
  for (const b of htfBars || []) {
    if (typeof b.time !== 'number') continue;
    if (b.time + htfSeconds <= atSec) out.push(b);
  }
  return out;
}

// Walk `bars` forward from the entry bar and decide what happened.
// Returns { outcome:'target'|'stop'|'timeout'|'nofill', ... } or null when
// there is not enough forward data to decide — never a guess.
function simulateTrade(plan, bars, startIdx, opts) {
  const o = opts || {};
  const horizon = o.horizonBars || 12;
  const slip = o.slippagePoints != null ? o.slippagePoints : DEFAULT_SLIPPAGE_POINTS;
  const bull = plan.direction === 'BULLISH';
  const flattenMins = o.flattenByISTMinutes;

  let entryIdx = startIdx;
  let filled = !plan.requiresFill;

  // ── Fill phase (Playbook B only) ─────────────────────────────────────────
  //
  // THE SCAN STARTS AT startIdx + 1, AND THAT IS THE WHOLE POINT.
  //
  // Starting it at startIdx looks harmless and is catastrophic. A bullish
  // FVG's near edge IS the signal bar's own low (gapHigh = c.low, by
  // construction in detectFVGFromBars), so a fill scan that includes the
  // signal bar fills EVERY setup, instantly, at the exact extreme of the
  // displacement candle. The first run of this harness did exactly that and
  // reported Playbook B at a 73.3% win rate, 2.91 profit factor and +$1,501
  // — on 15 setups of which all 15 "filled" at offset zero. Not one was a
  // retrace. The signal does not even exist until that bar has CLOSED, so
  // every one of those entries was a price that could not have been taken.
  //
  // This is the classic way an FVG backtest manufactures an edge, it is
  // invisible in the summary statistics, and the numbers it produces are
  // good enough to be believed. The only defence is that the fill must come
  // from a bar strictly AFTER the one that created the signal.
  if (plan.requiresFill) {
    const fillEnd = Math.min(bars.length - 1, startIdx + plan.fillWindowBars);
    if (startIdx + plan.fillWindowBars > bars.length - 1) return null; // window not fully observable yet
    const fillCutoff = (flattenMins != null && typeof bars[startIdx].time === 'number')
      ? nextFlattenSec(bars[startIdx].time, flattenMins) : null;
    for (let i = startIdx + 1; i <= fillEnd; i++) {
      const b = bars[i];
      if (typeof b.high !== 'number' || typeof b.low !== 'number') continue;
      // Never open a position the flatten rule would immediately have to close.
      if (fillCutoff != null && b.time >= fillCutoff) break;
      // A limit at `entry` fills when the bar's range covers it.
      if (b.low <= plan.entry && plan.entry <= b.high) { filled = true; entryIdx = i; break; }
      // If the trade runs away without you AND hits the target before ever
      // filling, that is still NO TRADE. It is recorded as such rather than
      // silently dropped, because "how often does B run without me?" is a
      // real and separately actionable fact about the setup.
    }
    if (!filled) {
      return { outcome: 'nofill', filled: false, points: 0, bars: plan.fillWindowBars, entryIdx: null };
    }
  }

  // ── Management phase ─────────────────────────────────────────────────────
  const end = entryIdx + horizon;
  if (end > bars.length - 1) return null; // horizon not fully observable — excluded, not scratched

  // Cutoff is anchored to the ENTRY bar, so each trade gets its own next
  // 03:00 IST rather than a single global one.
  const flattenAt = (flattenMins != null && typeof bars[entryIdx].time === 'number')
    ? nextFlattenSec(bars[entryIdx].time, flattenMins) : null;

  for (let i = entryIdx + 1; i <= end; i++) {
    const b = bars[i];
    if (typeof b.high !== 'number' || typeof b.low !== 'number') continue;

    // Flatten BEFORE checking stop/target on this bar: if the bar opens at or
    // after the cutoff, the position was already required to be closed, so
    // any level it touches is unreachable.
    if (flattenAt != null && b.time >= flattenAt) {
      const prev = bars[i - 1];
      const px = typeof prev.close === 'number' ? prev.close : null;
      if (px == null) return null;
      const raw = bull ? px - plan.entry : plan.entry - px;
      return { outcome: 'flattened', filled: true, points: raw - 2 * slip, bars: i - 1 - entryIdx, entryIdx };
    }

    const hitStop = bull ? b.low <= plan.stop : b.high >= plan.stop;
    const hitTarget = bull ? b.high >= plan.target : b.low <= plan.target;
    // PESSIMISTIC: stop wins every tie. See header.
    if (hitStop) {
      const raw = bull ? plan.stop - plan.entry : plan.entry - plan.stop;
      return { outcome: 'stop', filled: true, points: raw - 2 * slip, bars: i - entryIdx, entryIdx };
    }
    if (hitTarget) {
      const raw = bull ? plan.target - plan.entry : plan.entry - plan.target;
      return { outcome: 'target', filled: true, points: raw - 2 * slip, bars: i - entryIdx, entryIdx };
    }
  }

  // Neither level touched inside the horizon — closed at the horizon bar.
  const last = bars[end];
  if (typeof last.close !== 'number') return null;
  const raw = bull ? last.close - plan.entry : plan.entry - last.close;
  return { outcome: 'timeout', filled: true, points: raw - 2 * slip, bars: horizon, entryIdx };
}

// ── Playbook A / LTF-ENGULF ────────────────────────────────────────────────
// Walks the entry timeframe. At every closed bar: is there a full-range
// engulf, does Playbook C's gate pass, and (Playbook A only) does the 4H
// structure agree?
function runEngulfPlaybook(playbookId, entryBars, htfBars, rules, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, spec.SPEC_DEFAULTS, (rules && rules.playbooks) || {});
  const horizon = cfg.outcomeHorizonBars;
  const htfSeconds = (o.htfSeconds || 4 * 3600);
  const warmup = Math.max(playbookC.PBC_HISTORY_BARS, 10);
  const requireHtf = playbookId === 'A';
  const contracts = o.contracts || (rules && rules.sizeCap) || 2;
  const pointValue = o.pointValue || MNQ_POINT_VALUE;

  const trades = [];
  const rejects = [];
  const blocked = [];
  const seen = new Set();

  for (let i = warmup; i < entryBars.length; i++) {
    // Bars visible AT this moment — index i is the just-closed bar.
    const visible = entryBars.slice(0, i + 1);
    const bar = entryBars[i];

    const engulf = detectors.detectEngulfFromBars(visible);
    if (!engulf) continue;

    // Playbook C gate — the same call the live monitor makes. pdhpdl is null
    // here: the live gate also passes null when the daily read is
    // unavailable, and validateEngulfPlaybookC handles it by checking pivot
    // levels only. Documented rather than faked.
    const pbc = playbookC.validateEngulfPlaybookC(visible.slice(-playbookC.PBC_HISTORY_BARS), engulf.direction, null);
    if (!pbc.valid) { rejects.push({ time: bar.time, direction: engulf.direction, reason: pbc.reason, structure: pbc.structure }); continue; }

    // Playbook A's 4H alignment gate — using only 4H bars closed by now.
    let htfTrend = null;
    if (requireHtf) {
      const asOf = htfBarsAsOf(htfBars, bar.time, htfSeconds);
      if (asOf.length < 5) continue;                       // no HTF read = no trade, never a guess
      htfTrend = detectors.classifyTrendFromBars(asOf.slice(-5));
      const agrees = (htfTrend === 'bullish' && engulf.direction === 'BULLISH') ||
                     (htfTrend === 'bearish' && engulf.direction === 'BEARISH');
      if (!agrees) { rejects.push({ time: bar.time, direction: engulf.direction, reason: `against/unclear 4H trend (${htfTrend})`, structure: pbc.structure }); continue; }
    }

    const setup = { direction: engulf.direction, bar, barTime: bar.time, entryRef: bar.close };
    const id = spec.setupId(playbookId, setup);
    if (seen.has(id)) continue;                            // one candle, one signal
    seen.add(id);

    const plan = spec.planEntry(playbookId, setup, rules);
    if (!plan.plannable) { rejects.push({ time: bar.time, direction: engulf.direction, reason: 'unplannable: ' + plan.reason, structure: pbc.structure }); continue; }

    const gate = riskGate(plan, rules, contracts, pointValue);
    if (!gate.ok) { blocked.push({ time: bar.time, direction: engulf.direction, code: gate.code, reason: gate.reason }); continue; }

    const sim = simulateTrade(plan, entryBars, i, { horizonBars: horizon, slippagePoints: o.slippagePoints, flattenByISTMinutes: (rules && rules.flattenByISTMinutes) });
    if (!sim) continue;                                    // not yet fully observable — excluded
    trades.push(Object.assign({ setupId: id, time: bar.time, structure: pbc.structure, htfTrend }, plan, sim));
  }
  return { trades, rejects, blocked };
}

// ── Playbook B — SFP then displacement FVG then retrace fill ───────────────
// Reproduces the live monitor's state machine: a raid arms a `pending`, a
// same-direction FVG inside the displacement window confirms it, and the
// entry is a limit back into the gap.
function runPlaybookB(entryBars, rules, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, spec.SPEC_DEFAULTS, (rules && rules.playbooks) || {});
  const horizon = cfg.outcomeHorizonBars;
  const warmup = 40;                                       // SFP_TFS lookback in server.js
  const contracts = o.contracts || (rules && rules.sizeCap) || 2;
  const pointValue = o.pointValue || MNQ_POINT_VALUE;

  const trades = [];
  const raids = [];
  const blocked = [];
  const seen = new Set();
  let pending = null;

  for (let i = warmup; i < entryBars.length; i++) {
    const visible = entryBars.slice(0, i + 1);
    const bar = entryBars[i];

    // Step 3 — the liquidity raid. Same level pool the live monitor builds,
    // minus PDH/PDL (not derivable from a single intraday series without
    // guessing the session boundary — its absence makes this STRICTER, since
    // it is a smaller level pool, i.e. fewer signals rather than more).
    const swings = detectors.getSwingLevels(visible);
    const sfp = detectors.detectSFPFromBars(visible, { highs: swings.swingHighs, lows: swings.swingLows });
    if (sfp) {
      raids.push({ time: bar.time, direction: sfp.direction, level: sfp.level });
      pending = { direction: sfp.direction, level: sfp.level, wick: sfp.wick, at: i };
    }

    if (!pending) continue;
    if (i - pending.at > cfg.sfpToFvgMaxBars) { pending = null; continue; }  // stale — JadeCap: don't chase

    // Step 4 — displacement FVG in the raid's direction.
    const fvg = detectors.detectFVGFromBars(visible);
    if (!fvg || fvg.direction !== pending.direction) continue;

    const setup = { direction: pending.direction, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, wick: pending.wick, level: pending.level };
    const id = spec.setupId('B', setup);
    pending = null;                                        // confirmed setups clear the pending, as live
    if (seen.has(id)) continue;
    seen.add(id);

    const plan = spec.planEntry('B', setup, rules);
    if (!plan.plannable) continue;

    const gate = riskGate(plan, rules, contracts, pointValue);
    if (!gate.ok) { blocked.push({ time: bar.time, direction: setup.direction, code: gate.code, reason: gate.reason }); continue; }

    const sim = simulateTrade(plan, entryBars, i, { horizonBars: horizon, slippagePoints: o.slippagePoints, flattenByISTMinutes: (rules && rules.flattenByISTMinutes) });
    if (!sim) continue;
    trades.push(Object.assign({ setupId: id, time: bar.time }, plan, sim));
  }
  return { trades, raids, blocked };
}

// ── Scoring, in the terms that decide whether the eval is cleared ──────────
// Anoop's stated bar (2026-08-26): "the entry and exit should end up in
// profit that can clear evaluation and reach payout." So points and win rate
// are intermediate; the numbers that answer him are net dollars at his
// PERMITTED size, and whether the equity path would have survived. A
// playbook with a 60% win rate that draws down $4,500 before it earns $9,000
// fails his actual test, and only a running equity curve shows that.
function score(trades, rules, opts) {
  const o = opts || {};
  const size = o.contracts || (rules && rules.sizeCap) || 2;
  const commission = (rules && rules.commissionPerContractPerSide) || 0.95;
  const pv = o.pointValue || MNQ_POINT_VALUE;

  const filled = trades.filter((t) => t.filled);
  const nofill = trades.length - filled.length;

  let equity = 0, peak = 0, maxDD = 0;
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
  const curve = [];

  for (const t of filled) {
    const net = t.points * pv * size - commission * 2 * size;
    equity += net;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    if (net > 0) { wins++; grossWin += net; } else { losses++; grossLoss += Math.abs(net); }
    curve.push({ time: t.time, net, equity });
  }

  const n = filled.length;
  const target = (rules && rules.eval && rules.eval.profitTarget) || 9000;
  const ddLimit = (rules && rules.eval && rules.eval.maxDrawdown) || 4500;
  const expectancy = n ? equity / n : null;

  // ── Signal FREQUENCY, which turns out to matter more than win rate ────────
  // Anoop's stated bar is that entries and exits "end up in profit that can
  // clear evaluation and reach payout" — a $9,000 target. That is a rate
  // question before it is an accuracy question, and the rate is measurable
  // from a small sample even when the win rate is not.
  //
  // A playbook producing half a tradeable setup per day cannot clear $9,000
  // in an evaluation window at any plausible per-trade edge, and no amount of
  // improving its win rate changes that. Frequency is reported separately and
  // unconditionally for exactly that reason: unlike expectancy, it does not
  // need a large sample to be believed, and it is the number that decides
  // whether the goal is reachable with this playbook at all.
  const span = o.spanDays || null;
  const frequency = (span && span > 0) ? {
    spanDays: round2(span),
    tradeableSetupsPerDay: round2(n / span),
    // What the per-trade edge would have to be to reach the target in a
    // 30-trading-day window at the OBSERVED frequency. Stated as a
    // requirement, never as a prediction.
    requiredExpectancyFor30Days: n > 0 ? round2(target / Math.max(1, (n / span) * 30)) : null,
  } : null;

  return {
    signals: trades.length,
    noFill: nofill,
    filled: n,
    wins, losses,
    winRate: n ? wins / n : null,
    targets: filled.filter((t) => t.outcome === 'target').length,
    stops: filled.filter((t) => t.outcome === 'stop').length,
    timeouts: filled.filter((t) => t.outcome === 'timeout').length,
    flattened: filled.filter((t) => t.outcome === 'flattened').length,
    netUsd: round2(equity),
    expectancyUsd: expectancy != null ? round2(expectancy) : null,
    avgWinUsd: wins ? round2(grossWin / wins) : null,
    avgLossUsd: losses ? round2(grossLoss / losses) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    maxDrawdownUsd: round2(maxDD),
    contracts: size,
    frequency,
    // The eval question, answered only when there is something to answer it
    // with. `null` where a number would be an extrapolation from too few
    // trades is deliberate — TRUST-PROTOCOL Rule 1.
    evalProjection: (expectancy != null && n >= 10 && expectancy > 0)
      ? { tradesToTarget: Math.ceil(target / expectancy), targetUsd: target, ddLimitUsd: ddLimit, ddHeadroom: round2(ddLimit - maxDD) }
      : null,
    curve,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

module.exports = { runEngulfPlaybook, runPlaybookB, simulateTrade, score, htfBarsAsOf, nextFlattenSec, MNQ_POINT_VALUE };
