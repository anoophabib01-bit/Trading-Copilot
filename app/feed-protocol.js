'use strict';
// ── PROTOCOL 2: LIVE-FEED INTEGRITY (startup) ──────────────────────────────
// Anoop, 2026-08-28: "a separate protocol during the start up of the app for
// the live feed and all the parameters related to data input from tradingview
// MCP feeding the app and stress test it and check if any silent turn off of
// any of the functions inside the app, notify me and impact of analyses,
// rectify the outcome and provide evidence... make sure they auto-trigger
// inside the app and self repair themself and do not need your help."
//
// ── WHY THIS EXISTS, IN ONE SENTENCE ───────────────────────────────────────
// Every serious fault found on 2026-08-26..28 was SILENT: the app kept
// running, the screen kept updating, and the number was wrong.
//
// The existing 3-check self-test asks "is the feed READING?". That is
// necessary and nowhere near sufficient — it passed 3/3 on a day when:
//   • the Account Summary table was mounted but empty, so day P&L had
//     silently fallen back to the fold (which understates)
//   • the fold was recording a phantom zero-P&L trade, giving 2/10 trades
//     against one real trade
//   • one trade was stored as three rows because two writers disagreed
//   • the chart watchers were doing 680 reads/hour and starving the broker
//     poll into MCP timeouts
//   • the CONTROL toggle and the STANDARD/SCALPER toggle were both dead
//     buttons that had never once sent a message
// A green self-test alongside all of that is worse than no self-test.
//
// ── THE FOUR THINGS EVERY CHECK MUST DO ────────────────────────────────────
// A check that only says PASS/FAIL is what let the above hide. Each one here
// carries:
//   1. VERDICT   — pass / fail / unknown. Unknown is never folded into pass.
//   2. IMPACT    — what is WRONG downstream while this is failing, in plain
//                  terms. "orders table unreadable" means nothing; "trade
//                  counts are provisional and the per-day cap is advisory"
//                  is the fact that changes a decision.
//   3. RECTIFY   — the repair to attempt, or null when none is safe.
//   4. EVIDENCE  — the observed values behind the verdict, so the conclusion
//                  can be checked rather than believed.
//
// ── PURE ───────────────────────────────────────────────────────────────────
// No I/O, no TradingView, no clock. server.js gathers the observations (the
// part that needs CDP) and hands them here; this decides. That split is what
// makes the protocol itself testable without a live chart — the thing that
// was impossible for every detector in this repo until detectors.js.

// Severity drives what gets shouted vs logged. `critical` means a number the
// app shows is actively wrong or a guard is not running.
const SEV = { CRITICAL: 'critical', DEGRADED: 'degraded', INFO: 'info' };

// Bar spacing each watched timeframe MUST come back with. A read that returns
// the wrong spacing is the timeframe-race bug (chart_set_timeframe returns
// before the switch lands), and it is invisible: the bars look fine, they are
// just the wrong timeframe.
const EXPECTED_SPACING_MIN = { '5': 5, '15': 15, '30': 30, '60': 60, '240': 240 };

function check(key, label, verdict, opts) {
  const o = opts || {};
  return {
    key, label,
    verdict,                       // 'pass' | 'fail' | 'unknown'
    severity: o.severity || SEV.DEGRADED,
    impact: o.impact || null,      // what is wrong downstream, in plain terms
    rectify: o.rectify || null,    // machine-readable repair the runner may attempt
    evidence: o.evidence || null,  // the observed values behind the verdict
  };
}

/**
 * @param {object} obs  observations gathered by the runner:
 *   { cdpConnected, bridgeReady,
 *     panelTables: {positions,orders,summary},
 *     summaryPopulated, dayPnlSource, brokerTotalPnl,
 *     bars: { '30': {count, spacingMin, newestAgeMin}, ... },
 *     monitors: [{id,label,running,lastCheckAgeMs,expectedIntervalMs}],
 *     foldState: {tradeCount, dayPnl, trades:[], phantomFlats},
 *     todayRows: [...],
 *     brokerBalance, ledgerBalance, isFlat,
 *     pointValueVerdict, mcpTimeoutsRecent }
 * @param {object} rules rules.json
 */
