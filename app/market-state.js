'use strict';
// ── Market state line (LIVE_FEED_LOOP_PLAN.md task 3.1) ─────────────────────
// One context line rendering the live armed setup (or its absence) plus the
// mechanical 1H bias, injected into the SHARED agent context block so it
// reaches Jessi, the Judge, the Scalper and the Post-Session Analyst in one
// change. Deliberately NOT given to the Analysis/PO3 debate agents (decision
// 3). Pure — server.js supplies the inputs; nothing here reads global state.

const TF_SECONDS = {
  '1': 60, '5': 300, '15': 900, '30': 1800, '45': 2700,
  '60': 3600, '120': 7200, '180': 10800, '240': 14400,
  'D': 86400, 'W': 604800, 'M': 2592000
};

function tfSecondsFor(tfCode) {
  const tf = String(tfCode || '');
  if (TF_SECONDS[tf]) return TF_SECONDS[tf];
  const n = parseInt(tf, 10);
  if (Number.isFinite(n) && n > 0) return n * 60;
  return 900; // unknown code → 15m
}

function setupDetail(setup) {
  return [
    setup.direction || '',
    setup.tfLabel || setup.tfCode || '',
    setup.level != null ? 'level ' + setup.level : '',
    setup.gapLow != null ? 'gap ' + setup.gapLow + '-' + setup.gapHigh : ''
  ].filter(Boolean).join(' · ');
}

function marketStateLine(setup, ctx) {
  const c = ctx || {};
  const now = c.nowMs != null ? c.nowMs : Date.now();
  const bias = c.hourTrendLabel
    ? c.hourTrendLabel + (c.hourTrendDirection ? ' (' + c.hourTrendDirection + ')' : '')
    : 'unknown';
  const session = c.sessionTier || 'outside-session';
  if (!setup) {
    return `MARKET (live chart): no setup armed — watching A, B, C on 1H/30M/15M. 1H bias: ${bias}. Session: ${session}.`;
  }
  const firedMin = Math.max(0, Math.round((now - setup.signalTs) / 60000));
  const candlesLeft = Math.max(1, Math.round((setup.expiresAt - now) / (tfSecondsFor(setup.tfCode) * 1000)));
  let line = `MARKET (live chart): SETUP LIVE — Playbook ${setup.playbook} ${setupDetail(setup)}`;
  line += ` — fired ${firedMin}m ago · expires in ~${candlesLeft} candles · ${session} session`;
  line += ` — 1H bias: ${bias} (Daily is Anoop's read — not provided)`;
  if (setup.message) line += ` — validity: ${setup.message}`;
  return line;
}

module.exports = { marketStateLine, tfSecondsFor, setupDetail };
