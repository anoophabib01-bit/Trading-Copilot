'use strict';
/* ── Three-way verification against the broker (2026-08-26) ─────────────────
 * Anoop: "i do not want this to happen again it should verify with live broker
 * data and then use API. if not API will read wrong data and token is simply
 * wasted. before every output it should verify."
 *
 * WHY
 * ---
 * Every number failure in this app has had the same shape: one source was
 * wrong, nothing compared it to a second source, and the wrong number was
 * handed to an agent — or to him — as fact.
 *
 *   2026-08-24  day P&L $553.90 out (the fold anchored mid-session; the
 *               broker's own figure was on the wire the whole time)
 *   2026-08-24  15 trades reported against a real 7
 *   2026-08-25  $114.00 of commission charged twice (a live row's net pnl
 *               read as gross)
 *   2026-08-26  a day's trades in the fold and absent from the day record
 *
 * Every one was detectable by comparing what the app believed against what
 * the broker's own order history said. Nothing did that comparison.
 *
 * WHAT THIS IS
 * ------------
 * Pure. Given the app's day rows and the broker's own evidence, it says
 * whether they agree, and returns a verdict an agent prompt can be gated on:
 *
 *   verified    every check that could be run, passed
 *   unverified  the broker's side was not readable — NOT a pass
 *   mismatch    a check actively disagreed; the numbers are known-suspect
 *
 * "unverified" being distinct from "verified" is the entire point. Collapsing
 * them is how a silent failure becomes a confident wrong answer, and this
 * codebase has done it before (`ckGateIsOpen` folded three different reasons
 * for "open" into one boolean and shipped).
 *
 * WHAT IT IS NOT
 * --------------
 * It does not fix numbers, pick a winner, or block anything by itself. It
 * reports. The caller decides what an unverified figure is allowed to be used
 * for — see formatLiveFeedContext in server.js, which stops agents doing
 * arithmetic on figures this could not stand behind.
 */

const DEFAULT_PNL_TOLERANCE = 1.0;   // dollars — sub-dollar drift is rounding

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Same rule as day-rollup.js and trade-identity.js. Three copies exist so no
// consumer depends on load order; they are tested against each other.
function pnlBasisOf(row) {
  if (!row) return 'gross';
  if (row.pnlBasis === 'net' || row.pnlBasis === 'gross') return row.pnlBasis;
  if (row.evidence === 'fold' || row.source === 'live-fold-only') return 'net';
  return 'gross';
}

function grossOf(row, commPerCt) {
  const pnl = num(row && row.pnl) || 0;
  if (pnlBasisOf(row) !== 'net') return pnl;
  return pnl + (num(row.size) || 0) * commPerCt;
}

/**
 * @param {object} input
 *   appRows        today's day_trades rows (the app's own record)
 *   commPerCt      ROUND-TURN commission per contract
 *   walkClosed     analyzeOrderWalk(...).closed for today, or null when the
 *                  orders table could not be trusted this poll
 *   brokerRealized the broker panel's own realized session P&L, or null
 *   openSize       contracts currently open (a check that would be wrong
 *                  mid-position is skipped rather than failed)
 */
