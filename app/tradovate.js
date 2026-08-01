'use strict';
// Tradovate read-only feed — STAGED / LIVE-UNTESTED.
// Auth + poll -> aggregated "today" numbers for the guardrail (auto mode).
// Field mapping marked NEEDS-VALIDATION until checked against a real payload.
const APP_VERSION = '1.0';
let timer = null, tok = null, tokExp = 0;
let prev = { dayPnl: 0, maxSize: 0, lastLossTs: 0, started: false };
let last = { connected: false };

const base = env => (env === 'live' ? 'https://live.tradovateapi.com/v1' : 'https://demo.tradovateapi.com/v1');

async function auth(cfg) {
  const r = await fetch(base(cfg.tvEnv) + '/auth/accesstokenrequest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: cfg.tvName, password: cfg.tvPassword, appId: cfg.tvAppId || 'MNQ Co-Pilot', appVersion: APP_VERSION, cid: cfg.tvCid, sec: cfg.tvSec, deviceId: 'mnq-copilot' })
  });
  const j = await r.json().catch(() => ({}));
  if (j && j.accessToken) { tok = j.accessToken; tokExp = Date.parse(j.expirationTime || '') || (Date.now() + 3600000); return j; }
  throw new Error((j && (j.errorText || j.errmsg)) || ('auth HTTP ' + r.status));
}
async function get(cfg, pathq) {
  const r = await fetch(base(cfg.tvEnv) + pathq, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + pathq);
  return r.json();
}

async function testConnection(cfg) {
  try {
    if (!cfg.tvName || !cfg.tvCid || !cfg.tvSec) return { ok: false, error: 'Missing Tradovate credentials in Settings.' };
    await auth(cfg);
    const accts = await get(cfg, '/account/list');
    const names = (Array.isArray(accts) ? accts : []).map(a => a.name || a.nickname || ('#' + a.id));
    return { ok: true, accounts: names, env: cfg.tvEnv || 'demo' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// pure + unit-tested: fold a fresh snapshot into tracking state.
function fold(prevState, snap, now) {
  const maxSize = Math.max(prevState.maxSize || 0, snap.posSize || 0, snap.maxFillQty || 0);
  let lastLossTs = prevState.lastLossTs || 0;
  if (prevState.started && (snap.dayPnl - (prevState.dayPnl || 0)) <= -1) lastLossTs = now; // realized P&L fell => a loss closed
  return { maxSize, lastLossTs, dayPnl: snap.dayPnl, started: true };
}

function todayStartMs() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

async function poll(cfg, onData) {
  try {
    if (Date.now() > tokExp - 60000) await auth(cfg);
    const [fills, positions] = await Promise.all([get(cfg, '/fill/list'), get(cfg, '/position/list')]);
    const start = todayStartMs();
    // NEEDS-VALIDATION: confirm these field names against real Tradovate payloads.
    const todayFills = (Array.isArray(fills) ? fills : []).filter(f => Date.parse(f.timestamp || f.tradeDate || 0) >= start);
    const tradeCount = todayFills.length;
    const maxFillQty = todayFills.reduce((m, f) => Math.max(m, Math.abs(f.qty || 0)), 0);
    const posSize = (Array.isArray(positions) ? positions : []).reduce((m, p) => Math.max(m, Math.abs(p.netPos || 0)), 0);
    const dayPnl = (Array.isArray(positions) ? positions : []).reduce((a, p) => a + (p.realizedPnl || 0), 0);
    prev = fold(prev, { posSize, maxFillQty, dayPnl, tradeCount }, Date.now());
    last = { connected: true, tradeCount, dayPnl: prev.dayPnl, maxSize: prev.maxSize, lastLossTs: prev.lastLossTs };
    onData(last);
  } catch (e) { last = { connected: false, error: String(e.message || e) }; onData(last); }
}

function start(cfg, onData) {
  stop();
  if (!cfg || !cfg.tvEnabled || !cfg.tvName || !cfg.tvCid || !cfg.tvSec) { last = { connected: false }; return; }
  prev = { dayPnl: 0, maxSize: 0, lastLossTs: 0, started: false };
  poll(cfg, onData);
  timer = setInterval(() => poll(cfg, onData), 5000);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function lastSnapshot() { return last; }

module.exports = { testConnection, start, stop, lastSnapshot, fold };
