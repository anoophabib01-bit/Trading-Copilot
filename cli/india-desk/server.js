'use strict';
// ── server.js — India Desk HTTP server (I1.2) ──────────────────────────────
// Plain node:http, GET-only, bound to 127.0.0.1. Port from INDIA_PORT (default
// 7434; 7433 is the co-pilot). There is NO write path and there must not be one.
// No WebSocket, no coupling to the co-pilot's bus, no code path into app/.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const nse = require('./nse');

const PORT = Number(process.env.INDIA_PORT) || 7434;
const HOST = '127.0.0.1';
const CACHE_MS = 60 * 1000;

let cache = { at: 0, payload: null };

async function buildPayload() {
  const now = Date.now();
  const [market, movers, drivers, cold] = await Promise.all([
    nse.getMarketStatus(),
    nse.getMovers(20),
    nse.getIndexDrivers('NIFTY 50'),
    nse.getColdSignals(),
  ]);
  const ist = new Date(now + 5.5 * 3600000);
  const istStr = String(ist.getUTCFullYear()) + '-' + String(ist.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(ist.getUTCDate()).padStart(2, '0') + ' ' + String(ist.getUTCHours()).padStart(2, '0') + ':'
    + String(ist.getUTCMinutes()).padStart(2, '0') + ':' + String(ist.getUTCSeconds()).padStart(2, '0') + ' IST';
  const errors = [market, movers, drivers, cold].filter((x) => !x.ok).map((x) => x.error);
  return {
    ok: true,
    builtAt: now,
    istNow: istStr,
    isOpen: nse.isNseOpen(now),
    syncedSessions: nse.readSyncedSessions(),
    market: market.ok ? market.data : null,
    movers: movers.ok ? movers.data : [],
    indexDrivers: drivers.ok ? drivers.data : [],
    coldSignals: cold.ok ? cold.data : null,
    errors,
  };
}

async function getPayload() {
  if (cache.payload && Date.now() - cache.at < CACHE_MS) return cache.payload;
  const payload = await buildPayload();
  cache = { at: Date.now(), payload };
  return payload;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Reject every non-GET first: there is no write path in this feature.
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
    res.end('405 Method Not Allowed\n');
    return;
  }
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/desk') {
    try {
      const payload = await getPayload();
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
    } catch (e) {
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      send(res, 200, 'text/html; charset=utf-8', html);
    } catch (e) {
      send(res, 500, 'text/plain', 'index.html missing: ' + e.message + '\n');
    }
    return;
  }
  send(res, 404, 'text/plain', '404 Not Found\n');
});

server.listen(PORT, HOST, () => {
  console.log('[india-desk] listening on http://' + HOST + ':' + PORT);
});