function evaluate(obs, rules) {
  const o = obs || {};
  const r = rules || {};
  const checks = [];

  // ── 1. The transport ─────────────────────────────────────────────────────
  checks.push(o.cdpConnected == null
    ? check('cdp', 'TradingView CDP connection', 'unknown', { severity: SEV.CRITICAL, impact: 'Cannot tell whether the chart is reachable — every downstream reading is unverifiable.' })
    : check('cdp', 'TradingView CDP connection', o.cdpConnected ? 'pass' : 'fail', {
        severity: SEV.CRITICAL,
        impact: o.cdpConnected ? null : 'The chart is unreachable. No bars, no broker panel, no price. Every watcher is blind and any number on screen is the last one it saw.',
        rectify: o.cdpConnected ? null : 'relaunch-tradingview',
        evidence: { bridgeReady: o.bridgeReady, cdpConnected: o.cdpConnected },
      }));

  // ── 2. Broker panel tables ───────────────────────────────────────────────
  const pt = o.panelTables || {};
  const missingTables = ['positions', 'orders', 'summary'].filter(k => pt[k] === false);
  checks.push(check('panel-tables', 'Broker panel tables mounted',
    Object.keys(pt).length === 0 ? 'unknown' : (missingTables.length ? 'fail' : 'pass'), {
      severity: SEV.CRITICAL,
      impact: missingTables.length
        ? `Unmounted: ${missingTables.join(', ')}. An unreadable positions table looks IDENTICAL to a flat account, so the fold's not-flat→flat transition never fires and trades are never recorded at all.`
        : null,
      rectify: missingTables.length ? 'mount-panel-tables' : null,
      evidence: pt,
    }));

  // ── 3. Account Summary actually POPULATED ────────────────────────────────
  // Mounted is not populated. On 2026-08-28 all three tables were mounted and
  // the summary body read "There is no trading data here yet" — so day P&L had
  // silently fallen back to the fold with nothing saying so.
  if (o.summaryPopulated != null) {
    checks.push(check('summary-populated', 'Account Summary has data',
      o.summaryPopulated ? 'pass' : 'fail', {
        severity: SEV.DEGRADED,
        impact: o.summaryPopulated ? null
          : "The broker's own Total P/L is unreadable, so day P&L falls back to the balance-delta fold. The fold only counts trades THIS instance watched close, so it can understate the real session total — and the daily-loss guard reads that number.",
        rectify: o.summaryPopulated ? null : 'activate-summary-tab',
        evidence: { summaryPopulated: o.summaryPopulated, dayPnlSource: o.dayPnlSource, brokerTotalPnl: o.brokerTotalPnl },
      }));
  }

  // ── 4. Bar reads: right timeframe, and fresh ─────────────────────────────
  // The timeframe race is invisible — the bars look perfectly normal, they are
  // simply not the timeframe that was asked for.
  const bars = o.bars || {};
  for (const tf of Object.keys(bars)) {
    const b = bars[tf] || {};
    const expect = EXPECTED_SPACING_MIN[tf];
    const spacingOk = expect == null || b.spacingMin === expect;
    const enough = (b.count || 0) >= 3;
    const stale = b.newestAgeMin != null && expect != null && b.newestAgeMin > expect * 3;
    const ok = spacingOk && enough && !stale;
    checks.push(check('bars-' + tf, `Bar feed ${tf}M`, b.count == null ? 'unknown' : (ok ? 'pass' : 'fail'), {
      severity: SEV.CRITICAL,
      impact: ok ? null
        : !spacingOk ? `Returned ${b.spacingMin}-minute bars when ${tf} was requested — the chart had not finished switching. Every detector on this timeframe is reading the WRONG timeframe and cannot know it.`
        : !enough ? `Only ${b.count} bars — detectors on this timeframe cannot evaluate and will silently never fire.`
        : `Newest bar is ${b.newestAgeMin} minutes old on a ${tf}-minute timeframe — the feed has stalled and every signal is being judged on stale price.`,
      rectify: ok ? null : 'refetch-bars',
      evidence: b,
    }));
  }

  // ── 5. SILENT TURN-OFF: is every watcher actually alive? ─────────────────
  // A monitor can be `running: true` and not have checked in for an hour.
  // That is the exact shape of a silent turn-off: the flag says on, the work
  // stopped, and nothing on screen changes.
  const mons = Array.isArray(o.monitors) ? o.monitors : [];
  const dead = mons.filter(m => !m.running);
  const stalled = mons.filter(m => m.running && m.lastCheckAgeMs != null
    && m.expectedIntervalMs != null && m.lastCheckAgeMs > m.expectedIntervalMs * 3);
  checks.push(check('watchers', 'Watchers alive',
    mons.length === 0 ? 'unknown' : ((dead.length || stalled.length) ? 'fail' : 'pass'), {
      severity: SEV.CRITICAL,
      impact: (dead.length || stalled.length)
        ? `${dead.length} stopped, ${stalled.length} stalled (flag says running, no check in 3+ intervals). Setups on those timeframes are NOT being detected — the app looks identical whether a watcher is working or silently dead.`
        : null,
      rectify: (dead.length || stalled.length) ? 'restart-watchers' : null,
      evidence: { total: mons.length, stopped: dead.map(m => m.id), stalled: stalled.map(m => m.id) },
    }));

  // ── 6. Fold sanity: phantoms and count agreement ─────────────────────────
  const fs = o.foldState || {};
  const phantoms = Array.isArray(fs.trades) ? fs.trades.filter(t => Number(t && t.pnl) === 0).length : null;
  if (phantoms != null) {
    checks.push(check('fold-phantoms', 'No phantom trades in the tracker',
      phantoms === 0 ? 'pass' : 'fail', {
        severity: SEV.CRITICAL,
        impact: phantoms ? `${phantoms} zero-P&L trade(s) in the tracker. A closed trade always moves the balance because commission always applies, so a zero delta means NO FILL HAPPENED. These inflate the trade count against the per-day cap and drive the LIVE FEED MISMATCH banner.`
          : null,
        rectify: phantoms ? 'drop-phantom-trades' : null,
        evidence: { phantoms, tradeCount: fs.tradeCount, dayPnl: fs.dayPnl, phantomFlatsBlocked: fs.phantomFlats },
      }));
  }

  // ── 7. Row integrity: one trade, one row ─────────────────────────────────
  const rows = Array.isArray(o.todayRows) ? o.todayRows : null;
  if (rows) {
    const dupes = findDuplicateRows(rows, r.commissionPerContractPerSide);
    checks.push(check('row-duplicates', 'One trade, one row', dupes.length ? 'fail' : 'pass', {
      severity: SEV.CRITICAL,
      impact: dupes.length ? `${dupes.length} apparent duplicate row(s) today. Two writers record the same trade — the order-walk with GROSS P&L at the fill times, the fold with NET minutes later — so P&L, trade count and every statistic derived from them are inflated.`
        : null,
      rectify: dupes.length ? 'merge-duplicate-rows' : null,
      evidence: { rowCount: rows.length, duplicates: dupes },
    }));
  }

  // ── 8. Balance agreement — ONLY meaningful when flat ─────────────────────
  if (o.isFlat === true && Number.isFinite(o.brokerBalance) && Number.isFinite(o.ledgerBalance)) {
    const gap = Math.round((o.brokerBalance - o.ledgerBalance) * 100) / 100;
    checks.push(check('balance-agreement', 'Broker vs ledger balance', Math.abs(gap) <= 1 ? 'pass' : 'fail', {
      severity: SEV.DEGRADED,
      impact: Math.abs(gap) > 1
        ? `The ledger derivation is $${Math.abs(gap).toFixed(2)} from the broker. The displayed balance is correct (the broker wins) but the DD floor and target are derived from the ledger and are off by the same amount.`
        : null,
      rectify: null,   // needs the real opening balance — a human fact, not a repair
      evidence: { brokerBalance: o.brokerBalance, ledgerBalance: o.ledgerBalance, gap },
    }));
  }

  // ── 9. Point value ───────────────────────────────────────────────────────
  if (o.pointValueVerdict) {
    const pv = o.pointValueVerdict;
    checks.push(check('point-value', 'Contract point value', pv.status === 'mismatch' ? 'fail' : 'pass', {
      severity: SEV.CRITICAL,
      impact: pv.status === 'mismatch'
        ? 'The multiplier behind EVERY P&L figure disagrees with what TradingView reports. Day P&L, the loss tiers and payout consistency are all scaled by it.'
        : null,
      rectify: null,   // deliberately advisory — see the self-test's own note
      evidence: pv,
    }));
  }

  // ── 10. Transport contention ─────────────────────────────────────────────
  if (o.mcpTimeoutsRecent != null) {
    checks.push(check('contention', 'CDP not oversubscribed', o.mcpTimeoutsRecent > 0 ? 'fail' : 'pass', {
      severity: SEV.DEGRADED,
      impact: o.mcpTimeoutsRecent > 0
        ? `${o.mcpTimeoutsRecent} MCP timeout(s) recently. The chart watchers and the broker/position polls share ONE CDP connection; when the watchers saturate it the polls that track your live P&L are the ones that fail.`
        : null,
      rectify: null,
      evidence: { mcpTimeoutsRecent: o.mcpTimeoutsRecent },
    }));
  }

  return summarise(checks);
}

