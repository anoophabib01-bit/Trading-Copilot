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

  // ── 3a. MOUNTED IS NOT RENDERED (2026-09-02) ─────────────────────────────
  // Check 2 above asks whether the <table> is in the DOM. It was TRUE through
  // the whole of 2026-09-01 and 2026-09-02 while the feed ran degraded, because
  // ka-table mounts the table for every sub-tab but renders BODY ROWS only for
  // the tab that is showing. A hidden Orders tab therefore returns a perfectly
  // well-formed table with zero rows.
  //
  // This is the same shape of mistake as check 3 (mounted != populated) one
  // block below, found on 2026-08-28 — and check 3 was only ever applied to the
  // summary. The orders table had the identical fault and no check for it, so
  // the live-feed self-test printed 3/3 PASSED while:
  //   • the order-history walk was dropped on every poll,
  //   • every close was written by the balance-delta fold with xp:null,
  //   • the trade count came from balance moves rather than round trips,
  //   • the post-exit drift panel anchored on a two-day-old exit price,
  //   • the oversize guard reported STUCK against a positions table that was
  //     not repainting, and was then switched off for the session.
  // Four symptoms, one cause, and the detector said everything was fine.
  //
  // THE TEST. A position cannot exist without a filled order that created it.
  // So "zero order rows while a position is open" is not a state the broker can
  // be in; it is proof the table has not rendered. TradingView's own explicit
  // "no trading data here yet" placeholder is the opposite — that IS a rendered
  // empty table, and must not be flagged.
  if (o.panelRows) {
    const pr = o.panelRows;
    const unrendered = pr.openPositions > 0 && pr.orderRows === 0 && !pr.ordersEmptyState;
    const knowable = pr.openPositions != null && pr.orderRows != null;
    checks.push(check('panel-rows', 'Broker panel tables RENDERING rows',
      !knowable ? 'unknown' : (unrendered ? 'fail' : 'pass'), {
        severity: SEV.CRITICAL,
        impact: unrendered
          ? 'The orders table is mounted but rendering NO rows while ' + pr.openPositions
            + ' position(s) are open — a position cannot exist without a filled order, so the table has not repainted.'
            + ' Everything derived from order history is therefore unavailable: the round-trip walk is dropped, so closes are'
            + ' recorded by the balance-delta fold with NO entry price, NO exit price and NO side; the trade count becomes a'
            + ' count of balance moves rather than trades; and the post-exit drift panel silently keeps anchoring on the last'
            + ' exit it has a price for, which can be days old while looking current.'
          : null,
        rectify: unrendered ? 'render-orders-table' : null,
        evidence: pr,
      }));

    // ── 3b. Positions table mounted-but-unrendered (G2, 2026-09-08) ─────────
    // Symmetric to 3a: an open position is not required to detect a hidden
    // Positions tab. A mounted positions table that renders ZERO rows and has
    // no "There are no open positions" placeholder is not proof of a flat
    // account — it is proof the table has not repainted.
    if (o.panelRows) {
      const pr = o.panelRows;
      const positionsUnrendered = pr.openPositions === 0 && !pr.positionsEmptyState;
      const positionsKnowable = pr.openPositions != null && pr.positionsEmptyState != null;
      checks.push(check('panel-positions', 'Broker Positions table RENDERING',
        !positionsKnowable ? 'unknown' : (positionsUnrendered ? 'fail' : 'pass'), {
          severity: SEV.CRITICAL,
          impact: positionsUnrendered
            ? 'The positions table is mounted but rendering NO rows and no empty-state placeholder — an open position would be read as FLAT. Oversize and per-trade-stop guards are blind.'
            : null,
          rectify: positionsUnrendered ? 'render-positions-table' : null,
          evidence: pr,
        }));
    }

  }

  // ── 3c. Did today's trades actually keep their prices? ───────────────────
  // The consequence check for 3a, and the one that proves a fix rather than
  // asserting it. 3a can pass at startup (flat account, nothing to render) and
  // the fault still appear the moment he opens a position. This reads the
  // outcome instead: rows written today that carry no exit price.
  //
  // Deliberately NOT a failure when there are no trades yet — an empty day is
  // not a broken day, and a check that cries wolf every morning before the open
  // is a check he learns to scroll past.
  if (Array.isArray(o.todayRows) && o.todayRows.length) {
    const total = o.todayRows.length;
    const priced = o.todayRows.filter(t => t && t.xp != null).length;
    const foldOnly = total - priced;
    checks.push(check('trade-detail', "Today's trades kept their prices",
      foldOnly === 0 ? 'pass' : 'fail', {
        // Not CRITICAL: the NET P&L of a fold row is trustworthy and the money
        // guardrails still work. What is lost is every per-trade fact, which is
        // a coaching and analysis failure rather than a risk one.
        severity: SEV.DEGRADED,
        impact: foldOnly === 0 ? null
          : foldOnly + ' of ' + total + " of today's recorded trades have NO exit price — they came from the balance-delta"
            + ' fold, which knows the money and nothing else. Their net P&L is real; their entry, exit, side, hold and'
            + ' count are not, and nothing may compute statistics or coach on them. This is the downstream signature of'
            + ' the orders table not rendering (see panel-rows).',
        rectify: foldOnly === 0 ? null : 'render-orders-table',
        evidence: { total, priced, foldOnly },
      }));
  }

  // ── 3b. The oversize guard is actually watching ──────────────────────────
  // Added 2026-09-02, the day it was armed, able to send orders, and silent
  // through a real 5-lot. Nothing in this protocol had ever asserted on the ONE
  // guard that can act on the account unasked — it checked the feeds the guard
  // reads, but never the guard itself. "The positions table is mounted" is not
  // "the guard saw a position": on that session panel-tables passed all day.
  //
  // Three distinct failures, deliberately NOT collapsed into one verdict,
  // because the right response to each is different:
  //   off      — he turned it off (or rules.json has), so size is unenforced
  //              BY CHOICE. Reported, not rectified: undoing a decision he made
  //              is not this protocol's business.
  //   blind    — the positions table is unreadable, so an oversize cannot be
  //              seen at all. This is the one that looks like "flat".
  //   stale    — reads are arriving but are older than the watch cadence, i.e.
  //              the watch itself has stopped ticking.
  // alarm-only is NOT a failure: it still shouts, it just cannot send the
  // reducing order. Flagging it as broken would train him to ignore this line.
  const og = o.oversizeGuard;
  if (og) {
    const stale = og.lastReadAgeMs != null && og.lastReadAgeMs > (og.expectedReadIntervalMs || 5000) * 6;
    const neverRead = og.lastReadAt == null;
    const bad = !og.armed || og.blind || stale || neverRead;
    let impact = null;
    if (!og.armed) {
      impact = og.userDisabled
        ? 'The oversize guard is switched OFF for this session. Contract size is not being enforced by anything — the broker ceiling is 40 micros against your cap of ' + (og.sizeCap != null ? og.sizeCap : '?') + '.'
        : 'The oversize guard is disabled in rules.json. Nothing in the app enforces contract size.';
    } else if (og.blind) {
      impact = 'The guard is armed but the positions table is unreadable, so it cannot see an oversize at all — an unreadable table looks IDENTICAL to a flat account. Size is unenforced until reads recover.';
    } else if (neverRead) {
      impact = 'The guard has never completed a position read this session, so it has never been in a position to enforce anything.';
    } else if (stale) {
      impact = 'The guard last saw the account ' + Math.round(og.lastReadAgeMs / 1000) + 's ago against a ' + Math.round((og.expectedReadIntervalMs || 5000) / 1000) + 's watch cadence — the position watch has stopped ticking.';
    }
    checks.push(check('oversize-guard', 'Oversize guard watching', bad ? 'fail' : 'pass', {
      severity: og.armed ? SEV.CRITICAL : SEV.DEGRADED,
      impact,
      // Blindness is a panel problem and the panel already has a repair.
      // Being switched off is a decision, and decisions are not auto-reverted.
      rectify: (og.armed && (og.blind || neverRead)) ? 'mount-panel-tables' : null,
      evidence: {
        mode: og.mode, armed: og.armed, canAct: og.canAct, sizeCap: og.sizeCap,
        lastSeenSize: og.lastSeenSize, lastRowCount: og.lastRowCount,
        lastReadAgeMs: og.lastReadAgeMs, blindReads: og.blindReads,
        actionsToday: og.actionsToday, stuck: og.stuck,
      },
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

  // ── 10b. THE POSITION READ'S ACTUAL CADENCE (2026-09-02) ─────────────────
  // Check 10 catches contention only once it has become an outright MCP
  // TIMEOUT. Everything short of that — a lock queue seven deep turning a 5s
  // position watch into an effective 20-30s — was invisible, and it is the
  // regime that actually did the damage: on 2026-09-02 he reached 16 contracts
  // against a cap of 2 while the app recorded a peak of 4, with zero timeouts
  // logged in that window. The reads were not failing. They were queued.
  //
  // The oversize guard is the only thing here that can act on the account
  // unasked, and its safety model assumes its reads are CURRENT. So the queue
  // that read waits in is a safety property and gets a check of its own.
  if (o.lockDepth) {
    const ld = o.lockDepth;
    // Depth OR wait. Depth is the proxy; the WAIT is the fault, and the two can
    // disagree — a queue two deep behind one slow call is worse for the guard
    // than a queue five deep of fast ones. Whichever says "stale", counts.
    const deepQueue = ld.brokerMax != null && ld.brokerMax >= (ld.warnAt || 4);
    const longWait = ld.brokerMaxWaitMs != null && ld.brokerMaxWaitMs >= (ld.warnWaitMs || 8000);
    const bad = deepQueue || longWait;
    checks.push(check('lock-queue', 'Broker lock not saturated',
      ld.brokerMax == null ? 'unknown' : (bad ? 'fail' : 'pass'), {
        severity: SEV.DEGRADED,
        impact: bad
          ? 'The broker lock queued ' + ld.brokerMax + ' deep'
            + (longWait ? ' and a call waited ' + Math.round(ld.brokerMaxWaitMs / 1000) + 's before running' : '')
            + '. Every operation on it is serialised, so the 5s position watch — the read the oversize guard acts'
            + ' on — has been waiting behind other calls. Its effective cadence is several times its configured'
            + ' one, and the guard cannot see a size breach it is not being shown.'
            + ' NOTHING TIMED OUT: every one of those calls succeeded, just late, which is why no error appears'
            + ' anywhere else. Raising the timeout would make this WORSE — the timeout is what abandons a stuck'
            + ' call and frees the lock, so a longer one means a longer wait for whoever is next.'
          : null,
        // No auto-repair: the fix is fewer or cheaper chart reads, which is a
        // design decision, not something to attempt mid-session.
        rectify: null,
        evidence: ld,
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

// ── G25: daily reconciliation (2026-09-08) ────────────────────────────────
// The three P&L stores must agree, and the feed's own tradeCount must equal
// trades.length minus the phantoms it rejected. Same doctrine as week-rollup's
// disagreeDays: REPORT the disagreement, never pick a winner, and csvApply stays
// the only authoritative correction. Pure — the runner gathers, this decides.
function dailyReconciliationCheck(obs) {
  const o = obs || {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const dayPnl = n(o.dayPnl), dayTradesSum = n(o.dayTradesSum), grHistoryPnl = n(o.grHistoryPnl);
  const tradeCount = n(o.tradeCount), tradesLength = n(o.tradesLength);
  const phantomFlats = n(o.phantomFlats) || 0;
  const tolerance = n(o.threshold) != null ? o.threshold : 0.02;
  const evidence = { dayPnl, dayTradesSum, grHistoryPnl, tradeCount, tradesLength, phantomFlats };

  // Internal consistency first: tradeCount must equal trades.length minus phantoms.
  if (tradeCount != null && tradesLength != null) {
    const expected = tradesLength - phantomFlats;
    if (Math.abs(tradeCount - expected) > 0.5) {
      return check('daily-count', 'Broker feed count vs row count', 'fail', {
        severity: SEV.CRITICAL,
        impact: `tradeCount ${tradeCount} does not equal ${tradesLength} rows minus ${phantomFlats} rejected phantom(s) (${expected}) — the per-day cap is counting a wrong number.`,
        evidence,
      });
    }
  }

  // Three-way P&L: feed dayPnl vs day_trades row sum vs gr_history pnl.
  const vals = [dayPnl, dayTradesSum, grHistoryPnl].filter((v) => v != null);
  const spread = vals.length ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : 0;
  if (vals.length >= 2 && spread > tolerance) {
    return check('daily-pnl', 'Daily P&L across three stores', 'fail', {
      severity: SEV.CRITICAL,
      impact: `the three P&L stores disagree by $${spread.toFixed(2)} — feed ${dayPnl}, day_trades sum ${dayTradesSum}, gr_history ${grHistoryPnl}. Reported, not auto-corrected; a broker CSV through csvApply is the only fix.`,
      evidence,
    });
  }

  return check('daily-reconcile', 'Daily P&L and count reconcile', 'pass', { severity: SEV.INFO, evidence });
}

module.exports = { evaluate, findDuplicateRows, summarise, dailyReconciliationCheck, SEV, EXPECTED_SPACING_MIN };
