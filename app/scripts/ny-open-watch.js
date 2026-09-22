/**
 * ny-open-watch.js — sample MNQ through Anoop's NY session, READ-ONLY.
 *
 * He asked for an observation, not a trade: "watch the new york open and until 9 or 10 pm
 * today so that you understand in points and dollars with 4size or 3 size and 2 size for use
 * to make profit and also understand what are the possibility to gain profits. just observe
 * do not trade any trade entries until i do".
 *
 * It calls ONLY quote_get and trading_get_account_summary through the app's own bridge. It has
 * no order path at all — there is nothing in this file that could place, modify or cancel
 * anything, which is the point: an observation tool that cannot accidentally trade.
 *
 * Writes one JSON line per sample to DATA/ny-watch-<date>.jsonl, so the analysis at the end is
 * built from sampled reality rather than recollection.
 */
'use strict';
const fs = require('fs');
const ARG = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const INTERVAL_MS = parseInt(ARG('interval', '20'), 10) * 1000;
const MINUTES = parseInt(ARG('minutes', '220'), 10);
const APP = ARG('app', 'ws://127.0.0.1:7433');
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const stamp = () => ist().toISOString().replace('T', ' ').slice(0, 19);
const path = 'G:/Trading-CoPilot/DATA/ny-watch-' + ist().toISOString().slice(0, 10) + '.jsonl';

function call(name, args, timeoutMs) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(APP); } catch (e) { return resolve({ error: 'ws construct: ' + e.message }); }
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ error: 'timeout' }); }, timeoutMs || 15000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'mcp-call', name, args: args || {}, reqId: 1 })); } catch (e) {} };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (m.type === 'mcp-result' && m.reqId === 1) {
          clearTimeout(t); try { ws.close(); } catch (e) {}
          let payload = null;
          try { payload = JSON.parse(m.result.content[0].text); } catch (e) { payload = null; }
          resolve(payload || { error: 'unparseable', raw: JSON.stringify(m).slice(0, 200) });
        }
      } catch (e) {}
    };
    ws.onerror = () => { clearTimeout(t); resolve({ error: 'ws error' }); };
  });
}

function write(obj) {
  const line = JSON.stringify(Object.assign({ at: stamp() }, obj));
  try { fs.appendFileSync(path, line + '\n'); } catch (e) {}
  console.log(line);
}

(async () => {
  write({ event: 'watch_start', interval_s: INTERVAL_MS / 1000, minutes: MINUTES, file: path });
  const deadline = Date.now() + MINUTES * 60000;
  let n = 0;
  while (Date.now() < deadline) {
    const q = await call('quote_get', {});
    // quote_get returns {open, high, low, close} — `close` is the live print (verified 2026-09-15);
    // lastPrice/price are kept as fallbacks so a future shape change degrades instead of nulling.
    const cand = q ? [q.close, q.lastPrice, q.price, q.last] : [];
    let price = null;
    for (const c of cand) { const n = Number(c); if (Number.isFinite(n) && n > 0) { price = n; break; } }
    write({ event: 'tick', n: ++n, price, symbol: (q && (q.symbol || q.ticker)) || null, err: price == null ? JSON.stringify(q).slice(0, 120) : null });
    if (n % 15 === 0) {
      const a = await call('trading_get_account_summary', {});
      const hdr = a && a.header ? a.header : null;
      write({ event: 'account', balance: (hdr && hdr.balance) || null, equity: (hdr && hdr.equity) || null });
      const p = await call('trading_get_positions', {});
      write({ event: 'position', count: (p && p.count) || 0 });
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  write({ event: 'watch_stop', ticks: n });
})();