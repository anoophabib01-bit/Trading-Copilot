#!/usr/bin/env node
/**
 * blind-watch.js — read-only watchdog for the "app reports FLAT while a real
 * position is open" failure (DSH_GATE_AND_FEED_FIXES_PLAN.md G28).
 *
 * WHY THIS EXISTS (2026-09-14): Anoop opened a 1-lot MNQU6 long; for ~16 minutes
 * the app reported Position FLAT, counted only closed P&L, and the per-trade stop
 * alarmed "unrealised P&L UNREADABLE". Nothing turned red, so the clickable
 * "re-check" affordance never appeared. One forced tv-broker-check-now fixed it.
 * This watcher does that automatically and records what happened.
 *
 * WHAT IT DOES (every INTERVAL):
 *   1. Ground truth: reads TradingView's own orders table over CDP :9222 and sums
 *      FILLED quantities for the day. net != 0  ->  a position IS open.
 *   2. App truth: connects to the app's WebSocket :7433, triggers a broker read,
 *      and reads what the app believes (positions.count, guard blind flags,
 *      summary profit).
 *   3. If net != 0 but the app says 0 positions (or a guard reports blind) ->
 *      BLIND. It immediately forces another read (auto-recovery) and re-checks.
 *   4. Appends one JSON line per cycle verdict change and per blind event to
 *      DATA/blind-watch.log.
 *
 * It NEVER places, modifies or cancels an order, never writes app state, and only
 * sends the app's own read-only poll trigger.
 *
 * Usage: node app/scripts/blind-watch.js [--interval 15000] [--max-minutes 480]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ARG = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const INTERVAL = parseInt(ARG('interval', '15000'), 10);
const MAX_MINUTES = parseInt(ARG('max-minutes', '480'), 10);
const CDP = ARG('cdp', 'http://127.0.0.1:9222');
const APP = ARG('app', 'ws://127.0.0.1:7433');
const LOG = ARG('log', path.join('G:/MNQ-CoPilot', 'DATA', 'blind-watch.log'));

let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch (e) { WebSocketImpl = globalThis.WebSocket; }
if (!WebSocketImpl) { console.error('no WebSocket implementation available'); process.exit(1); }

function log(obj) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj));
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  console.log(line);
}

// ---- ground truth: net filled qty from TradingView's own orders table ----
async function brokerNetQty() {
  let targets;
  try { targets = await (await fetch(CDP + '/json/list')).json(); } catch (e) { return { error: 'cdp_unreachable' }; }
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('tradingview.com/chart'))
            || targets.find(t => t.type === 'page' && String(t.title || '').includes('TradingView'));
  if (!page) return { error: 'no_chart_page' };
  const expr = "(function(){var t=document.querySelector('table[data-name$=\"orders-table\"]');" +
    "if(!t) return JSON.stringify({found:false});" +
    "var h=Array.from(t.querySelectorAll('thead th')).map(function(x){return (x.innerText||'').trim();});" +
    "var rows=Array.from(t.querySelectorAll('tbody tr')).map(function(tr){return Array.from(tr.querySelectorAll('td')).map(function(td){return (td.innerText||'').trim();});});" +
    "return JSON.stringify({found:true,head:h,rows:rows});})()";
  const raw = await new Promise((resolve) => {
    const ws = new WebSocketImpl(page.webSocketDebuggerUrl || (CDP.replace('http', 'ws') + '/devtools/page/' + page.id));
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(null); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (m.id === 1) { clearTimeout(t); resolve(m.result && m.result.result ? m.result.result.value : null); try { ws.close(); } catch (e) {} }
      } catch (e) {}
    };
    ws.onerror = () => { clearTimeout(t); resolve(null); };
  });
  if (!raw) return { error: 'eval_failed' };
  let parsed; try { parsed = JSON.parse(raw); } catch (e) { return { error: 'bad_payload' }; }
  if (!parsed.found) return { error: 'orders_table_unmounted' };
  const head = parsed.head.map(s => s.toLowerCase());
  const iSide = head.indexOf('side'), iQty = head.indexOf('qty'), iStatus = head.indexOf('status'), iSym = head.indexOf('symbol');
  if (iSide < 0 || iQty < 0 || iStatus < 0) return { error: 'orders_shape_unknown', head: parsed.head };
  let net = 0, working = 0, filled = 0, sym = null;
  for (const r of parsed.rows) {
    const status = (r[iStatus] || '').toLowerCase();
    const side = (r[iSide] || '').toLowerCase();
    const qty = parseFloat(String(r[iQty] || '0').replace(/,/g, '')) || 0;
    if (iSym >= 0 && r[iSym]) sym = r[iSym];
    if (status === 'working') working++;
    if (status !== 'filled') continue;
    filled++;
    if (side.includes('buy')) net += qty; else if (side.includes('sell')) net -= qty;
  }
  return { netQty: net, filledOrders: filled, workingOrders: working, symbol: sym };
}

// ---- app truth: what the running app believes ----
async function appView(force) {
  return await new Promise((resolve) => {
    const seen = { positions: null, summaryProfit: null, guardBlind: null, perTradeLevel: null, selfTest: null, positionEvent: null };
    const ws = new WebSocketImpl(APP);
    const done = () => { try { ws.close(); } catch (e) {} resolve(seen); };
    const t = setTimeout(done, 9000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'tv-broker-check-now', reqId: 1 })); } catch (e) {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
      if (m.type === 'tv-broker-account') {
        if (m.positions) seen.positions = { success: m.positions.success, visible: m.positions.visible, count: m.positions.count, empty: m.positions.empty, emptyStateText: m.positions.emptyStateText };
        if (m.summary && m.summary.header) seen.summaryProfit = m.summary.header.profit;
      }
      if (m.type === 'oversize-guard-status' && m.status) seen.guardBlind = m.status.blind;
      if (m.type === 'per-trade-stop') seen.perTradeLevel = m.level;
      if (m.type === 'live-feed-self-test') seen.selfTest = (m.passed || 0) + '/' + (m.total || 0);
      if (m.type === 'position-event') seen.positionEvent = (m.events || []).map(e => e.text).join('; ');
      if (seen.positions && seen.guardBlind !== null) { clearTimeout(t); done(); }
    };
    ws.onerror = () => { clearTimeout(t); done(); };
    ws.onclose = () => { clearTimeout(t); done(); };
  });
}

const money = (s) => { const n = parseFloat(String(s || '0').replace(/[^0-9.+-]/g, '')); return isNaN(n) ? 0 : n; };

(async () => {
  log({ event: 'watcher_start', interval_ms: INTERVAL, max_minutes: MAX_MINUTES, log: LOG });
  const deadline = Date.now() + MAX_MINUTES * 60000;
  let cycle = 0;
  let lastVerdict = null;
  while (Date.now() < deadline) {
    cycle++;
    const b = await brokerNetQty();
    const a = await appView(true);
    const appCount = a.positions ? a.positions.count : null;
    const profit = money(a.summaryProfit);
    const expectsPosition = (typeof b.netQty === 'number' && b.netQty !== 0) || Math.abs(profit) > 0.001;
    const appSaysFlat = appCount === 0;
    const guardBlind = a.guardBlind === true || a.perTradeLevel === 'blind';
    let verdict = 'consistent';
    if (b.error && appCount === null) verdict = 'unknown_both_sides_down';
    else if (expectsPosition && appSaysFlat) verdict = 'BLIND_app_flat_while_position_open';
    else if (guardBlind) verdict = 'BLIND_guard_reports_unreadable';
    else if (expectsPosition && appCount && appCount > 0) verdict = 'ok_app_sees_position';
    else if (!expectsPosition && appSaysFlat) verdict = 'ok_flat';

    if (verdict !== lastVerdict || verdict.startsWith('BLIND')) {
      log({ event: verdict.startsWith('BLIND') ? 'blind_detected' : 'verdict', cycle, verdict, broker: b, app: { count: appCount, profit: a.summaryProfit, guardBlind: a.guardBlind, perTradeLevel: a.perTradeLevel, selfTest: a.selfTest }, positionEvent: a.positionEvent });
    }
    if (verdict.startsWith('BLIND')) {
      // auto-recovery: force another read straight away, then re-check
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 2500));
        const a2 = await appView(true);
        const c2 = a2.positions ? a2.positions.count : null;
        log({ event: 'auto_recovery_attempt', cycle, attempt, appCountAfter: c2, guardBlindAfter: a2.guardBlind, profitAfter: a2.summaryProfit });
        if (c2 && c2 > 0) { log({ event: 'auto_recovery_ok', cycle, attempt }); break; }
        if (attempt === 3) log({ event: 'auto_recovery_FAILED', cycle, note: 'still blind after 3 forced reads' });
      }
    }
    lastVerdict = verdict;
    await new Promise(r => setTimeout(r, INTERVAL));
  }
  log({ event: 'watcher_stop', reason: 'max_minutes reached', cycles: cycle });
})();