function verifyDay(input) {
  const o = input || {};
  const rows = Array.isArray(o.appRows) ? o.appRows.filter(Boolean) : [];
  const comm = num(o.commPerCt) || 0;
  const walk = Array.isArray(o.walkClosed) ? o.walkClosed : null;
  const brokerRealized = num(o.brokerRealized);
  const openSize = num(o.openSize) || 0;
  const tol = num(o.pnlTolerance) != null ? num(o.pnlTolerance) : DEFAULT_PNL_TOLERANCE;

  // An open position is a round trip the broker's walk has not closed yet, so
  // the app legitimately holds one more trade AND its contracts. Both counts
  // are skewed by the same open trade, so both must be skipped together —
  // guarding only the trade count left `contracts` failing on every position
  // he was still in, which is an alarm that fires constantly and therefore
  // gets ignored.
  const openTradeSkew = (num(o.openSize) || 0) !== 0
    && Array.isArray(o.walkClosed)
    && (Array.isArray(o.appRows) ? o.appRows.filter(Boolean).length : 0) === o.walkClosed.length + 1;

  const checks = [];
  // `external` marks a check that compared the app against the BROKER. Only
  // those can earn a 'verified'. The P&L-basis check below is internal
  // self-consistency: worth reporting, but passing it while every broker
  // check was skipped means the app agrees with ITSELF and nothing more.
  // Counting it was enough to make a completely blind run report 'verified'
  // off one passing check — the exact collapse of "could not check" into
  // "fine" that this module exists to prevent, found by its own test.
  const add = (name, status, detail, external) => checks.push({ name, status, detail, external: external !== false });

  // ── 1. trade count ────────────────────────────────────────────────────────
  if (walk) {
    // A position open right now is a round trip the walk has not closed yet,
    // so the app legitimately has one fewer. Comparing through that would
    // report a mismatch every time he is in a trade.
    const expected = walk.length;
    const got = rows.length;
    if (openTradeSkew) {
      add('trade count', 'skip', 'a position is open — the walk cannot close it yet');
    } else if (got === expected) {
      add('trade count', 'pass', got + ' trades in both');
    } else {
      add('trade count', 'fail', 'the app has ' + got + ' trade(s), the broker\'s order history shows ' + expected);
    }
  } else {
    add('trade count', 'skip', 'the broker order history was not readable');
  }

  // ── 2. contracts ──────────────────────────────────────────────────────────
  if (walk) {
    const appCt = rows.reduce((a, r) => a + (num(r.size) || 0), 0);
    const brokerCt = walk.reduce((a, r) => a + (num(r.size) || 0), 0);
    // size 0 means "not observed", so an app total that is LOW by a whole
    // trade's size is a known gap, not a contradiction.
    const unobserved = rows.filter(r => !(num(r.size) > 0)).length;
    if (openTradeSkew) add('contracts', 'skip', 'a position is open — its contracts are in the app and not yet in the walk');
    else if (appCt === brokerCt) add('contracts', 'pass', appCt + ' in both');
    else if (unobserved) add('contracts', 'skip', unobserved + ' row(s) never had their size observed, so the app total under-counts by construction');
    else add('contracts', 'fail', 'the app has ' + appCt + ', the broker\'s order history shows ' + brokerCt);
  } else {
    add('contracts', 'skip', 'the broker order history was not readable');
  }

  // ── 3. the day's money ────────────────────────────────────────────────────
  if (brokerRealized !== null) {
    const gross = rows.reduce((a, r) => a + grossOf(r, comm), 0);
    const contracts = rows.reduce((a, r) => a + (num(r.size) || 0), 0);
    const appNet = Math.round((gross - contracts * comm) * 100) / 100;
    const drift = Math.round((appNet - brokerRealized) * 100) / 100;
    if (Math.abs(drift) <= tol) {
      add('day P&L', 'pass', 'app $' + appNet.toFixed(2) + ' vs broker $' + brokerRealized.toFixed(2));
    } else {
      add('day P&L', 'fail', 'the app says $' + appNet.toFixed(2)
        + ", the broker's own panel says $" + brokerRealized.toFixed(2)
        + ' — off by $' + drift.toFixed(2));
    }
  } else {
    add('day P&L', 'skip', "the broker's own P&L panel was not readable");
  }

  // ── 4. basis coherence ────────────────────────────────────────────────────
  // Not a broker comparison — an internal one. A row whose pnl is net while
  // the day is summed as gross is the 2026-08-25 bug, and it is invisible in
  // any total because it is exactly one commission out.
  const mixed = rows.some(r => pnlBasisOf(r) === 'net') && rows.some(r => pnlBasisOf(r) === 'gross');
  const unstamped = rows.filter(r => !r.pnlBasis).length;
  if (unstamped) {
    add('P&L basis', 'warn', unstamped + ' row(s) carry no pnlBasis stamp — their basis is being inferred from provenance', false);
  } else if (mixed) {
    add('P&L basis', 'info', 'mixed gross/net rows, all explicitly stamped', false);
  } else {
    add('P&L basis', 'info', 'all rows stamped', false);
  }

  const failed = checks.filter(c => c.external && c.status === 'fail');
  const ran = checks.filter(c => c.external && (c.status === 'pass' || c.status === 'fail'));
  const verdict = failed.length ? 'mismatch'
    : (ran.length ? 'verified' : 'unverified');

  return {
    verdict,
    checks,
    failed: failed.map(c => c.name),
    // How much of the check suite could actually run. An agent told
    // "verified" off a single passing check should know that.
    ranCount: ran.length,
    totalCount: checks.filter(c => c.external).length,
  };
}

/**
 * The block that goes into an agent's context. This is the gate Anoop asked
 * for: on anything other than a clean verify, the agent is told plainly that
 * it must not do arithmetic on these figures or state them as fact — which is
 * what stops a wrong number becoming a confident coaching answer, and stops
 * tokens being spent reasoning about it.
 */
function formatVerificationContext(result) {
  if (!result) return '';
  const lines = [];
  if (result.verdict === 'verified') {
    lines.push('VERIFIED against the broker\'s own order history and P&L panel ('
      + result.ranCount + ' of ' + result.totalCount + ' checks ran, all passed). '
      + 'These figures are safe to reason about and to quote to him.');
  } else if (result.verdict === 'mismatch') {
    lines.push('*** DO NOT TRUST THESE NUMBERS *** The app\'s own record DISAGREES with the broker on: '
      + result.failed.join(', ') + '.');
    result.checks.filter(c => c.status === 'fail').forEach(c => lines.push('  - ' + c.name + ': ' + c.detail));
    lines.push('Do NOT compute with these figures, do NOT quote them as his P&L or trade count, and do NOT '
      + 'give sizing or stop advice that depends on them. Tell him plainly that the app and the broker '
      + 'disagree, name both numbers, and tell him to read the broker panel directly before he trades.');
  } else {
    lines.push('NOT VERIFIED — the broker\'s side could not be read, so nothing here has been checked against it. '
      + 'This is NOT the same as correct. Treat every figure below as unconfirmed: you may repeat one while '
      + 'saying it is unconfirmed, but do not compute with it and do not let it drive a size or stop decision.');
    result.checks.filter(c => c.status === 'skip').forEach(c => lines.push('  - ' + c.name + ': ' + c.detail));
  }
  result.checks.filter(c => c.status === 'warn').forEach(c => lines.push('  ! ' + c.name + ': ' + c.detail));
  return lines.join('\n');
}

module.exports = { verifyDay, formatVerificationContext, pnlBasisOf, grossOf, DEFAULT_PNL_TOLERANCE };
