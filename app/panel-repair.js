'use strict';
/* ── panel-repair.js — when to try fixing the broker panel, and when to stop ──
 *
 * (2026-09-01. The broker feed ran degraded for 9.5 hours: day P&L fell back to
 * the balance-delta fold, trades were recorded "unverified live", and the Journal
 * stayed empty. It was not broken and it was not disconnected — TradingView
 * lazily renders the broker panel's sub-tabs, and the Account Summary tab had
 * never been clicked, so its table was not in the DOM to read.)
 *
 * ── WHY IT WENT UNFIXED FOR 9.5 HOURS ───────────────────────────────────────
 * Every piece needed already existed and none of them were connected:
 *   • tradingview-mcp exposes `trading_ensure_panel_ready`, which clicks
 *     unrendered tabs and restores whichever tab was showing.
 *   • Its PANEL_TABLES already maps summary -> accountSummary-table.
 *   • server.js called it as want:['positions','orders'] — never 'summary'.
 *   • And when the summary read failed it logged "Check the Account Summary tab
 *     in the broker panel", asking Anoop to do by hand the exact thing the tool
 *     does automatically.
 * So the app could see the fault, could name the fault, could fix the fault, and
 * asked a human to fix it instead. This module closes that loop.
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
 * The DECISION, not the action: should a repair be attempted right now? The
 * clicking lives in the MCP tool; the judgement about repeating it lives here so
 * it can be tested without a browser.
 *
 * THE RULE THAT MATTERS: a repair that has not worked must stop and escalate,
 * not keep firing. The oversize guard learned this expensively on 2026-08-31 —
 * six "successful" actions against a stale read walked a long position into a
 * short. Clicking a tab is far less dangerous than sending an order, but a
 * silent retry loop hides a fault that a human could fix in two seconds, and
 * that is exactly how this one survived 9.5 hours.
 *
 * PURE. No fs, no clock, no chart. Unit-tested in test/panel-repair.test.js.
 */

const DEFAULTS = {
  cooldownMs: 60000,     // never hammer the panel; one attempt a minute at most
  maxPerDay: 20,         // clicking is cheap, but a loop is still a bug
  escalateAfter: 3,      // consecutive failures before telling him it needs hands
};

const ACTION = {
  REPAIR: 'REPAIR',       // attempt it
  COOLING: 'COOLING',     // too soon since the last attempt
  CAPPED: 'CAPPED',       // hit the daily ceiling
  ESCALATE: 'ESCALATE',   // repair keeps failing — a human is needed
  HEALTHY: 'HEALTHY',     // nothing to repair
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function freshState(dayKey) {
  return { dayKey: dayKey || null, attempts: 0, consecutiveFailures: 0, lastAttemptAt: 0, escalated: false };
}

/** New trading day resets the budget, never the escalation of an ongoing fault. */
function rollDay(state, dayKey) {
  const st = Object.assign(freshState(dayKey), state || {});
  if (st.dayKey !== dayKey) return freshState(dayKey);
  return st;
}

/**
 * @param {object} health   { summaryReadable, positionsReadable, ordersReadable }
 * @param {object} state    from rollDay()
 * @param {number} nowMs
 * @param {object} cfg      partial DEFAULTS
 * @returns {{action, want:string[], reason, state}}
 */
function decide(health, state, nowMs, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const st = Object.assign(freshState(null), state || {});
  const now = num(nowMs) != null ? num(nowMs) : 0;
  const h = health || {};

  // Only tabs that actually read as broken are asked for. Requesting a tab that
  // is already fine makes the tool click away from whatever he is looking at
  // for no reason.
  const want = [];
  if (h.summaryReadable === false) want.push('summary');
  if (h.positionsReadable === false) want.push('positions');
  if (h.ordersReadable === false) want.push('orders');

  const out = (action, reason) => ({ action, want, reason, state: st });

  if (!want.length) {
    // Recovery clears the failure streak AND the escalation: the fault is gone,
    // so a future occurrence deserves a fresh set of attempts rather than
    // inheriting a latch from hours ago.
    return { action: ACTION.HEALTHY, want: [], reason: 'Broker panel tables all readable.',
      state: Object.assign({}, st, { consecutiveFailures: 0, escalated: false }) };
  }

  if (st.escalated) {
    return out(ACTION.ESCALATE, 'Repair already escalated for this fault — waiting for a human, not retrying.');
  }
  if (st.consecutiveFailures >= c.escalateAfter) {
    return { action: ACTION.ESCALATE, want,
      reason: 'Auto-repair failed ' + st.consecutiveFailures + ' times in a row on: ' + want.join(', ')
        + '. Stopping so this is visible instead of looping silently — open the broker panel and click those tabs once.',
      state: Object.assign({}, st, { escalated: true }) };
  }
  if (st.attempts >= c.maxPerDay) {
    return out(ACTION.CAPPED, 'Hit the daily repair ceiling of ' + c.maxPerDay + '. Reporting only.');
  }
  if (st.lastAttemptAt && (now - st.lastAttemptAt) < c.cooldownMs) {
    return out(ACTION.COOLING, 'Within the ' + Math.round(c.cooldownMs / 1000) + 's cooldown from the last repair.');
  }

  return { action: ACTION.REPAIR, want,
    reason: 'Attempting to render: ' + want.join(', ') + ' (attempt ' + (st.attempts + 1) + ' today).',
    state: Object.assign({}, st, { attempts: st.attempts + 1, lastAttemptAt: now }) };
}

/** Fold the outcome of an attempted repair back into the state. */
function recordResult(state, worked) {
  const st = Object.assign(freshState(null), state || {});
  return Object.assign({}, st, {
    consecutiveFailures: worked ? 0 : st.consecutiveFailures + 1,
    escalated: worked ? false : st.escalated,
  });
}

module.exports = { decide, rollDay, recordResult, freshState, ACTION, DEFAULTS };