// Two rows describe the same trade when they share a size and either identical
// fill prices or a P&L gap of exactly size x round-turn commission — the
// gross/net signature of the two write paths.
function findDuplicateRows(rows, commPerSide) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const sz = Math.abs(Number(a.size) || 0);
      if (!sz || sz !== Math.abs(Number(b.size) || 0)) continue;
      const samePrices = a.side && b.side
        && String(a.side).toUpperCase() === String(b.side).toUpperCase()
        && Number(a.ep) === Number(b.ep) && Number(a.xp) === Number(b.xp);
      const gap = Math.abs(Number(a.pnl) - Number(b.pnl));
      const commApart = commPerSide != null && Math.abs(gap - sz * commPerSide * 2) < 0.02;
      if (samePrices || commApart) {
        out.push({ a: { t: a.t, pnl: a.pnl, size: a.size }, b: { t: b.t, pnl: b.pnl, size: b.size }, reason: samePrices ? 'identical fill prices' : 'P&L exactly one commission apart' });
      }
    }
  }
  return out;
}

function summarise(checks) {
  const failures = checks.filter(c => c.verdict === 'fail');
  const unknowns = checks.filter(c => c.verdict === 'unknown');
  const critical = failures.filter(c => c.severity === SEV.CRITICAL);
  return {
    checks,
    total: checks.length,
    passed: checks.filter(c => c.verdict === 'pass').length,
    failed: failures.length,
    unknown: unknowns.length,
    critical: critical.length,
    // Repairs the runner should attempt, in the order listed.
    rectifications: failures.filter(c => c.rectify).map(c => ({ key: c.key, action: c.rectify, label: c.label })),
    // The one-line headline. Deliberately says UNKNOWN out loud rather than
    // rolling it into a pass — "9/10 passed" beside an unknown is how a green
    // report hides a fault.
    headline: failures.length === 0 && unknowns.length === 0
      ? 'Live feed verified — all checks passed.'
      : `${failures.length} failing, ${unknowns.length} unverifiable, ${critical.length} critical.`,
  };
}

module.exports = { evaluate, findDuplicateRows, summarise, SEV, EXPECTED_SPACING_MIN };
