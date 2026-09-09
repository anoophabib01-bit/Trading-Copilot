'use strict';
// ── nse.js — the India Desk adapter ────────────────────────────────────────
// Pure-ish: calls cli/market-cli.js (the single spawn point), returns normalised
// objects. NO HTTP, NO HTML, NO rendering. Every function returns { ok, data,
// error } and never throws — callers branch on .ok.
//
// FIREWALL DOCTRINE (machine-checked by cli/test/india-firewall.test.js):
// nothing in this directory may import into the MNQ app/ tree, join its order
// flow, or open a WebSocket to its bus. India data is a research surface only.
// It may BLOCK a decision or ANNOTATE a record; it may NEVER permit one.

const path = require('node:path');
const fs = require('node:fs');
const marketCli = require('../market-cli');

const NAME = 'nse-india';

// Relocated store — everything the CLI reads and writes lands under
// cli/state/nse-india/. The NSE CLI hardcodes ~/.local/share/nse-india-pp-cli for
// its SQLite db and IGNORES the wrapper's XDG/<NAME>_HOME env, so every
// local-store command passes --db explicitly. Sync writes this db; the readers
// below read the SAME db, otherwise the cold signals could never warm up.
const STATE_DIR = path.join(__dirname, '..', 'state', 'nse-india');
const DB_PATH = path.join(STATE_DIR, 'data.db');
const SYNC_LOG = path.join(STATE_DIR, 'sync-log.jsonl');

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// NSE cash session: 09:15–15:30 IST, Mon–Fri. Deterministic — derived from the
// clock, NOT from the CLI's (lagging) "status" field. A page that shows a stale
// close as if it were live is the failure this whole exercise is meant to avoid.
function isNseOpen(ms) {
  if (!Number.isFinite(ms)) ms = Date.now();
  const ist = new Date(ms + 5.5 * 3600000);
  const wd = ist.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

async function getMarketStatus() {
  try {
    const r = await marketCli.run(NAME, ['market']);
    if (!r.ok) return { ok: false, data: null, error: r.error || 'market failed' };
    const d = r.data || {};
    const nifty = d.indicativenifty50 || {};
    const gift = d.giftnifty || {};
    const cap = d.marketcap || {};
    let usdInr = null;
    const segs = Array.isArray(d.marketState) ? d.marketState : [];
    const fx = segs.find((s) => s && (s.underlying === 'USDINR' || s.market === 'currencyfuture'));
    if (fx) usdInr = toNum(fx.last);
    return {
      ok: true,
      data: {
        niftyLast: toNum(nifty.finalClosingValue != null ? nifty.finalClosingValue : nifty.closingValue),
        niftyChange: toNum(nifty.change),
        niftyPctChange: toNum(nifty.perChange),
        status: nifty.status || null,
        giftNifty: {
          last: toNum(gift.LASTPRICE),
          pctChange: toNum(gift.PERCHANGE),
          timestamp: gift.TIMESTMP || null,
        },
        usdInr,
        marketCapCr: toNum(cap.marketCapinCRRupees),
        marketCapTrUsd: toNum(cap.marketCapinTRDollars),
        asOf: nifty.dateTime || null,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

async function getMovers(limit = 20) {
  try {
    const r = await marketCli.run(NAME, ['movers']);
    if (!r.ok) return { ok: false, data: null, error: r.error || 'movers failed' };
    const rows = (Array.isArray(r.data) ? r.data : []).slice(0, limit);
    const out = rows.map((m) => ({
      symbol: m.symbol || m.identifier || null,
      identifier: m.identifier || null,
      lastPrice: toNum(m.lastPrice),
      pChange: toNum(m.pChange),
      totalTradedValue: toNum(m.totalTradedValue),
      dayHigh: toNum(m.dayHigh),
      dayLow: toNum(m.dayLow),
      yearHigh: toNum(m.yearHigh),
      yearLow: toNum(m.yearLow),
    }));
    return { ok: true, data: out, error: null };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

async function getIndexDrivers(index = 'NIFTY 50') {
  try {
    const r = await marketCli.run(NAME, ['index-driver', '--index', index, '--db', DB_PATH]);
    if (!r.ok) return { ok: false, data: null, error: r.error || 'index-driver failed' };
    const rows = Array.isArray(r.data) ? r.data : [];
    return { ok: true, data: rows, error: null };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

// The single most important line in the adapter: an EMPTY result at exit 0 is
// 'cold' (no synced history yet), never an empty 'ready'. An unsynced store and
// a calm market produce identical output, and collapsing them is exactly the
// bug that made prediction-goat look healthy while returning nothing.
function coldState(r) {
  if (!r.ok) return 'error';
  if (r.empty) return 'cold';
  return 'ready';
}

function coldBucket(r) {
  const state = coldState(r);
  const rows = (state === 'ready' && Array.isArray(r.data)) ? r.data : [];
  return { state, rows, error: r.error || null };
}

async function getColdSignals() {
  try {
    const ds = await marketCli.run(NAME, ['delivery-spike', '--db', DB_PATH]);
    const dd = await marketCli.run(NAME, ['delivery-divergence', '--db', DB_PATH]);
    const sb = await marketCli.run(NAME, ['sector-breadth', '--db', DB_PATH]);
    return {
      ok: true,
      data: {
        deliverySpike: coldBucket(ds),
        deliveryDivergence: coldBucket(dd),
        sectorBreadth: coldBucket(sb),
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

// How many successful syncs so far — the "currently N" in the cold panel.
function readSyncedSessions() {
  let n = 0;
  try {
    if (fs.existsSync(SYNC_LOG)) {
      const text = fs.readFileSync(SYNC_LOG, 'utf8').replace(new RegExp(CR, 'g'), '');
      for (const line of text.split(NL)) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o && o.ok === true) n++; } catch {}
      }
    }
  } catch { /* return 0 */ }
  return n;
}

module.exports = {
  getMarketStatus, getMovers, getIndexDrivers, getColdSignals,
  isNseOpen, readSyncedSessions,
  NAME, STATE_DIR, DB_PATH, SYNC_LOG,
  _internals: { toNum, coldState, coldBucket },
};
