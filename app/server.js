'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const mcpBridge = require('./mcp-bridge');
const claudeAgent = require('./claude-agent');
const groqAgent = require('./groq-agent');
const edgeTts = require('./edge-tts');
const localTts = require('./local-tts'); // offline Windows SAPI fallback (2026-07-28)
const sessionMgr = require('./session-manager');
const telegramBot = require('./telegram-bot');
const booksIndex = require('./books-index');
const tradovate = require('./tradovate');

const PORT = 7433;
const CONFIG_PATH = path.join(require('os').homedir(), '.mnq-copilot-config.json');

// ── Crash guards (2026-07-25 robustness pass) ─────────────────────────────────
// This process runs Anoop's entire co-pilot: WS server, engulf/FVG/SFP
// monitors, Jessi, Telegram bridge, TradingView bridge. Before this, ONE
// unhandled rejection anywhere (a monitor's MCP call racing a dropped
// connection, a flaky TTS socket) could kill the whole process mid-session —
// the worst possible time. Log loudly, keep running. Deliberately NOT
// swallowing errors silently: everything prints with a stack for the log.
process.on('uncaughtException', (err) => {
  console.error('[CRASH-GUARD] uncaughtException (process kept alive):', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH-GUARD] unhandledRejection (process kept alive):', reason && reason.stack || reason);
});

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Server state ───────────────────────────────────────────────────────────────
let currentMode = loadConfig().mode || 'funded'; // 'eval' | 'funded'

// ── Rules (single source of truth: rules.json in project root) ─────────────────
const RULES_PATH = path.join(__dirname, 'rules.json');
const DEFAULT_RULES = {
  sizeCap: 6,
  tradeLimit: { eval: 2, funded: 20 },
  tradesPerSession: 5,
  tradesPerDay: 10,
  qualifyingTradeMinAbsPnl: 100,
  scorerTradesPerDayLimit: 10,
  dailyLossTiers: { yellow: -250, red: -350, hard: -500 },
  dayStop: { eval: 300, funded: 200 },
  cooldownMinutes: 15,
  sessionWindowsIST: [
    { name: 'London', startMin: 810, endMin: 900 },
    { name: 'NY', startMin: 1140, endMin: 1260 }
  ],
  oneInstrumentPerDay: true,
  commissionPerContractPerSide: 0.59,
  giveback: { armAtProfit: 400, retracePct: 50 },
  perTradeMaxLoss: 200
};
const SCALPER_DEFAULTS = {
  sizeCap: 4,
  tradesPerSession: 8,
  tradesPerDay: 15,
  dailyLossTiers: { yellow: -200, red: -300, hard: -400 },
  cooldownAfterLossOnly: true,
  maxHoldSeconds: 1800,
  scorerTradesPerDayLimit: 15
};
function loadRules() {
  try { return Object.assign({}, DEFAULT_RULES, JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_RULES); }
}
/** Return the effective ruleset for the active trading mode.
 *  In 'scalper' mode, scalperRules overlay the standard rules.
 *  In 'standard' mode (default), returns raw rules unchanged. */
function getActiveRules() {
  const raw = loadRules();
  const mode = raw.tradingMode || 'standard';
  if (mode !== 'scalper') return raw;
  // Merge scalper overrides onto base rules (scalperRules block wins)
  const scalper = Object.assign({}, SCALPER_DEFAULTS, raw.scalperRules || {});
  const merged = Object.assign({}, raw, scalper);
  // Keep the full scalperRules block and mode marker in the output
  merged.tradingMode = 'scalper';
  merged.scalperRules = raw.scalperRules || SCALPER_DEFAULTS;
  return merged;
}
function saveRules(rules) {
  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

// ── Local data persistence ────────────────────────────────────────────────────
// 2026-07-25 (Anoop: "D:\co-pilot DATA — save data of all the account here…
// treat every new account as a separate dataset"):
//
// LAYOUT ON DISK
//   D:\co-pilot DATA\
//     accounts\<slotId>\            ← one folder per account, fully isolated
//        meta.json                  ← name, size, stage, status, opened/closed
//        gr_history.json            ← per-day discipline summaries
//        balance_ledger.json        ← per-day net (drives balance + floor)
//        day_trades.json            ← per-trade detail
//        pb_tags.json, maemfe.json, loop_state.json, eval_milestones.json
//        daily\<YYYY-MM-DD>.json    ← immutable End-Day snapshot
//        CLOSED_breached.json / CLOSED_cleared.json  ← final account record
//     account_fees.json             ← LIFETIME spend/payouts (all accounts)
//     account_archives.json         ← LIFETIME breach/clear archive
//     trade_journal.json            ← LIFETIME journal (about Anoop, not an account)
//
// A key containing '__<slotId>' is routed into that account's folder; anything
// else stays at the root as a lifetime record. Falls back to the old in-project
// data/ folder if the configured drive isn't writable, so the app never dies
// just because an external path is missing.
const DEFAULT_DATA_DIR = 'G:\\MNQ-CoPilot\\DATA';
const FALLBACK_DATA_DIR = path.join(__dirname, 'data');
let DATA_DIR = FALLBACK_DATA_DIR;
// LIFETIME files (account_fees, account_archives, trade_journal) must never
// silently reset just because DATA_DIR resolves differently between runs
// (e.g. D:\co-pilot DATA becomes writable when it previously wasn't, or vice
// versa). BUG FOUND 2026-07-28: exactly this happened — DATA_DIR pointed to
// D:\co-pilot DATA which had no account_fees.json, so the Cost tab silently
// started from an empty ledger while the real 16-account/$840.50 file sat
// untouched at the in-project fallback path. Anoop only caught it because he
// happened to compare against an old screenshot. Fix: on every startup, if
// the active DATA_DIR's copy of a lifetime file is missing or empty while the
// fallback has real data, pull the fallback in — never overwrite a populated
// destination, only fill an empty/missing one.
const GLOBAL_LIFETIME_KEYS = ['account_fees', 'account_archives', 'trade_journal'];
function fileHasData(fp) {
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!d || typeof d !== 'object') return false;
    return Object.keys(d).some(k => Array.isArray(d[k]) && d[k].length > 0);
  } catch { return false; }
}
function migrateLifetimeFiles() {
  if (DATA_DIR === FALLBACK_DATA_DIR) return;
  GLOBAL_LIFETIME_KEYS.forEach(key => {
    const dest = path.join(DATA_DIR, key + '.json');
    const src = path.join(FALLBACK_DATA_DIR, key + '.json');
    try {
      if (!fs.existsSync(src) || !fileHasData(src)) return;
      const destEmpty = !fs.existsSync(dest) || !fileHasData(dest);
      if (destEmpty) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`✓ Recovered lifetime file "${key}.json" — was empty/missing at ${DATA_DIR}, pulled real data from fallback ${FALLBACK_DATA_DIR}`);
      }
    } catch (e) {
      console.error(`Lifetime file migration failed for ${key}:`, e.message);
    }
  });
}
function initDataDir() {
  const wanted = (loadConfig().dataDir || DEFAULT_DATA_DIR);
  try {
    fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    DATA_DIR = wanted;
  } catch (e) {
    DATA_DIR = FALLBACK_DATA_DIR;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    console.log(`⚠  Could not use "${wanted}" (${e.code || e.message}) — falling back to ${DATA_DIR}`);
  }
  console.log('✓ Data directory: ' + DATA_DIR);
  migrateLifetimeFiles();
  return DATA_DIR;
}
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function safeDataKey(key) {
  return /^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-]+)?$/.test(String(key || ''));
}
// Route 'gr_history__s2' → accounts/s2/gr_history.json ; leave others at root.
function dataPathFor(key) {
  const m = String(key).match(/^([a-zA-Z0-9_\-]+)__([a-zA-Z0-9_\-]+)$/);
  if (m) return path.join(DATA_DIR, 'accounts', m[2], m[1] + '.json');
  return path.join(DATA_DIR, key + '.json');
}
function dataSave(key, payload) {
  if (!safeDataKey(key)) return false;
  ensureDataDir();
  try {
    const fp = dataPathFor(key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('dataSave failed for', key, e.message); return false; }
}
// ── Review archive (2026-07-31) ──────────────────────────────────────────────
// Anoop asked whether a better/paid model would improve the agents. The honest
// answer was: unknowable, because NOTHING the Judge or the Post-Session Analyst
// ever said was persisted anywhere. Every verdict evaporated when the chat
// cleared — so he could not review last week's advice, could not check whether
// he was warned before the 2026-07-21 eval breach, and could not judge whether
// the agents are worth anything at all. An advisor with amnesia isn't an
// advisor. This appends every Judge verdict and Post-Session review to
// data/reviews/YYYY-MM-DD.json so there is a permanent, readable record.
//
// Deliberately append-only and failure-tolerant: a write problem here must
// NEVER break the live chat response the user is waiting on, so every call is
// wrapped and errors are logged rather than thrown.
function reviewsPathFor(dateStr) {
  return path.join(DATA_DIR, 'reviews', dateStr + '.json');
}

// Trading-day stamp, NOT calendar date — mirrors renderer/app.js csvParseTrades
// (ROLLOVER_MIN 03:45 IST, the CME Globex maintenance break). A verdict given
// at 00:40 IST belongs to the session that started the previous evening, and
// filing it under the next calendar day would scatter one session's record
// across two files.
function tradingDayStampIST(nowMs) {
  const IST_OFF = 330 * 60 * 1000;
  const ist = new Date((nowMs != null ? nowMs : Date.now()) + IST_OFF);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 3 * 60 + 45) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

function saveReviewRecord(kind, fullText, extra) {
  try {
    if (!fullText || !String(fullText).trim()) return false;
    const now = Date.now();
    const day = tradingDayStampIST(now);
    const fp = reviewsPathFor(day);
    fs.mkdirSync(path.dirname(fp), { recursive: true });

    let arr = [];
    try { const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (Array.isArray(j)) arr = j; } catch {}

    let slot = null;
    try { slot = jessiBucketKey(loadConfig() || {}); } catch {}

    arr.push({
      kind,                                  // 'judge' | 'post-session'
      ts: new Date(now).toISOString(),
      istTime: new Date(now).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      tradingDay: day,
      slot,
      ...(extra || {}),
      text: String(fullText)
    });

    fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
    console.log(`[reviews] saved ${kind} → data/reviews/${day}.json (${arr.length} entries that day)`);
    return true;
  } catch (e) {
    console.error('[reviews] save failed:', e.message);
    return false;
  }
}

// Read back the most recent N review records across all days, newest first.
function loadRecentReviews(limit, kindFilter) {
  const out = [];
  try {
    const dir = path.join(DATA_DIR, 'reviews');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
      let arr = [];
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (Array.isArray(j)) arr = j; } catch { continue; }
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if (kindFilter && r.kind !== kindFilter) continue;
        out.push(r);
        if (out.length >= (limit || 20)) return out;
      }
    }
  } catch (e) { /* no reviews dir yet — not an error */ }
  return out;
}

function dataLoad(key) {
  if (!safeDataKey(key)) return null;
  try { return JSON.parse(fs.readFileSync(dataPathFor(key), 'utf8')); }
  catch { return null; }
}
// Wipe one account's whole folder — used by "Start fresh" so no layer survives.
function dataWipeAccount(slotId) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return false;
  try {
    fs.rmSync(path.join(DATA_DIR, 'accounts', slotId), { recursive: true, force: true });
    return true;
  } catch (e) { console.error('dataWipeAccount failed:', e.message); return false; }
}
// ── Per-account chart screenshots (2026-07-25) ────────────────────────────────
// Anoop: "can i add screenshot of the data which i trade and be saved in same
// account i add to?" — yes: accounts/<slotId>/screenshots/<date>__<ts>.png
// Stored as real image files (not base64 in JSON) so the folder stays browsable
// in Explorer and the JSON files stay small.
const SHOT_EXT_OK = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function shotDir(slotId) { return path.join(DATA_DIR, 'accounts', String(slotId), 'screenshots'); }
function shotSave(slotId, dateStr, base64, ext) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const e = String(ext || 'png').toLowerCase().replace('.', '');
  if (!SHOT_EXT_OK[e]) return null;
  try {
    const dir = shotDir(slotId);
    fs.mkdirSync(dir, { recursive: true });
    // BUG FIX (caught in test): Date.now() alone collided when two images were
    // attached in the same millisecond — the second silently overwrote the
    // first. Add a short random suffix so every attachment is its own file.
    const name = `${dateStr}__${Date.now()}${Math.random().toString(36).slice(2, 6)}.${e}`;
    const raw = String(base64 || '').replace(/^data:[^,]+,/, '');
    fs.writeFileSync(path.join(dir, name), Buffer.from(raw, 'base64'));
    return name;
  } catch (err) { console.error('shotSave failed:', err.message); return null; }
}
function shotList(slotId, dateStr) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return [];
  try {
    return fs.readdirSync(shotDir(slotId))
      .filter(f => !dateStr || f.indexOf(dateStr + '__') === 0)
      .sort();
  } catch { return []; }
}
function shotRead(slotId, file) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return null;
  if (!/^[\w\-]+\.(png|jpe?g|webp)$/i.test(String(file || ''))) return null; // no traversal
  try {
    const e = String(file).split('.').pop().toLowerCase();
    const buf = fs.readFileSync(path.join(shotDir(slotId), file));
    return `data:${SHOT_EXT_OK[e] || 'image/png'};base64,` + buf.toString('base64');
  } catch { return null; }
}

// End-Day snapshot: immutable dated record inside the account's folder.
function dataEndDay(slotId, dateStr, payload) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  try {
    const fp = path.join(DATA_DIR, 'accounts', slotId, 'daily', dateStr + '.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf8');
    return fp;
  } catch (e) { console.error('dataEndDay failed:', e.message); return false; }
}

// ── PDF text extraction (for Analyze CSV → PDF uploads) ────────────────────────
// Lazy-required so a broken/missing pdf-parse install doesn't crash the whole
// server on boot — it only matters at the moment a PDF is actually uploaded.
//
// FIX (2026-07-21, "DOMMatrix is not defined" on Anoop's real machine): pdf-parse
// pulls in pdfjs-dist, which prefers @napi-rs/canvas for its DOMMatrix/Path2D/
// ImageData support — but @napi-rs/canvas ships one native binary PER PLATFORM
// as separate optional npm packages, and `npm install` only fully installs the
// one matching whatever machine ran the install. This dependency got installed
// from this session's Linux sandbox (a live-mounted shared folder, not Anoop's
// real machine), so node_modules ended up with a real Linux binary and an
// EMPTY placeholder folder for @napi-rs/canvas-win32-x64-msvc — confirmed by
// directly inspecting both folders (30MB vs 0 bytes, no package.json in the
// Windows one). On Anoop's Windows machine that native module fails to load,
// pdfjs-dist has no canvas backend, and it crashes referencing a bare global
// DOMMatrix that only exists in browsers, not plain Node.
// Fix: polyfill DOMMatrix from the pure-JS `dommatrix` package (no native
// binary, so no per-platform build problem) before pdf-parse/pdfjs-dist ever
// looks for it. This doesn't depend on @napi-rs/canvas resolving correctly on
// whatever machine this actually runs on.
async function extractPdfText(base64) {
  if (!base64) throw new Error('No PDF data received');
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = require('dommatrix');
  }
  const { PDFParse } = require('pdf-parse');
  const buf = Buffer.from(base64, 'base64');
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  return result.text || '';
}

// ── MIME types ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ── HTTP server ────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  url = url.split('?')[0];
  const filePath = path.join(__dirname, 'renderer', url);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const ext = path.extname(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'text/plain');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('Client connected');

  const cfg = loadConfig();
  send(ws, { type: 'config', data: cfg });
  send(ws, { type: 'mcp-status', connected: mcpBridge.ready && mcpBridge.tvConnected });
  send(ws, { type: 'mode-update', mode: currentMode });
  for (const key of Object.keys(engulfMonitors)) {
    send(ws, { type: 'engulf-monitor-status', tf: key, running: engulfMonitors[key].running });
  }
  for (const key of Object.keys(fvgMonitors)) {
    send(ws, { type: 'fvg-monitor-status', tf: key, running: fvgMonitors[key].running });
  }
  for (const key of Object.keys(sfpMonitors)) {
    send(ws, { type: 'sfp-monitor-status', tf: key, running: sfpMonitors[key].running });
  }
  send(ws, { type: 'po3-monitor-status', running: po3Monitor.running });
  send(ws, { type: 'news-status', ...computeNewsStatus() });
  send(ws, { type: 'tradovate-account', ...(tradovate.lastSnapshot() || {}) });
  send(ws, { type: 'rules', data: getActiveRules() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'config-set':       handleConfigSet(ws, msg);   break;
      case 'chat-send':        handleChat(ws, msg);        break;
      case 'jessi-chat-send':  handleJessiChat(ws, msg);   break;
      case 'debate-chat-send': handleDebateChat(ws, msg);  break;
      case 'post-session-review': handlePostSessionReview(ws, msg); break;
      case 'scalper-chat-send': handleScalperChat(ws, msg); break;
      case 'tts-speak':        handleTtsSpeak(ws, msg);   break;
      case 'ict-po3':          handleIctPo3(ws, msg);     break;
      case 'po3-monitor-toggle':
        msg.enabled ? startPo3Monitor() : stopPo3Monitor();
        break;
      case 'po3-check-now': checkPo3Phase(); break;
      // Diagnostic: reports which TTS engines actually work on this machine.
      // Added 2026-07-28 so a voice failure can be identified in one step
      // instead of guessed at. Run from the browser console:
      //   window.api.ttsDiagnose().then(console.log)
      case 'tts-diagnose': {
        (async () => {
          const out = { platform: process.platform, edge: null, local: null, localVoices: [] };
          try {
            const c = await edgeTts.synthesizeClips('test', edgeTts.DEFAULT_VOICE);
            out.edge = 'OK (' + (c && c.length) + ' clip)';
          } catch (e) { out.edge = 'FAIL: ' + e.message; }
          try {
            if (!localTts.isAvailable()) out.local = 'unavailable (not Windows)';
            else {
              const c = await localTts.synthesizeClips('test');
              out.local = 'OK (' + (c && c.length) + ' clip, ' + (c[0] ? c[0].length : 0) + ' b64 chars)';
            }
          } catch (e) { out.local = 'FAIL: ' + e.message; }
          try { out.localVoices = await localTts.listVoices(); } catch (e) {}
          send(ws, { type: 'tts-diagnose-result', reqId: msg.reqId, ...out });
        })();
        break;
      }
      case 'jessi-voice-send': handleJessiVoiceSend(ws, msg); break;
      case 'jessi-app-action-result': {
        const p = pendingAppActions.get(msg.actionId);
        if (p) { pendingAppActions.delete(msg.actionId); p.resolve(msg.result || (msg.ok ? 'Done.' : 'Action failed.')); }
        break;
      }
      case 'journal-add':      handleJournalAdd(ws, msg);  break;
      // 2026-07-25: per-account dataset management (D:\co-pilot DATA)
      case 'data-wipe-account':
        send(ws, { type: 'data-wiped', reqId: msg.reqId, ok: dataWipeAccount(msg.slotId) });
        break;
      case 'data-end-day': {
        const fp = dataEndDay(msg.slotId, msg.date, msg.payload || {});
        send(ws, { type: 'data-end-day-saved', reqId: msg.reqId, ok: !!fp, path: fp || null });
        break;
      }
      case 'data-dir-get':
        send(ws, { type: 'data-dir', reqId: msg.reqId, dir: DATA_DIR, isFallback: DATA_DIR === FALLBACK_DATA_DIR, wanted: (loadConfig().dataDir || DEFAULT_DATA_DIR) });
        break;
      // Per-account daily note (Daily Journal) — accounts/<slot>/notes.json
      case 'note-save': {
        const notes = dataLoad('notes__' + msg.slotId) || {};
        notes[msg.date] = msg.note || {};
        send(ws, { type: 'note-saved', reqId: msg.reqId, ok: dataSave('notes__' + msg.slotId, notes) });
        break;
      }
      // Chart screenshot for a given day, stored inside that account's folder
      case 'shot-save': {
        const r = shotSave(msg.slotId, msg.date, msg.base64, msg.ext);
        send(ws, { type: 'shot-saved', reqId: msg.reqId, ok: !!r, file: r || null });
        break;
      }
      case 'shot-list':
        send(ws, { type: 'shot-list', reqId: msg.reqId, files: shotList(msg.slotId, msg.date) });
        break;
      case 'shot-read':
        send(ws, { type: 'shot-data', reqId: msg.reqId, dataUrl: shotRead(msg.slotId, msg.file) });
        break;
      case 'mcp-call':         handleMCPCall(ws, msg);     break;
      case 'session-start':    handleSessionStart(ws, msg);break;
      case 'session-trade':    handleSessionTrade(ws, msg);break;
      case 'session-read':
        send(ws, { type: 'session-data', reqId: msg.reqId, data: sessionMgr.readSession(msg.date) });
        break;
      case 'session-list':
        send(ws, { type: 'session-list', reqId: msg.reqId, data: sessionMgr.listSessions() });
        break;
      case 'screenshot-get':   handleScreenshot(ws, msg);  break;
      case 'mcp-reconnect':    startMCP();                 break;
      case 'mode-switch':      handleModeSwitch(ws, msg);  break;
      case 'engulf-monitor-toggle': handleEngulfToggle(msg); break;
      case 'engulf-check-now': checkEngulfingSignal(msg.tf || '1h'); break;
      case 'fvg-monitor-toggle': handleFVGToggle(msg); break;
      case 'fvg-check-now': checkFVGSignal(msg.tf || '30m'); break;
      case 'sfp-monitor-toggle': handleSFPToggle(msg); break;
      case 'sfp-check-now': checkSFPSignal(msg.tf || '30m'); break;
      case 'mark-london-levels': markLondonLevels(); break;
      case 'mark-ny-levels': markNYLevels(); break;
      case 'news-refresh': refreshNewsAndBroadcast(true); break;
      case 'mark-news-times': markNewsTimesOnChart(); break;
      case 'mechanical-check': runMechanicalAnalysis(); break;
      case 'tradovate-test': handleTvTest(ws, msg); break;
      case 'tradovate-restart': startTradovate(); break;
      case 'rules-get':  send(ws, { type: 'rules', reqId: msg.reqId, data: getActiveRules() }); break;
      case 'rules-set':
        try {
          saveRules(Object.assign(loadRules(), msg.data || {}));
          broadcast({ type: 'rules', data: getActiveRules() });
        } catch (e) { send(ws, { type: 'rules-error', message: e.message }); }
        break;
      case 'trading-mode-set': {
        const mode = (msg.mode === 'scalper') ? 'scalper' : 'standard';
        const raw = loadRules();
        raw.tradingMode = mode;
        saveRules(raw);
        broadcast({ type: 'rules', data: getActiveRules() });
        broadcast({ type: 'trading-mode', mode });
        break;
      }
      case 'trading-mode-get':
        send(ws, { type: 'trading-mode', reqId: msg.reqId, mode: loadRules().tradingMode || 'standard' });
        break;
      case 'data-save':
        send(ws, { type: 'data-saved', reqId: msg.reqId, ok: dataSave(msg.key, msg.payload) });
        break;
      case 'data-load':
        send(ws, { type: 'data-loaded', reqId: msg.reqId, data: dataLoad(msg.key) });
        break;
      // Read back archived Judge verdicts / Post-Session reviews (2026-07-31).
      case 'reviews-load':
        send(ws, {
          type: 'reviews-loaded', reqId: msg.reqId,
          data: loadRecentReviews(msg.limit || 20, msg.kind || null)
        });
        break;
      case 'pdf-extract':
        extractPdfText(msg.base64)
          .then(text => send(ws, { type: 'pdf-extracted', reqId: msg.reqId, ok: true, text }))
          .catch(err => send(ws, { type: 'pdf-extracted', reqId: msg.reqId, ok: false, error: err.message }));
        break;
      default: break;
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  wss.clients.forEach(ws => send(ws, obj));
}

// ── Handler: Config ────────────────────────────────────────────────────────────
function handleConfigSet(ws, msg) {
  const cfg = loadConfig();
  cfg[msg.key] = msg.value;
  saveConfig(cfg);
  if (msg.key === 'apiKey') claudeAgent.init(msg.value);
  if (msg.key === 'groqApiKey') groqAgent.init(msg.value);
  if (msg.key === 'geminiApiKey') groqAgent.initGemini(msg.value);
  if (msg.key === 'tvEnabled') startTradovate();
  send(ws, { type: 'config-saved', key: msg.key });
}

// ── Handler: Mode switch ───────────────────────────────────────────────────────
function handleModeSwitch(ws, msg) {
  setCurrentMode(msg.mode);
}

// Shared mode-switch logic used by both the browser WS handler and the
// Telegram /mode command, so both surfaces stay in sync (same currentMode
// variable, same broadcast to all connected browser clients).
function setCurrentMode(mode) {
  currentMode = mode === 'eval' ? 'eval' : 'funded';
  const cfg = loadConfig();
  cfg.mode = currentMode;
  saveConfig(cfg);
  broadcast({ type: 'mode-update', mode: currentMode });
  console.log(`Mode switched to: ${currentMode.toUpperCase()}`);
}

// ── Handler: Chat ──────────────────────────────────────────────────────────────
async function handleChat(ws, msg) {
  const { messages, reqId } = msg;

  await claudeAgent.stream(messages, {
    mode: currentMode,
    onToken:    (text)              => send(ws, { type: 'chat-token',     reqId, text }),
    onToolStart:(name, id)          => send(ws, { type: 'chat-tool-start',reqId, name, id }),
    onToolDone: (name, id, ok, res) => send(ws, { type: 'chat-tool-done', reqId, name, id, ok, result: res }),
    onDone:     (fullText)          => send(ws, { type: 'chat-done',      reqId, fullText }),
    onError:    (errMsg)            => send(ws, { type: 'chat-error',     reqId, message: errMsg })
  });
}

// ── Jessi — Groq-backed accountability companion ────────────────────────────────
// Separate persona/backend from the main claudeAgent chat above. Jessi is meant
// to be talked to casually between setups, has read access to ingested trade
// data / checklist / insights / breach history, and can be asked about the live
// chart on demand (a lightweight regex gate below fetches one TV snapshot per
// message when it looks needed — not a standing background poll).
const JESSI_PERSONA = `You are Jessi Livermore — Anoop Habib's accountability coach and psychological companion for prop-firm trading, built into his MNQ Co-Pilot app. Named after the trader Jesse Livermore (Anoop's own spelling, not corrected).

Who you're talking to: Anoop Habib, Hubballi, Karnataka, India (IST). Trades MNQ (Micro Nasdaq) and MGC (Micro Gold) as a Lucid Trading prop-firm scalper. Lifetime losses to recover: ~$10,784.50 across blown accounts and eval fees. He has blown 16 prop accounts before this one — every single one hit its Max Loss Limit, and every post-mortem shows the same handful of failure modes (trade-count escalation, revenge clusters, inverted R:R, holding losers, multi-instrument days, giving back gains after being up). You know this history. Reference it plainly when it's relevant — don't soften it.

Your role, distinct from the main AI co-pilot in this app (which does live chart analysis and trade execution guidance): you are the person he is ANSWERABLE TO. You hold the discipline-and-psychology thread across sessions — best/worst trades, recurring patterns, what state of mind preceded good vs bad days, and whether the process (not just the P&L) held up. You are also someone he can just talk to while waiting for a setup — casual is fine, you don't have to be clinical every message. But when he describes a trade, a loss, a "one more try," or anything touching the failure modes above, you say the uncomfortable thing first, plainly, the way a coach who actually cares would — not a cheerleader.

Coaching method (paraphrased from trading psychologist Brett Steenbarger's process-driven approach — see [Justmarkets summary](https://justmarkets.com/trading-articles/forex/brett-steenbargers-key-insights-on-trading-psychology)): treat trading performance as a trainable skill, not a matter of willpower. After a trade or session, help him name specifically what he did right (so it gets repeated) and specifically what went wrong (so it gets fixed) — process review, not just a P&L verdict. The real goal is self-coaching: get him recognizing his own patterns before you have to point them out, not staying dependent on you to catch everything. Steenbarger also stresses accountability through social support — you ARE that support structure here, so don't be shy about referencing what he told a coach he'd do and then checking whether he did it.

## CURRENT MISSION (Anoop's own framing, 2026-07-25)
The main force is the 50K eval account and REPEATING THE PROCESS DAILY. Not hero days — identical, boring, rule-clean days stacked until the eval clears. Every debrief and every plan you give should be framed around that: did today match the process, and what does tomorrow's repetition look like? Overtrading is his #1 enemy (his own words) — trade count and revenge re-entries are the first two numbers you look at, every time.

Ground rules:
- Never validate a revenge re-entry, oversized "high conviction" trade, or "I'll get it back" mindset. Call it by name.
- A green day with broken process is a failure in disguise; a red day with clean process is a win. Say so explicitly when the data shows it.
- Use the DATA CONTEXT block below (real ingested numbers) rather than guessing. If something isn't in it, say you don't have that logged yet instead of inventing a number.
- Keep replies conversational-length, not essays, unless he's asking for a real breakdown.

## VARIETY — DO NOT SOUND LIKE A SCRIPT (Anoop's explicit complaint)
- Never reuse a sentence, opener, or stock phrase you've already used in the visible conversation. If you catch yourself about to repeat ("process over profit", "that's how the 6 accounts died", etc.), say it a different way or make a different point entirely.
- Anchor every coaching point to a SPECIFIC number, date, or trade from his data — "your 9 trades on 22/7 with 3 revenge re-entries" lands; generic discipline talk does not.
- Rotate your angle: sometimes lead with the data, sometimes with a question back to him, sometimes with what he did RIGHT. A coach who always opens the same way stops being heard.
- Match his register: if he's chit-chatting between setups, be a person, not a compliance officer. Save the hard tone for when the data shows a violation.

## WHAT YOU CAN DO ON THE CHART (updated 2026-07-22 — Anoop explicitly asked for this after being warned it's untested)
You have tools to READ the live TradingView chart (state, quote, key levels, OHLCV, Pine labels) and to MARK/DRAW on it (horizontal lines, boxes, text, alerts) when it genuinely helps — e.g. he asks you to mark a level he just described, or flag something you noticed. A background process also refreshes a live chart snapshot every few minutes automatically, folded into your context below, so you usually don't need to fetch it yourself unless you need something fresher or more specific.

## HARD PSYCHOLOGY RULES (JadeCap-derived, adopted 2026-07-26 — non-negotiable, not just talking points)
Anoop named JadeCap ("Trading Isn't Hard, It's Misunderstood") as mentor-level and wants these enforced, not just referenced:
1. **The pre-committed A+ cap is real, not a suggestion.** He writes his A+ setup and a trade cap (usually 1–3) before the session. If he mentions hitting that cap, tell him plainly he's done for the session — do not help him rationalize "one more." This is separate from and stricter than the 20-trade backstop.
2. **Plan-adherence is the only thing that grades the day — not P&L.** If he stayed inside his plan and closed red, that's a win, say so. If he broke his cap or took an off-plan setup and made money anyway, that's a loss regardless of the number — say that too, even though it's the harder thing to say to someone who's up money. Never let a green number talk you out of calling a broken plan what it is.
3. **The urge to keep trading right after a completed plan trade is discomfort, not opportunity.** If he describes wanting to "keep going" or "see what else is there" right after a trade finished (win or loss), name it as that specific instinct — the same wiring that makes stopping feel like slacking off — and point him back to the 15-minute break, actually away from the desk, not just idle at the chart.
4. **Watch for tool/indicator stacking as a discipline red flag, not a competence upgrade.** If he talks about adding a new indicator or confirmation source right after a loss, ask what specifically it improves — if he can't answer that concretely, call it decoration, not a tool, the same way you'd call out oversizing.
5. **Push for a short, single reason on every trade he describes — not a five-layer justification.** If he's stacking multiple confirmations to explain a trade, that's the overanalysis pattern, not more rigor. A real edge sounds boring and specific, not elaborate.

## BOOK LIBRARY (search_books tool, added 2026-07-27)
Anoop's uploaded trading library — Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp's Guide to Proprietary Trading — is searchable via search_books. Reach for it when it would actually land harder than generic coaching: e.g. Douglas on probabilistic thinking when he's chasing a loss, Schwager's interviews when he needs proof a specific discipline actually pays off. Don't cite a book every message — that's the same "sound like a script" problem the VARIETY rule above already warns about.

## HARD LINE — NEVER CROSSED, NO EXCEPTIONS
You cannot and will not place, submit, modify, or dismiss a trade order, under any framing — not as a suggestion executed on his behalf, not as a "just this once," not if he insists, not if he says he authorizes it. This is enforced at the tool level (blocked outright, the call will fail even if attempted) and you should never imply otherwise. You also cannot switch his live chart's symbol or timeframe — that's the main co-pilot chat's job, not yours, because a casual chat reply is the wrong place to disrupt whatever he's actively looking at. If he wants either of those things, tell him plainly and point him to the right place.`;

// OpenAI-style tool defs for Jessi (groq-agent.js). Read tools + draw/mark
// tools only — no chart_set_symbol/timeframe (main co-pilot chat's job) and
// no trade_* execution tools (hard-blocked in groq-agent.js regardless).
const JESSI_TV_TOOLS = [
  { type: 'function', function: { name: 'chart_get_state', description: 'Get current chart state: symbol, timeframe, indicator names/entity IDs.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'quote_get', description: 'Get real-time price snapshot: last, OHLC, volume, change%.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'market_key_levels', description: 'Aggregate all Pine lines/boxes/labels into one sorted list of key levels.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'data_get_pine_labels', description: 'Get text annotations with prices from Pine indicators.', parameters: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'data_get_ohlcv', description: 'Get price bars. Always pass summary=true unless individual bars are needed.', parameters: { type: 'object', properties: { count: { type: 'number' }, summary: { type: 'boolean' } }, required: [] } } },
  { type: 'function', function: { name: 'draw_shape', description: 'Draw on the chart: horizontal_ray (PREFERRED for marking a high/low level — anchors at point.time, the actual candle where that high/low occurred, extends rightward only, matching how Anoop marks levels himself), horizontal_line (rarely wanted — spans the ENTIRE chart both directions regardless of point.time, only use if he explicitly asks for a full-chart line), trend_line, rectangle, or text.', parameters: { type: 'object', properties: { shape: { type: 'string', enum: ['horizontal_ray', 'horizontal_line', 'trend_line', 'rectangle', 'text'] }, point: { type: 'object' }, point2: { type: 'object' }, text: { type: 'string' }, color: { type: 'string' } }, required: ['shape', 'point'] } } },
  { type: 'function', function: { name: 'draw_list', description: 'List all drawings currently on the chart.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'draw_remove_one', description: 'Remove a single drawing by its entity ID (get IDs from draw_list).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'alert_create', description: 'Create a TradingView price alert.', parameters: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' }, price: { type: 'number' }, message: { type: 'string' } }, required: ['name', 'condition', 'price'] } } },
  { type: 'function', function: { name: 'alert_list', description: 'List all active TradingView alerts.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'alert_delete', description: 'Delete a TradingView alert by ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }
];

// ── App data + action tools (added 2026-07-23) ─────────────────────────────────
// These give Jessi full read + control over the App for THE CURRENTLY OPEN
// ACCOUNT ONLY (whatever size/mode is active in the UI). Design note: the
// heavy data (cost, insights, checklist, roadmap, full history) is fetched
// ON DEMAND via app_get_data rather than dumped into every system prompt —
// that's what keeps the token-per-minute usage low enough to stay under
// Groq's free-tier rate limit. app_do routes real UI actions to the client.
const JESSI_APP_TOOLS = [
  { type: 'function', function: {
    name: 'app_get_data',
    description: 'Read live data for the account currently open in the app. Sections: "status" (balance, floor/drawdown, target, cushion, mode, size cap, today P&L, trade count, rules), "cost" (lifetime eval fees vs payouts, net position), "insights" (discipline stats, playbook tags, MAE/MFE, best/worst, recent days), "trades" (per-trade history — last 12 individual trades with side/size/entry/P&L/hold), "scalp" (per-day scalping breakdown — avg/median hold time, avg gap between trades, trade count, hold-exceeded count, active trading mode, for each of the last 10 trading days — use this whenever Anoop asks how his scalping/hold-times/gaps looked on a specific day or over recent days), "checklist" (today + recent pre-trade checklist scores/tiers and the checklist plan), "roadmap" (loop-challenge streak & focus, eval milestones, the apprenticeship plan), "all" (everything). Always call this before answering questions about the account or trade history rather than guessing.',
    parameters: { type: 'object', properties: { section: { type: 'string', enum: ['status', 'cost', 'insights', 'trades', 'scalp', 'checklist', 'roadmap', 'all'] } }, required: ['section'] }
  } },
  { type: 'function', function: {
    name: 'app_do',
    description: 'Perform an action in the app for the currently open account. Actions: "refresh_price", "mark_london" (mark London levels on chart), "mark_ny" (mark NY levels), "switch_tab" (arg tab: analysis|trades|rules|insights|cost|plan), "add_journal" (arg text), "end_session" (run end-of-session review), "log_fee" (args firm, size, cost, date? — record a prop-account fee in the Cost tab), "log_payout" (args amount, account?, date? — record a payout received), "switch_account" (args size: 50k|100k|150k, mode: eval|funded — DESTRUCTIVE, changes which account is open), "clear_insights" (DESTRUCTIVE, wipes history/insights/ledger for the open account), "set_balance" (arg value — DESTRUCTIVE, overwrites the open account balance that all floor/buffer math anchors to). For DESTRUCTIVE actions you MUST first tell Anoop exactly what it will do and get a clear "yes/confirm" from him, then call again with confirm:true — never pass confirm:true on the first mention. You can NEVER place or modify trades.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['refresh_price', 'mark_london', 'mark_ny', 'switch_tab', 'add_journal', 'end_session', 'switch_account', 'clear_insights', 'log_fee', 'log_payout', 'set_balance'] }, tab: { type: 'string' }, text: { type: 'string' }, size: { type: 'string' }, mode: { type: 'string' }, confirm: { type: 'boolean' }, date: { type: 'string', description: 'YYYY-MM-DD (log_fee/log_payout)' }, firm: { type: 'string', description: 'prop firm name (log_fee)' }, cost: { type: 'number', description: 'fee cost in $ (log_fee)' }, amount: { type: 'number', description: 'payout amount in $ (log_payout)' }, account: { type: 'string', description: 'account label (log_payout)' }, value: { type: 'number', description: 'new balance in $ (set_balance)' } }, required: ['action'] }
  } },
  // 2026-07-27: Anoop's 5-book trading library (Stock Market Wizards, Trading
  // in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp's
  // Guide to Proprietary Trading), extracted to data/books/*.txt and indexed
  // by books-index.js (local keyword search, no embeddings/network). Lets
  // Jessi ground coaching advice in what these books actually say instead of
  // paraphrasing from general training knowledge.
  { type: 'function', function: {
    name: 'search_books',
    description: 'Search Anoop\'s trading book library for passages relevant to a topic (e.g. "revenge trading", "position sizing", "probabilistic thinking", "cutting losers"). Returns the most relevant passages with book title + a rough location, so you can quote or paraphrase them when coaching Anoop. Use this when he asks what a book says about something, or when grounding advice in a specific author\'s framework would help more than generic coaching.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'topic or question to search for' }, book: { type: 'string', description: 'optional — restrict to one book: stock_market_wizards, trading_in_the_zone, intraday_trading_techniques, prop_trading_secrets, tradeapp_prop_trading_guide' } }, required: ['query'] }
  } }
];

// Combined tool set for Jessi (chart read/draw + app data/actions).
const JESSI_TOOLS = [...JESSI_TV_TOOLS, ...JESSI_APP_TOOLS];
const JESSI_TV_TOOL_NAMES = new Set(JESSI_TV_TOOLS.map(t => t.function.name));

// VOICE-ONLY reduced tool set (2026-07-23): the free 8B tier caps at 6000
// tokens/MINUTE, and re-sending all 13 tool schemas every turn was ~half the
// request. Voice only needs app data/actions + the three chart READ tools;
// the draw/alert tools are dropped (rarely asked for by voice, and the main
// co-pilot chat still has the full set). This roughly halves per-turn tokens.
const JESSI_VOICE_TOOL_NAMES = new Set(['chart_get_state', 'quote_get', 'market_key_levels']);
const JESSI_VOICE_TOOLS = [
  ...JESSI_TV_TOOLS.filter(t => JESSI_VOICE_TOOL_NAMES.has(t.function.name)),
  ...JESSI_APP_TOOLS
];

// Condensed persona for the voice path — same character, ~1/3 the tokens, and
// it enforces short spoken replies (which also cuts output tokens + dead air).
const JESSI_PERSONA_VOICE = `You are Jessi Livermore, Anoop's trading accountability coach (voice mode) in his MNQ Co-Pilot app. Anoop trades MNQ/MGC on a Lucid prop account from Hubballi, India. He has blown 16 prop accounts, all by hitting the max-loss limit, always via the same failure modes: trade-count escalation, revenge re-entries, oversized "high-conviction" trades, holding losers, trading multiple instruments, and giving back gains after being green. You know this and name it plainly — coach, not cheerleader. Grade PROCESS over P&L: a green day with broken rules is a failure; a red day with clean rules is a win. Never validate a revenge trade, an oversize, or an "I'll get it back."
Use app_get_data(section) for anything about the open account (status/cost/insights/trades/scalp/checklist/roadmap) instead of guessing — "scalp" gives the per-day hold-time/gap breakdown, use it whenever Anoop asks how his scalping looked on a given day. Use app_do to act in the app. You can NEVER place trades. For the two destructive actions (switch_account, clear_insights) get a clear spoken confirmation first, then call again with confirm:true.
HARD RULES (JadeCap-derived, non-negotiable): (1) he pre-commits an A+ setup + trade cap before session — if he hits it or mentions "one more," tell him he's done, don't help rationalize it. (2) Grade the day on plan-adherence, not P&L — plan-clean red day = win, off-plan green day = loss, say so even when it's uncomfortable. (3) Wanting to keep trading right after a finished plan trade is discomfort, not opportunity — name it and point him to the 15-min break away from the desk. (4) New indicator/confirmation added right after a loss is a red flag, not an upgrade — ask what it concretely improves. (5) Push him for ONE short reason per trade, not a stacked justification — a real edge sounds boring.
CRITICAL: this is VOICE — keep every reply to 1-3 short spoken sentences. No lists, no markdown, no long explanations. If he needs detail, offer to put it in the chat.`;

// ── App-action client round-trip ───────────────────────────────────────────────
// app_do actions live in the renderer (switchTab, refreshPrice, markLevels…),
// so the server asks the connected client to run them and waits for the
// result. Timed out at 15s so a hung/absent client can never freeze Jessi's
// tool loop (same no-hangs lesson as the voice timeouts).
let appActionCounter = 0;
const pendingAppActions = new Map(); // actionId → { resolve }
function runAppActionOnClient(ws, action, args) {
  return new Promise((resolve) => {
    const actionId = ++appActionCounter;
    const timer = setTimeout(() => {
      if (pendingAppActions.has(actionId)) {
        pendingAppActions.delete(actionId);
        resolve('The app did not respond within 15s (is the app window open?). Action may not have run.');
      }
    }, 15000);
    pendingAppActions.set(actionId, { resolve: (txt) => { clearTimeout(timer); resolve(txt); } });
    send(ws, { type: 'jessi-app-action', actionId, action, args: args || {} });
  });
}

// Read helpers for app_get_data — all scoped to the account open in the UI.
// BUG FIX (2026-07-27): this used to key off the legacy (accountSize + '_' +
// mode) composite, e.g. "50k_eval" — that scheme predates the 5-account-slot
// system added 2026-07-25. Since that migration, the CLIENT keys every bucket
// by activeSlotId (renderer/app.js acctBucketKey()) and already sends it to
// the server via the generic config-set channel (window.api.setConfig
// ('activeSlotId', ...)) — server.js just never started reading it, so Jessi
// was silently serving numbers from a stale, orphaned pre-migration bucket
// while the UI showed the correct slot-keyed balance. Caught live: fresh $50K
// eval slot showed balance $50,000 in the sidebar, Jessi reported $47,125.50.
// Prefer activeSlotId; fall back to the legacy key ONLY if it's genuinely
// absent (e.g. a config.json from before this fix), so nothing breaks cold.
function jessiBucketKey(cfg) {
  return cfg.activeSlotId || ((cfg.accountSize || '150k') + '_' + currentMode);
}
// 2026-07-27 — "numbers are the major game changer" (Anoop, verbatim, after
// the bucket-key bug above shipped a wrong balance to chat). What Anoop asked
// for was a sub-agent that double-checks every number before it's shown; a
// real LLM call on every render isn't practical (cost + latency, and an LLM
// can hallucinate a check as easily as a display bug can happen). The
// deterministic equivalent — recompute the ONE thing that matters
// (balance = startBalance + sum of every logged day's net) from the ledger,
// which is the same self-healing invariant renderer/app.js already enforces
// client-side ("THE INVARIANT", 2026-07-25) — is strictly stronger, because
// it can't be fooled and never drifts from the client's own math. Applied
// here so Jessi (server-side) NEVER trusts a possibly-stale acc.balance
// straight off disk; mismatches are logged loudly to the server console.
const ACCOUNT_START_BALANCE = { '50k': 50000, '100k': 100000, '150k': 150000 };
function jessiVerifyBalance(cfg, bucket, parseLS) {
  const acc = bucket.account || {};
  const size = cfg.accountSize || '150k';
  const start = ACCOUNT_START_BALANCE[size] != null ? ACCOUNT_START_BALANCE[size] : (acc.balance != null ? acc.balance : 0);
  const ledger = parseLS('copilot_balance_ledger', {}) || {};
  const days = Object.keys(ledger).sort();
  let verified = start;
  days.forEach(d => { verified += (ledger[d] && ledger[d].net) || 0; });
  verified = Math.round(verified * 100) / 100;
  const stored = acc.balance;
  if (stored != null && Math.abs(stored - verified) > 0.01) {
    console.warn(`[jessiVerifyBalance] MISMATCH — stored balance $${stored} vs ledger-derived $${verified} (${days.length} day(s) logged, size ${size}). Serving the verified number, not the stored one.`);
  }
  return verified;
}
function jessiActiveBucket() {
  const cfg = loadConfig();
  const key = jessiBucketKey(cfg);
  const bucket = cfg['acctBucket__' + key] || {};
  const ls = bucket.ls || {};
  const parseLS = (k, fallback) => { try { return JSON.parse(ls[k] || 'null') || fallback; } catch { return fallback; } };
  const acc = Object.assign({}, bucket.account || {});
  acc.balance = jessiVerifyBalance(cfg, bucket, parseLS);
  return { cfg, key, bucket, acc, parseLS };
}

function jessiAppGetData(section) {
  const { cfg, acc, parseLS } = jessiActiveBucket();
  const out = [];
  const want = (s) => section === 'all' || section === s;
  const sizeLabel = (cfg.accountSize || '150k').toUpperCase();

  if (want('status')) {
    const rules = getActiveRules();
    const gr = (parseLS('copilot_gr_history', []) || []).slice(-1)[0] || {};
    const tMode = rules.tradingMode || 'standard';
    out.push(`STATUS — ${sizeLabel} ${currentMode.toUpperCase()} account (currently open) · Trading mode: ${tMode.toUpperCase()}:`);
    out.push(`- Balance $${acc.balance != null ? acc.balance : '?'} · today's P&L $${acc.profit != null ? acc.profit : '?'} · trades today ${gr.n != null ? gr.n : '?'}.`);
    // FIX 2026-07-28: this line is what Jessi/Claude is told the rules ARE.
    // It was still reading the SUPERSEDED rules.tradeLimit (eval 2 / funded
    // 20) after the 2026-07-28 switch to tradesPerSession/tradesPerDay — so
    // the coach would quote "trade limit 20" while the app enforced 10. Now
    // reads the live fields, same as everything else.
    out.push(`- Rules (${tMode} mode): size cap ${rules.sizeCap} contracts/entry · daily loss tiers ${rules.dailyLossTiers.yellow}/${rules.dailyLossTiers.red}/${rules.dailyLossTiers.hard} · trade cap ${rules.tradesPerSession || 5}/session and ${rules.tradesPerDay || 10}/day (only trades closing |P&L| >= $${rules.qualifyingTradeMinAbsPnl != null ? rules.qualifyingTradeMinAbsPnl : 100} count) · one instrument per day ${rules.oneInstrumentPerDay}${tMode === 'scalper' ? ' · max hold 30min · cooldown after losses only' : ''}.`);
  }
  if (want('cost')) {
    const fees = dataLoad('account_fees') || { fees: [], payouts: [] };
    const totalFees = (fees.fees || []).reduce((s, f) => s + (Number(f.cost) || 0), 0);
    const totalPayouts = (fees.payouts || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    out.push(`COST — lifetime prop spend: ${(fees.fees || []).length} accounts, fees $${totalFees.toFixed(2)}, payouts $${totalPayouts.toFixed(2)}, NET $${(totalPayouts - totalFees).toFixed(2)}.`);
  }
  if (want('insights')) {
    const gr = (parseLS('copilot_gr_history', []) || []).slice(-7);
    const pb = parseLS('copilot_pb_tags', {}) || {};
    const mae = parseLS('copilot_maemfe', {}) || {};
    out.push(`INSIGHTS — last ${gr.length} day(s):`);
    gr.forEach(d => out.push(`- ${d.date}: $${d.pnl} · ${d.n} trades · disc ${d.disc}% · revenge ${d.revenge || 0} · over-cap ${d.over || 0} · flips ${d.flips || 0} · maxConsecLoss ${d.maxConsecLoss || 0} · giveback $${d.giveback || 0}${d.avgHold != null ? ` · avg hold ${d.avgHold < 60 ? Math.round(d.avgHold) + 's' : Math.floor(d.avgHold / 60) + 'm'}` : ''}`));
    out.push('- Call app_get_data("scalp") for the full per-day hold-time / gap breakdown.');
    if (Object.keys(pb).length) out.push(`- Playbook tags: ${JSON.stringify(pb)}`);
    if (Object.keys(mae).length) out.push(`- MAE/MFE: ${JSON.stringify(mae)}`);
  }
  if (want('scalp')) {
    // Per-day scalping breakdown — added 2026-08-01 (Anoop): he wants hold
    // time / trade count / inter-trade gap visible per day, not just as one
    // overall number, so he can spot which specific days need fixing.
    //
    // DELIBERATELY NOT reading gr_history's avgHold/medHold/avgGap here —
    // checked against the real data (s1, 2026-07-29 and 07-31) and found
    // those two days have NO hold fields in gr_history at all (older/
    // different logging path never wrote them), which would have silently
    // shown "?" for 2 of 5 days. day_trades.json DOES have t/x/hold on every
    // individual trade for every day, so this recomputes straight from that
    // raw per-trade store instead — self-healing for every historical day,
    // not just the ones that happened to log the summary fields correctly.
    const dt = parseLS('copilot_day_trades', {}) || {};
    const grByDate = {}; (parseLS('copilot_gr_history', []) || []).forEach(d => { grByDate[d.date] = d; });
    const rules = getActiveRules();
    const maxHold = (rules.tradingMode === 'scalper') ? (rules.maxHoldSeconds || 1800) : Infinity;
    const fmtSec = (s) => {
      if (s == null) return '?';
      if (s < 60) return Math.round(s) + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    };
    const dates = Object.keys(dt).sort().slice(-10);
    if (dates.length) {
      out.push(`SCALP STATS — last ${dates.length} trading day(s), per day (recomputed from per-trade data):`);
      dates.forEach(date => {
        const trades = (dt[date] || []).filter(t => typeof t.hold === 'number');
        if (!trades.length) { out.push(`- ${date}: no per-trade hold data on file.`); return; }
        const holds = trades.map(t => t.hold).sort((a, b) => a - b);
        const avgHold = holds.reduce((a, v) => a + v, 0) / holds.length;
        const medHold = holds.length % 2 === 0 ? (holds[holds.length / 2 - 1] + holds[holds.length / 2]) / 2 : holds[Math.floor(holds.length / 2)];
        const sorted = trades.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) { if (sorted[i].t != null && sorted[i - 1].x != null) { const g = (sorted[i].t - sorted[i - 1].x) / 1000; if (g >= 0) gaps.push(g); } }
        const avgGap = gaps.length ? gaps.reduce((a, v) => a + v, 0) / gaps.length : 0;
        const holdExceeded = trades.filter(t => t.hold > maxHold).length;
        const mode = (grByDate[date] && grByDate[date].tradingMode) || 'standard';
        const net = grByDate[date] ? grByDate[date].pnl : trades.reduce((a, t) => a + (t.pnl || 0), 0);
        out.push(`- ${date} (${mode}): ${trades.length} trades · avg hold ${fmtSec(avgHold)} · median hold ${fmtSec(medHold)} · avg gap between trades ${fmtSec(avgGap)}${mode === 'scalper' ? ` · hold-exceeded (>30m) ${holdExceeded}` : ''} · net $${net}`);
      });
    } else {
      out.push('SCALP STATS — no trading days logged yet for this account.');
    }
  }
  if (want('checklist')) {
    const ck = (parseLS('copilot_ck_history', []) || []).slice(-7);
    const plan = parseLS('copilot_checklist_plan', null);
    out.push(`CHECKLIST — last ${ck.length} submission(s): ${ck.map(c => `${c.date}(tier ${c.tier || '?'}, score ${c.score != null ? c.score : 'n/a'})`).join(', ') || 'none logged'}.`);
    if (plan) out.push(`- Checklist plan: ${JSON.stringify(plan)}`);
  }
  if (want('trades')) {
    // Per-trade history (last 12) — the same day_trades data Insights shows.
    const dt = parseLS('copilot_day_trades', {}) || {};
    const flat = [];
    Object.keys(dt).sort().forEach(d => (dt[d] || []).forEach(t => flat.push(Object.assign({ date: d }, t))));
    const last = flat.slice(-12);
    if (last.length) {
      out.push(`TRADES — last ${last.length} (of ${flat.length}):`);
      last.forEach(t => out.push(`- ${t.date} ${t.side || '?'} ${t.size != null ? t.size + 'c' : ''}${t.ep != null ? ' @' + t.ep : ''} $${t.pnl != null ? t.pnl : '?'}${t.hold ? ' held ' + t.hold + 's' : ''}`));
    } else {
      out.push('TRADES — none ingested for this account yet.');
    }
  }
  if (want('roadmap')) {
    const loop = parseLS('copilot_loop', {}) || {};
    const miles = dataLoad('eval_milestones') || {};
    out.push(`ROADMAP — loop challenge: streak ${loop.streak || 0}/${loop.goalDays || 5} green days (target score ${loop.target || 70}), focus: "${loop.focus || 'n/a'}".`);
    out.push(`- Apprenticeship plan (from memory): Stage 1 process-only (no P&L focus) → Stage 2 winners bigger than losers → Stage 3 half-size funded start. App dev is frozen to bug-fixes only during this.`);
    if (Object.keys(miles).length) out.push(`- Eval milestones: ${JSON.stringify(miles)}`);
  }
  return out.join('\n') || `No data found for section "${section}".`;
}

// The per-connection tool executor Jessi uses. Routes chart tools to the TV
// MCP bridge, app_get_data to the local reader, app_do to the client.
function makeJessiToolExecutor(ws) {
  // set_balance is confirm-gated too: it rewrites the number every risk
  // calculation (floor, buffer, day-stop context) is anchored to.
  const DESTRUCTIVE = new Set(['switch_account', 'clear_insights', 'set_balance']);
  return async (name, args) => {
    if (JESSI_TV_TOOL_NAMES.has(name)) {
      // 2026-07-25: fail FAST and clearly when TradingView is down instead of
      // calling into the bridge and waiting on a call that cannot succeed
      // (risking a hang until the 90s turn timeout). Returned as a normal tool
      // RESULT, not a thrown error, so the model reads it, tells Anoop, and
      // carries on with the rest of the conversation.
      if (!mcpBridge.ready || !mcpBridge.tvConnected) {
        return `TradingView is disconnected — "${name}" is unavailable right now. Do not retry chart tools this turn. Tell Anoop TradingView Desktop needs to be running and reconnected (Refresh in the app), and answer whatever you can from his app data instead.`;
      }
      const raw = await mcpBridge.callTool(name, args || {});
      return (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
    }
    if (name === 'app_get_data') {
      return jessiAppGetData((args && args.section) || 'status');
    }
    if (name === 'search_books') {
      const query = (args && args.query) || '';
      if (!query.trim()) return 'search_books needs a "query".';
      const results = booksIndex.searchBooks(query, { limit: 4, book: (args && args.book) || null });
      if (!results.length) return `No passages found for "${query}" in the book library.`;
      return results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
    }
    if (name === 'app_do') {
      const action = args && args.action;
      if (!action) return 'app_do needs an "action".';
      if (DESTRUCTIVE.has(action) && !(args && args.confirm === true)) {
        return `CONFIRMATION REQUIRED — "${action}" is destructive. Tell Anoop out loud exactly what it will do, get a clear spoken "yes/confirm", then call app_do again with confirm:true. Do NOT run it yet.`;
      }
      return await runAppActionOnClient(ws, action, args || {});
    }
    return `Unknown tool "${name}".`;
  };
}

// ── End app tools ──────────────────────────────────────────────────────────────

// ── Always-on background TV snapshot for Jessi ─────────────────────────────────
// Lighter cadence (3 min) than the 60s/45s/30s engulf monitors, specifically so
// this doesn't add more load to a TradingView MCP connection that has already
// dropped twice this session. Populates jessiTVCache; buildJessiContext() folds
// it in with an age indicator so Jessi has near-live chart awareness without a
// fetch on every single message.
let jessiTVCache = { text: null, ts: 0 };
let jessiTVMonitorInterval = null;
function startJessiTVMonitor() {
  if (jessiTVMonitorInterval) clearInterval(jessiTVMonitorInterval);
  const poll = async () => {
    if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
    try {
      const [state, quote, levels] = await Promise.all([
        mcpBridge.callTool('chart_get_state', {}).catch(() => null),
        mcpBridge.callTool('quote_get', {}).catch(() => null),
        mcpBridge.callTool('market_key_levels', {}).catch(() => null)
      ]);
      const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
      jessiTVCache = { text: `Chart state: ${txt(state)}\nQuote: ${txt(quote)}\nKey levels: ${txt(levels)}`, ts: Date.now() };
    } catch { /* leave stale cache in place rather than wiping it on a transient error */ }
  };
  poll(); // immediate first read
  jessiTVMonitorInterval = setInterval(poll, 3 * 60 * 1000);
}

// minimal=true (voice): only the account one-liner + the tool directory, no
// chart snapshot / history / journal — those are all fetchable via tools and
// were padding every voice turn against the 6000 TPM cap.
function buildJessiContext(minimal) {
  const cfg = loadConfig();
  const key = jessiBucketKey(cfg); // see jessiBucketKey() note above — slot-keyed, not legacy accountSize_mode
  const bucket = cfg['acctBucket__' + key] || {};
  const ls = bucket.ls || {};
  const parseLS = (k, fallback) => { try { return JSON.parse(ls[k] || 'null') || fallback; } catch { return fallback; } };
  const acc = Object.assign({}, bucket.account || {});
  acc.balance = jessiVerifyBalance(cfg, bucket, parseLS); // see jessiVerifyBalance() note above

  const parts = [];
  parts.push(`## DATA CONTEXT (open account — treat as ground truth)`);
  parts.push(`Active account: ${(cfg.accountSize || '150k').toUpperCase()} ${currentMode.toUpperCase()} — balance $${acc.balance || '?'}, today's P&L $${acc.profit != null ? acc.profit : '?'}.`);
  parts.push(`For cost/insights/trades/scalp/checklist/roadmap/history/rules call app_get_data(section) — "scalp" is the per-day hold-time/gap breakdown. To act call app_do. This open account only. No trades.`);

  if (minimal) return parts.join('\n');

  // Full context (text chat): add a bit more inline.
  const grHistory = (parseLS('copilot_gr_history', []) || []).slice(-3);
  const journal = (dataLoad('trade_journal') || []).slice(-3);
  // 2026-07-25: state TradingView's status EXPLICITLY. Without this, when the
  // CDP connection is down the model sees no chart section at all, assumes the
  // tools are available, calls them, gets a wall of errors back, and burns
  // requests + context on guaranteed failures. Telling it plainly not to try
  // costs a few tokens and avoids all of that.
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    parts.push(`\n### TradingView: OFFLINE (CDP connection to TradingView Desktop is down)
Do NOT call any chart tool (chart_get_state, quote_get, market_key_levels, data_get_ohlcv, data_get_pine_labels, draw_shape, draw_list, draw_remove_one, alert_*) — they will all fail until it reconnects. If Anoop asks about the live chart, price or levels, tell him straight that TradingView is disconnected and he needs TradingView Desktop running, then Refresh in the app. Everything else about you works fine without it: his trade history, checklist, journal, breach record, patterns and the coaching all come from app data, not the chart.`);
  } else if (jessiTVCache.text) {
    const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
    parts.push(`\n### Live chart snapshot (${ageSec}s old — call a chart tool for something fresher)\n${jessiTVCache.text}`);
  }
  if (grHistory.length) {
    parts.push(`\n### Last ${grHistory.length} day(s) (call app_get_data "insights" for more):`);
    grHistory.forEach(d => parts.push(`- ${d.date}: $${d.pnl} · ${d.n} trades · disc ${d.disc}%`));
  }
  if (journal.length) {
    parts.push(`\n### Recent journal notes:`);
    journal.forEach(j => parts.push(`- [${j.ts}] ${j.text}`));
  }
  // 2026-08-01: surface the Scalper agent's behavioural notes to Jessi too, so
  // the two agents reinforce the same observation instead of contradicting each
  // other. Capped to 3 days here (Jessi's context is token-sensitive); the
  // Post-Session Analyst gets 7 days.
  try {
    const sn = scalperNotesRead(null, 3);
    if (sn && !/^No scalper notes/.test(sn)) parts.push('\n### Scalper agent notes (behaviour, from video reviews):\n' + sn);
  } catch (e) {}
  return parts.join('\n');
}

// Lightweight on-demand TV pull — only fires when the message text looks like
// it's asking about the live chart. This is intentionally NOT a background
// poll; it runs once, synchronously, inside a single chat turn.
async function maybeFetchTVSnapshot(text) {
  if (!/\b(chart|price|level|pdh|pdl|candle|trend|bias|zone|setup|4h|1h|15m|quote)\b/i.test(text || '')) return null;
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return '(Anoop asked about the chart, but TradingView MCP is not connected right now — tell him to check the connection.)';
  try {
    const [state, quote, levels] = await Promise.all([
      mcpBridge.callTool('chart_get_state', {}).catch(() => null),
      mcpBridge.callTool('quote_get', {}).catch(() => null),
      mcpBridge.callTool('market_key_levels', {}).catch(() => null)
    ]);
    const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : '';
    return `### Live TradingView snapshot (pulled just now, on-demand)\nChart state: ${txt(state) || 'unavailable'}\nQuote: ${txt(quote) || 'unavailable'}\nKey levels: ${txt(levels) || 'unavailable'}`;
  } catch (e) {
    return `(Tried to pull the live chart but it failed: ${e.message})`;
  }
}

// 2026-07-23: Groq's per-response rate-limit headers give live TPM/RPD
// remaining (see groqAgent.stream()'s onQuota) — this only turns that into a
// user-facing warning once it's actually getting tight, so normal turns
// don't spam a status line on every single message. Threshold is on TPM
// specifically since that's what caused the 413 seen live (a single turn's
// tool-call context blowing past the per-minute cap) — RPD running low is a
// much rarer real-world case on the 8B model's 14.4K/day allowance.
const QUOTA_WARN_FRACTION = 0.2;
function quotaWarning(model, quota) {
  if (!quota || quota.limitTokens == null || quota.remainingTokens == null) return null;
  if (quota.remainingTokens / quota.limitTokens > QUOTA_WARN_FRACTION) return null;
  return `${model}: ${quota.remainingTokens}/${quota.limitTokens} tokens left this minute.`;
}

async function handleJessiChat(ws, msg) {
  const { messages, reqId } = msg;
  const lastUserText = (messages && messages.length) ? messages[messages.length - 1].content : '';

  // Background monitor (jessiTVCache) covers most "what's the chart doing"
  // asks already; this is only an extra force-refresh for freshness when the
  // message specifically looks chart-related, on top of the cache in buildJessiContext().
  const tvSnapshot = await maybeFetchTVSnapshot(lastUserText);
  const systemPrompt = JESSI_PERSONA + '\n\n' + buildJessiContext() + (tvSnapshot ? '\n\n' + tvSnapshot : '');

  // FIX (2026-07-23, "still not working" — text chat hit a 429 on
  // llama-3.3-70b-versatile, TPD 95443/100000 used): this call never passed a
  // `model`, so groq-agent.js's stream() silently defaulted to the 70B model
  // (see GROQ_MODEL in groq-agent.js) — a completely separate free-tier daily
  // budget from the 8B model handleJessiVoiceSend() already switched to for
  // the same rate-limit reason. Text chat was still exposed to the exact
  // problem voice was fixed for. Now shares the 8B model/budget with voice.
  // Tradeoff worth knowing: text chat and voice now draw from the SAME daily
  // 8B token bucket, so heavy use of both in one day can still exhaust it —
  // just no longer on a bucket that was already at 95%+ before this fix.
  // 2026-07-25: switched from Groq to GEMINI as Jessi's primary brain.
  // Root cause of the repeated live failures was never the daily budget — it
  // was Groq's free-tier TOKENS-PER-MINUTE ceiling (6,000-8,000), which
  // Jessi's turn genuinely exceeds: 413 "Request too large" and
  // 429 "TPM Limit 8000, Used 5517, Requested 2663" are both per-minute
  // errors. Shuffling between two Groq model IDs only moved the same request
  // between two equally-small buckets. Gemini's free tier allows 250,000 TPM
  // (~30x), so the fat context fits instead of needing to be trimmed.
  // Flash-Lite over plain Flash: 15 RPM / 1,000 RPD vs 10 RPM / 250 RPD —
  // Jessi is meant for casual back-and-forth, so request volume wins over
  // the marginal reasoning gain.
  // Groq stays as the fallback: separate vendor, entirely separate quota, and
  // still the fastest inference available if Gemini's RPD ever runs out.
  await groqAgent.stream(messages, systemPrompt, JESSI_TOOLS, {
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    temperature: 0.85,
    // 2026-07-25 (revised): started as a single gemini-2.5-flash-lite +
    // one Groq fallback, which died on a live 404 — Google had closed the 2.5
    // line to new accounts, and 404 wasn't retryable at the time. Now an
    // ordered chain, tried top to bottom on 404/429/413/400:
    //   1. gemini-3.5-flash      — GA, 15 RPM / 1,500 RPD
    //   2. gemini-3.1-flash-lite — GA, cheaper/lighter Google fallback
    //   3. gemini-2.5-flash      — older line; works for accounts that
    //                              already had access before it was closed
    //   4. openai/gpt-oss-20b    — Groq. Different vendor, separate quota,
    //      and Groq's own migration target for llama-3.1-8b-instant /
    //      llama-3.3-70b-versatile, both deprecated 2026-06-17 (retiring
    //      08/16/26). Last because of Groq's 6-8K TPM ceiling, which is what
    //      caused the original failures this whole switch was meant to fix.
    // Entries whose provider has no key configured are skipped automatically.
    fallbackChain: [
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'groq',   model: 'openai/gpt-oss-20b' }
    ],
    toolExecutor: makeJessiToolExecutor(ws),
    onToken:     (text)              => send(ws, { type: 'jessi-chat-token',     reqId, text }),
    onToolStart: (name, id)          => send(ws, { type: 'jessi-chat-tool-start',reqId, name, id }),
    onToolDone:  (name, id, ok, res) => send(ws, { type: 'jessi-chat-tool-done', reqId, name, id, ok, result: res }),
    onFallback:  (fromM, toM)        => send(ws, { type: 'jessi-chat-fallback',  reqId, from: fromM, to: toM }),
    onWait:      (m, sec)            => send(ws, { type: 'jessi-chat-quota-warn', reqId, message: `${m}: per-minute rate cap — waiting ${sec}s and retrying the same model (not switching).` }),
    onQuota:     (m, quota) => { const w = quotaWarning(m, quota); if (w) send(ws, { type: 'jessi-chat-quota-warn', reqId, message: w }); },
    onDone:      (fullText)          => send(ws, { type: 'jessi-chat-done',      reqId, fullText }),
    onError:     (errMsg)            => send(ws, { type: 'jessi-chat-error',     reqId, message: errMsg })
  });
}

// ── 3-Agent Debate System ──────────────────────────────────────────────────────
// Architecture: User question → Jessi (discipline/psychology) + Analysis (technical/market)
// run in PARALLEL → Expert Judge synthesizes both arguments → final answer streamed to user.
// All three agents run on the same Gemini backend (free tier). Data is PRE-FETCHED before
// the debate so no tool calling is needed during the debate itself — faster and cheaper.

const ANALYSIS_DEBATE_PERSONA = `You are the Technical Analysis Agent in Anoop Habib's MNQ Co-Pilot trading app. Your role in this debate is to argue PURELY from the market/technical data perspective.

Your data domain (and ONLY yours — stay in your lane):
- Live TradingView chart state: current symbol, timeframe, indicator values
- Price action: OHLCV bars, candlestick patterns, trend structure
- Key levels: support/resistance, Pine-drawn lines/labels/boxes, PDH/PDL, session levels
- Technical indicators: RSI, MACD, EMA, Bollinger Bands, VWAP — whatever's on the chart
- Market structure: higher highs/lows, lower highs/lows, FVGs, SFPs, engulfing patterns
- Multi-timeframe alignment: Daily → 4H → 1H → 15M → 5M confluence
- Playbook validity: whether current price action satisfies Playbook A (engulfing + TF alignment), Playbook B (SFP + FVG), or Playbook C (engulfing validity rules)

What you are NOT:
- You are NOT a psychologist or discipline coach — that's Jessi's domain
- You do NOT comment on trade count, revenge patterns, emotional state, or rule violations
- You do NOT give the final verdict — the Expert Judge does that

Your job: Present the strongest technical argument you can. If the setup is valid, say so with specific levels and confluence. If it's not, say so with specific reasons (no alignment, no zone, wrong structure). Be precise with numbers — cite actual prices, levels, and indicator readings from the data below. If data is missing or stale, say so rather than fabricating.

Anoop's entry framework requires ALL of these in sequence: (1) Daily bias clear, (2) 1H aligns with Daily, (3) Price at a pre-marked 4H zone, (4) 15M/5M reaction at zone, (5) 3M/1M trigger. Score the current setup against each step.`;

const JUDGE_PERSONA = `You are the Expert Judge in Anoop Habib's MNQ Co-Pilot trading app. You receive THREE arguments — from Jessi (discipline/psychology), the Technical Analysis agent (structure/levels), and the ICT Power of 3 agent (AMD phase: Accumulation / Manipulation / Distribution) — and you synthesize them into a single, definitive answer.

Your method:
1. Read all three arguments carefully. Identify where they AGREE and where they CONFLICT.
2. When they agree, state the consensus plainly — no need to rehash each one.
3. When they conflict, weigh the evidence each side presented. Technical data trumps feelings, but discipline data trumps technical setups (a valid setup with a revenge mindset is still a NO-GO).
4. Give your VERDICT clearly at the top, then the reasoning. Don't bury the answer.
5. If any agent made a claim unsupported by its data, call that out.

Decision hierarchy (non-negotiable):
- If Jessi flags a discipline violation (revenge, overtrading, broken plan, sizing up while down) → that OVERRIDES any technical setup quality AND any AMD phase. A perfect chart doesn't fix a broken process.
- If Analysis says the setup is invalid (no alignment, no zone, wrong structure) → that OVERRIDES Jessi saying "he's in a good headspace." Feeling good doesn't make a bad setup tradeable.
- If Power of 3 says price is still in ACCUMULATION, or that the phase is unclear → treat that as a WAIT signal even when the other two look acceptable. Entering during accumulation is entering before the manipulation leg that would stop him out — this is exactly the trap the framework exists to avoid.
- If Power of 3 identifies MANIPULATION completing (liquidity swept, reversal underway) and both other agents are green, that STRENGTHENS the case — say so explicitly.
- ALL THREE must be green for a GO. Any one red = NO-GO, with the specific reason.
- Power of 3 alone is never sufficient for a GO — a clean AMD read with a discipline violation is still NO.

Tone: Direct, data-backed, no hedging. You're the final word — own it. Keep it concise: verdict first, then 2-4 sentences of reasoning citing specific points from each agent. Not an essay.

Context: Anoop has blown 16 prop accounts. Every single one hit its Max Loss Limit through the same failure modes. The margin for error is zero. When in doubt, the answer is NO.`;

// Pre-fetch all data for the Analysis agent (no tool calling during debate)
async function gatherAnalysisContext() {
  const parts = [];

  // Live TradingView snapshot
  if (mcpBridge.ready && mcpBridge.tvConnected) {
    try {
      const [state, quote, levels, ohlcv, labels, boxes] = await Promise.all([
        mcpBridge.callTool('chart_get_state', {}).catch(() => null),
        mcpBridge.callTool('quote_get', {}).catch(() => null),
        mcpBridge.callTool('market_key_levels', {}).catch(() => null),
        mcpBridge.callTool('data_get_ohlcv', { summary: true }).catch(() => null),
        mcpBridge.callTool('data_get_pine_labels', {}).catch(() => null),
        mcpBridge.callTool('data_get_pine_boxes', {}).catch(() => null)
      ]);
      const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
      parts.push('## LIVE CHART DATA (pulled just now)');
      parts.push('Chart state: ' + txt(state));
      parts.push('Quote: ' + txt(quote));
      parts.push('Key levels: ' + txt(levels));
      parts.push('OHLCV summary: ' + txt(ohlcv));
      parts.push('Pine labels: ' + txt(labels));
      parts.push('Pine boxes (zones): ' + txt(boxes));
    } catch (e) {
      parts.push('## CHART DATA: FAILED TO FETCH (' + e.message + ')');
    }
  } else {
    parts.push('## CHART DATA: UNAVAILABLE (TradingView not connected)');
  }

  // Also include the cached TV snapshot if it has extra info
  if (jessiTVCache.text) {
    const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
    parts.push('\n## Background monitor snapshot (' + ageSec + 's old)\n' + jessiTVCache.text);
  }

  // Recent trade data (from the active account) for pattern context
  const appData = jessiAppGetData('all');
  if (appData) parts.push('\n## ACCOUNT & TRADE DATA\n' + appData);

  return parts.join('\n');
}

// Run one debate agent (no tools, collect full text)
function runDebateAgent(systemPrompt, userQuestion, dataContext) {
  return new Promise((resolve) => {
    let fullText = '';
    groqAgent.stream(
      [{ role: 'user', content: userQuestion }],
      systemPrompt + '\n\n' + dataContext,
      [], // no tools
      {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        temperature: 0.7,
        fallbackChain: [
          { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
          { provider: 'gemini', model: 'gemini-2.5-flash' },
          { provider: 'groq',   model: 'openai/gpt-oss-20b' }
        ],
        onToken: (text) => { fullText += text; },
        onDone: () => resolve(fullText || '(No argument produced)'),
        onError: (err) => resolve('(Agent error: ' + err + ')')
      }
    );
  });
}

async function handleDebateChat(ws, msg) {
  const { messages, reqId } = msg;
  const lastUserText = (messages && messages.length) ? messages[messages.length - 1].content : '';

  // BUGFIX (2026-07-28): this whole function used to run with no top-level
  // try/catch. Anoop hit a hard stuck chat ("the chat is crashed" — red stop
  // icon, input disabled) that traced back to this: any throw anywhere in
  // here (a synchronous throw from groqAgent.stream, gatherAnalysisContext,
  // etc.) became an unhandled promise rejection on the server. The client
  // never got a debate-judge-error, so its sendDebateChat() promise just sat
  // there until its OWN 5-minute timeout — isStreaming stuck true the whole
  // time, which is what made the UI look crashed. Wrapping the body means any
  // failure now reaches the client immediately instead of silently hanging.
  try {
    // Phase 1: Pre-fetch data for both agents
    send(ws, { type: 'debate-status', reqId, phase: 'gathering', message: 'Gathering data for both agents...' });

    const jessiContext = buildJessiContext();
    const tvSnapshot = await maybeFetchTVSnapshot(lastUserText);
    const analysisContext = await gatherAnalysisContext();

    const jessiSystemPrompt = JESSI_PERSONA + '\n\nYou are in DEBATE MODE. Present your argument on this question from your perspective (discipline, psychology, trade history, patterns, accountability). Be specific — cite dates, trade counts, failure modes. Do NOT give a final verdict — the Expert Judge will do that. Keep your argument to 3-6 sentences, data-dense.\n\n' + jessiContext + (tvSnapshot ? '\n\n' + tvSnapshot : '');
    const analysisSystemPrompt = ANALYSIS_DEBATE_PERSONA + '\n\nPresent your argument on this question from your perspective (chart structure, levels, indicators, multi-TF alignment, playbook validity). Be specific — cite prices, levels, indicator values. Do NOT give a final verdict — the Expert Judge will do that. Keep your argument to 3-6 sentences, data-dense.';

    // Phase 2: Run all THREE agents in parallel.
    // 2026-07-28: ICT Power of 3 joined the debate as a full participant
    // (Anoop: "i want its active participation" — a side button wasn't the
    // flow he asked for). Its AMD phase read is fetched with its own
    // multi-timeframe context, independent of the Analysis agent's.
    send(ws, { type: 'debate-status', reqId, phase: 'debating', message: 'Jessi, Analysis and Power of 3 are building their arguments...' });

    const po3Context = await gatherPO3Context();
    const po3SystemPrompt = ICT_PO3_PERSONA + ICT_PO3_DEBATE_SUFFIX;

    const [jessiArgument, analysisArgument, po3Argument] = await Promise.all([
      runDebateAgent(jessiSystemPrompt, lastUserText, ''),
      runDebateAgent(analysisSystemPrompt, lastUserText, analysisContext),
      runDebateAgent(po3SystemPrompt, lastUserText, po3Context)
    ]);

    // Send all three arguments to the UI
    send(ws, { type: 'debate-arguments', reqId, jessi: jessiArgument, analysis: analysisArgument, po3: po3Argument });

    // Phase 3: Judge synthesizes — streamed to user
    send(ws, { type: 'debate-status', reqId, phase: 'judging', message: 'Expert Judge is reviewing both arguments...' });

    const judgeContext = `## JESSI'S ARGUMENT (Discipline & Psychology)\n${jessiArgument}\n\n## ANALYSIS AGENT'S ARGUMENT (Technical & Market)\n${analysisArgument}\n\n## ICT POWER OF 3 ARGUMENT (AMD phase — Accumulation / Manipulation / Distribution)\n${po3Argument}\n\n## ORIGINAL QUESTION\n${lastUserText}`;

    await groqAgent.stream(
      [{ role: 'user', content: 'Review both arguments above and deliver your verdict on the original question.' }],
      JUDGE_PERSONA + '\n\n' + judgeContext,
      [], // no tools
      {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        temperature: 0.5,
        fallbackChain: [
          { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
          { provider: 'gemini', model: 'gemini-2.5-flash' },
          { provider: 'groq',   model: 'openai/gpt-oss-20b' }
        ],
        onToken:  (text) => send(ws, { type: 'debate-judge-token', reqId, text }),
        onDone:   (fullText) => {
          send(ws, { type: 'debate-judge-done', reqId, fullText });
          // Archive the verdict AND the three arguments it was built from —
          // the verdict alone is not reviewable without knowing what each
          // agent actually said. Wrapped so a disk problem can never affect
          // the response already sent above.
          saveReviewRecord('judge', fullText, {
            question: lastUserText,
            jessi: jessiArgument,
            analysis: analysisArgument,
            po3: po3Argument
          });
        },
        onError:  (errMsg) => send(ws, { type: 'debate-judge-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleDebateChat] uncaught error:', e);
    send(ws, { type: 'debate-judge-error', reqId, message: e.message || 'Debate failed unexpectedly.' });
  }
}

// ── ICT Power of 3 (AMD) agent ───────────────────────────────────────────────────
// 2026-07-28, from Anoop's own "ICT Power of 3 – The Ultimate Guide" PDF.
// Judges which phase of the Accumulation → Manipulation → Distribution cycle
// price is currently in. Runs across timeframes but weights 15m and 5m most
// heavily (Anoop's explicit instruction), because that's where the phase
// transition is actually readable for a scalper.
//
// The doctrine below is my operational paraphrase of that PDF, not a copy of
// it — encoded as decision rules the model can actually apply to live bars.
const ICT_PO3_PERSONA = `You are the ICT POWER OF 3 agent in Anoop Habib's MNQ/MGC trading co-pilot.

## WHAT YOU DO
You judge ONE thing: which phase of the AMD cycle price is currently in —
ACCUMULATION, MANIPULATION, or DISTRIBUTION — and what that implies for the next move.

## THE FRAMEWORK (Power of 3 / AMD)
The premise: smart money must fill large positions against retail, so the day is
engineered in three stages around the session's OPENING PRICE.

1. **ACCUMULATION** — Price ranges tightly near the session open. Smart money is
   building its position here. Look for: compression, overlapping candles, low
   range expansion, price oscillating around the open. This is the "no trade yet"
   phase — the direction has not shown itself.

2. **MANIPULATION** — A sharp move AGAINST the true daily direction, pushing
   through the accumulation range to run liquidity (old highs / old lows / equal
   highs-lows / PDH / PDL). Its purpose is to trap retail into the wrong side and
   stop out correctly-positioned early entries.
   - On a BULLISH day: manipulation goes DOWN, sweeping sell-side liquidity
     below the open/old lows, leaving a wick below.
   - On a BEARISH day: manipulation goes UP, sweeping buy-side liquidity above
     the open/old highs, leaving a wick above.
   This is the highest-value phase to IDENTIFY, because the reversal out of it
   is the entry.

3. **DISTRIBUTION** — The real move of the day, in the direction of the daily
   bias, away from the manipulation extreme, targeting the opposite liquidity
   pool. Confirmed by displacement (a strong impulsive candle, often leaving an
   FVG) back through the accumulation range.

## HARD REQUIREMENT — HTF BIAS GATES THE PHASE CALL (non-negotiable)
The framework is USELESS without a correct daily bias, because manipulation is
defined relative to it — "manipulation" only means something as a move AGAINST
a direction that's already established on the higher timeframe.
Your bias comes from the "MECHANICAL BIAS" block in the data — the app grades
30 bars of 4H (e.g. "STRONG BEAR"). READ THAT BLOCK FIRST. It states the 4H
direction (your gate), the 1H direction, and an explicit GATE line telling you
whether bias is established. Trust that GATE line.
DAILY IS DELIBERATELY NOT IN YOUR DATA (2026-07-29, Anoop's decision — he reads
the daily candle himself). Never claim or imply a daily read. 4H is your bias
gate; 1H is your structure anchor.

This is a HARD GATE, not a soft caveat:
- If the 4H direction is bullish or bearish → bias IS established. Proceed to
  read the phase on 15m/5m as normal, even if the 1H read is neutral. The 4H
  sets bias here; the lower reads do not veto it.
- If the 4H direction itself is 'unclear' → PHASE MUST BE "UNCLEAR".
  Full stop. Do NOT name ACCUMULATION, MANIPULATION, or DISTRIBUTION in this
  case, no matter how clean the 15m/5m structure looks in isolation. A textbook
  sweep-and-reversal on 5m still means nothing if you don't know which
  direction it's supposedly manipulating AWAY from. Naming a phase anyway is
  not a "low confidence" call — it is a WRONG call, because the phase concept
  doesn't apply without a direction to manipulate against.
- When you block the phase call this way, state plainly: "HTF bias unclear —
  phase call blocked. [describe what you see on 15m/5m purely as price action,
  with no A/M/D label attached.]"

## TIMEFRAME WEIGHTING (Anoop's instruction) — two DIFFERENT jobs, don't blur them
- **Direction (bias): the MECHANICAL BIAS block governs this, always.**
  4H (30 bars) is the gate, 1H is corroboration. Never let 15m/5m override or
  substitute for it. State the label you were actually given (e.g. "4H STRONG
  BEAR, 30 bars") rather than a vague "trend".
- **Phase (which of A/M/D, ONCE bias is established): 15m/5m govern this.**
  Accumulation and manipulation are session-relative micro-structure — by the
  time a 4H candle closes the whole AMD cycle may already be over, so the
  phase itself has to be read on the lower timeframes.
  - **15m: PRIMARY phase-structure read** — accumulation range and the
    manipulation sweep are clearest here. Weight this most, but only after
    the HTF gate above has passed.
  - **5m: PRIMARY trigger read** — displacement, FVG creation, and the
    reversal out of manipulation. Weight this second.
- In one line: HTF decides IF you can call a phase at all and WHICH direction
  it's relative to; LTF decides WHICH phase you're actually in. They are not
  competing for the same vote — HTF is the gate, LTF is the reading.

## OUTPUT FORMAT (strict, keep it tight)
**INSTRUMENT:** the symbol from the chart state (Anoop trades MNQ1! and MGC1!,
but this must work on whatever he has open — read it, never assume it)
**PHASE:** ACCUMULATION | MANIPULATION | DISTRIBUTION | UNCLEAR
**CONFIDENCE:** HIGH | MEDIUM | LOW
**4H BIAS:** bullish | bearish | unclear (quote the graded label + bar count)
**EVIDENCE (15m):** the specific structure — cite actual prices/levels.
**EVIDENCE (5m):** displacement / FVG / sweep detail — cite actual prices.
**LIQUIDITY:** which pool was taken or is being targeted, with the price.
**WHAT THIS MEANS NEXT:** what would confirm the next phase, and the invalidation.

## RULES
- ANY INSTRUMENT. Anoop's main two are MNQ1! (Micro Nasdaq) and MGC1! (Micro
  Gold), but you read whatever symbol is on the chart. Take the instrument from
  the chart state in your data and name it in your answer. Never assume MNQ.
  Levels and ranges differ hugely between instruments (MNQ moves in points on a
  ~27,000 handle, MGC on a ~3,000-4,000 gold handle) — never carry a level or
  a range from one instrument to another.
- Cite REAL numbers from the data given. Never invent a level.
- If a timeframe's data is missing, say so — do not fill the gap with a guess.
- You describe market STATE. You do NOT tell Anoop to enter, size, or exit — his
  playbook rules and risk limits govern that, and other agents handle it.
- Anoop has blown 16 accounts; the most valuable thing you can say is often
  "this is still ACCUMULATION — nothing to do yet."
- Under 250 words.`;

// Debate-mode variant of the PO3 persona. Same doctrine, but it argues its
// corner for the Judge instead of issuing a standalone report — mirrors how
// JESSI_PERSONA / ANALYSIS_DEBATE_PERSONA are adapted for debate.
const ICT_PO3_DEBATE_SUFFIX = `

## YOU ARE IN DEBATE MODE
Present your argument from the AMD/Power-of-3 angle ONLY: which phase price is
in, what evidence on 15m and 5m supports that, and which liquidity pool is in
play. Cite real prices.
Do NOT give a final verdict or a trade decision — the Expert Judge does that.
The HTF bias gate above still applies in debate mode exactly as written: if
4H/1H bias is unclear, your argument to the Judge must be "HTF bias unclear —
phase call blocked," NOT a phase name with a confidence caveat attached. The
Judge cannot correct a wrong phase call after the fact, so blocking it here is
your job, not a soft flag for the Judge to notice. Do not manufacture a
phase call to sound useful.
Keep it to 3-6 sentences, data-dense.`;

// ── Power of 3's own graded trend read ───────────────────────────────────────
// 2026-07-29 (Anoop): "for directional bias change from 60 bars to 30 bars and
// use 4Hr not daily. i will manually read daily."
//
// Deliberately NOT reusing getTrendForTF() here: that reads TREND_BAR_COUNT
// (60) bars and its cache is shared with the Analysis tab's daily/1H reads
// (the "STRONG BEAR · 60b" display). Changing that constant to 30 would have
// silently re-graded the Analysis panel too, which Anoop did not ask for. So
// Power of 3 gets its own 30-bar read with its own cache, fully isolated.
//
// classifyTrendStrength() is the same grader the Analysis panel uses, so the
// label vocabulary (STRONG BEAR / BEAR / NEUTRAL / ...) stays consistent.
const PO3_TREND_BARS = 30;
const PO3_TREND_TTL_MS = 3 * 60 * 1000;
const po3TrendCache = {}; // tfCode -> { value, at }

async function po3TrendRead(tfCode) {
  const c = po3TrendCache[tfCode];
  if (c && Date.now() - c.at < PO3_TREND_TTL_MS) return c.value;
  try {
    const bars = await getFullBars(tfCode, PO3_TREND_BARS);
    if (!bars || bars.length < 5) {
      if (c) return c.value; // stale-but-real beats a false 'unclear'
      return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, bars: bars ? bars.length : 0 };
    }
    const trend = classifyTrendStrength(bars);
    trend.bars = bars.length;
    po3TrendCache[tfCode] = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error('[po3TrendRead ' + tfCode + '] error:', e.message);
    if (c) return c.value;
    return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, bars: 0 };
  }
}

// ── MECHANICAL AMD PHASE DETECTOR (no AI) ────────────────────────────────────
// 2026-07-29 (Anoop): "i want it to trigger me and give my an output in lower
// time frames as confirmation for my trade entry", polling every 60s, alert on
// ANY phase change.
//
// Deliberately NOT an LLM call per poll: at 60s that's ~60 Gemini requests an
// hour, which is exactly the quota exhaustion that took Jessi down twice. This
// is pure arithmetic on bars — free, instant, deterministic, and it produces
// the same A/M/D verdict the agent would. The LLM is only used afterwards to
// narrate a trigger that has already fired.
//
// Phase logic, from Anoop's ICT Power of 3 PDF:
//   ACCUMULATION  — price still inside the opening range built after session open
//   MANIPULATION  — that range broken AGAINST the 4H bias (liquidity swept)
//   DISTRIBUTION  — after such a sweep, price displaces back through the range
//                   in the direction OF the 4H bias
// Anything without an established 4H bias is UNCLEAR (the hard gate).
//
// `openingBars` = how many bars after session open define the accumulation
// range. 4 x 15m = the first hour of the session.
function computeAmdPhase(bars, biasDirection, sessionStartUnix, openingBars) {
  const out = { phase: 'UNCLEAR', reason: null, rangeHigh: null, rangeLow: null, sweptTo: null, detail: null };
  if (biasDirection !== 'bullish' && biasDirection !== 'bearish') {
    out.reason = '4H bias not established — gate blocks the phase call';
    return out;
  }
  if (!Array.isArray(bars) || !bars.length) {
    out.reason = 'no bars available';
    return out;
  }

  // Bars from the current session only.
  const sess = bars.filter(b => b && typeof b.time === 'number' && b.time >= sessionStartUnix);
  if (sess.length < 2) {
    out.reason = 'session just opened (fewer than 2 bars) — too early to judge';
    return out;
  }

  const nOpen = Math.max(1, openingBars || 4);
  const opening = sess.slice(0, nOpen);
  const rangeHigh = Math.max(...opening.map(b => b.high));
  const rangeLow = Math.min(...opening.map(b => b.low));
  out.rangeHigh = rangeHigh;
  out.rangeLow = rangeLow;

  // Still inside the opening window itself → by definition accumulating.
  if (sess.length <= nOpen) {
    out.phase = 'ACCUMULATION';
    out.reason = 'still inside the opening ' + nOpen + '-bar range (' + rangeLow + '–' + rangeHigh + ')';
    return out;
  }

  const after = sess.slice(nOpen);
  // On a bullish bias, manipulation runs DOWN (sweeps sell-side liquidity).
  // On a bearish bias, manipulation runs UP (sweeps buy-side liquidity).
  const sweepIsDown = biasDirection === 'bullish';

  let sweepIdx = -1, sweepExtreme = null;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (sweepIsDown && b.low < rangeLow) { sweepIdx = i; sweepExtreme = b.low; break; }
    if (!sweepIsDown && b.high > rangeHigh) { sweepIdx = i; sweepExtreme = b.high; break; }
  }

  if (sweepIdx === -1) {
    // No sweep against bias yet. If price has instead already run WITH bias
    // beyond the range, the session is distributing without a clean trap.
    const ranWithBias = sweepIsDown
      ? after.some(b => b.high > rangeHigh)
      : after.some(b => b.low < rangeLow);
    if (ranWithBias) {
      out.phase = 'DISTRIBUTION';
      out.reason = 'broke the opening range in the direction of 4H bias without a counter-sweep first — distributing, but no manipulation trap was set';
      return out;
    }
    out.phase = 'ACCUMULATION';
    out.reason = 'price still contained within the opening range (' + rangeLow + '–' + rangeHigh + '); no liquidity swept yet';
    return out;
  }

  out.sweptTo = sweepExtreme;

  // Sweep happened. Has price displaced back through the range with bias?
  const post = after.slice(sweepIdx + 1);
  const reclaimed = sweepIsDown
    ? post.some(b => b.close > rangeLow)   // bullish: closed back above the swept low
    : post.some(b => b.close < rangeHigh); // bearish: closed back below the swept high

  if (reclaimed) {
    out.phase = 'DISTRIBUTION';
    out.reason = 'liquidity swept to ' + sweepExtreme + ' (' + (sweepIsDown ? 'below' : 'above') +
      ' the opening range), then price closed back ' + (sweepIsDown ? 'above ' + rangeLow : 'below ' + rangeHigh) +
      ' — manipulation complete, distributing with 4H bias (' + biasDirection + ')';
    out.detail = 'ENTRY-RELEVANT: this is the reversal out of manipulation.';
    return out;
  }

  out.phase = 'MANIPULATION';
  out.reason = 'liquidity being swept to ' + sweepExtreme + ' (' + (sweepIsDown ? 'below' : 'above') +
    ' the opening range) against 4H bias (' + biasDirection + ') — trap in progress, no reclaim yet';
  out.detail = 'NOT yet an entry — wait for the close back inside the range.';
  return out;
}

// Unix timestamp for the start of the session window that is currently active
// (or most recently active) in IST. Returns null outside both windows.
// London 13:30 IST, NY 19:00 IST — matches rules.json sessionWindowsIST.
const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+5:30
function currentSessionStartUnix(nowMs) {
  const nowRealMs = (nowMs != null) ? nowMs : Date.now();
  // Shift into IST so getUTC* reads give IST wall-clock values.
  const istMs = nowRealMs + IST_OFFSET_MS;
  const ist = new Date(istMs);
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const rules = getActiveRules();
  const wins = (rules.sessionWindowsIST || []).slice().sort((a, b) => a.startMin - b.startMin);
  let active = null;
  for (const w of wins) {
    if (istMin >= w.startMin) active = w; // most recent window that has opened today
  }
  if (!active) return null;

  // BUG CAUGHT BY TEST (2026-07-29): the first version computed IST midnight
  // from `istMs` and returned it directly — but istMs is the SHIFTED clock, so
  // the result was 5h30m (19800s) ahead of the real unix time. That would have
  // made every phase read use the wrong session window, silently. Subtract the
  // offset to get back to real unix time before adding the window's start.
  const istMidnightShiftedMs = istMs
    - (istMin * 60 * 1000)
    - (ist.getUTCSeconds() * 1000)
    - ist.getUTCMilliseconds();
  const istMidnightRealUnix = Math.floor((istMidnightShiftedMs - IST_OFFSET_MS) / 1000);
  return istMidnightRealUnix + active.startMin * 60;
}

// ── Power of 3 phase monitor (60s, mechanical, alerts on ANY phase change) ───
// Anoop's spec 2026-07-29: poll every 60s, alert on any phase change, chat
// message. Reads 15m bars (his primary phase timeframe) and grades the phase
// with computeAmdPhase — no LLM per poll.
const PO3_MONITOR_INTERVAL_MS = 60 * 1000;
const PO3_OPENING_BARS = 4; // 4 x 15m = first hour after session open
const po3Monitor = {
  running: false,
  interval: null,
  lastPhase: null,
  lastSessionStart: null,
  lastSymbol: null,   // see symbol-change reset in checkPo3Phase
  lastCheck: null
};

// Whatever symbol is currently on Anoop's chart. The whole read path is
// symbol-agnostic (2026-07-29 audit: no hardcoded instrument anywhere in the
// data path), so this is purely so alerts can SAY which instrument they refer
// to — and so the monitor can reset its phase state when the symbol changes.
async function getCurrentChartSymbol() {
  try {
    const res = await mcpBridge.callTool('chart_get_state', {});
    const st = parseToolResult(res);
    return (st && (st.symbol || st.chart_symbol || st.ticker)) || null;
  } catch (e) {
    return null;
  }
}

async function checkPo3Phase() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'po3-monitor-check', time: new Date().toISOString(), status: 'TV offline' });
    return;
  }

  const sessionStart = currentSessionStartUnix();
  if (sessionStart == null) {
    // Outside both session windows — nothing to monitor (Core Rule #6).
    broadcast({ type: 'po3-monitor-check', time: new Date().toISOString(), status: 'outside session window' });
    po3Monitor.lastPhase = null;
    return;
  }

  // New session → reset so the first phase of the session announces itself.
  if (po3Monitor.lastSessionStart !== sessionStart) {
    po3Monitor.lastSessionStart = sessionStart;
    po3Monitor.lastPhase = null;
  }

  try {
    // SYMBOL-CHANGE RESET (2026-07-29). Anoop trades MNQ1! and MGC1! and wants
    // this to work on whatever he has open. The read path was already
    // symbol-agnostic, but the monitor's `lastPhase` was NOT: switching from
    // MNQ to MGC mid-session would have compared MGC's phase against MNQ's
    // remembered phase and fired a bogus transition alert (e.g. a fake
    // "MANIPULATION → DISTRIBUTION" that was really just a symbol change).
    // Reset phase state whenever the instrument changes, and stamp every alert
    // with the symbol so it's never ambiguous which instrument it refers to.
    const symbol = await getCurrentChartSymbol();
    if (symbol && po3Monitor.lastSymbol && symbol !== po3Monitor.lastSymbol) {
      console.log('[PO3 MONITOR] symbol changed ' + po3Monitor.lastSymbol + ' -> ' + symbol + ' — resetting phase state');
      po3Monitor.lastPhase = null;
    }
    if (symbol) po3Monitor.lastSymbol = symbol;

    // 4H bias must be per-symbol too — po3TrendRead caches by timeframe only,
    // so clear its cache on a symbol change to avoid grading MGC with MNQ's
    // cached 4H trend.
    if (po3Monitor.lastPhase === null && symbol) {
      // cheap targeted invalidation: only the TFs this monitor reads
      delete po3TrendCache['240'];
      delete po3TrendCache['60'];
    }

    const bias = await po3TrendRead('240');          // cached 3 min
    const bars = await getFullBars('15', 40);        // switches TF, auto-restores
    const res = computeAmdPhase(bars, bias && bias.direction, sessionStart, PO3_OPENING_BARS);
    po3Monitor.lastCheck = new Date().toISOString();

    broadcast({
      type: 'po3-monitor-check',
      time: po3Monitor.lastCheck,
      status: res.phase,
      phase: res.phase,
      symbol
    });

    if (res.phase !== po3Monitor.lastPhase) {
      const prev = po3Monitor.lastPhase;
      po3Monitor.lastPhase = res.phase;
      // Skip the very first read of a session if it's just UNCLEAR noise.
      if (!(prev === null && res.phase === 'UNCLEAR')) {
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const biasLabel = (bias && (bias.label || bias.direction)) || 'unknown';
        const symLabel = symbol ? String(symbol).replace(/^[A-Z_]+:/, '') : 'chart';
        const msg = 'POWER OF 3 [' + symLabel + ']' + (prev ? ' — ' + prev + ' → ' + res.phase : ' — ' + res.phase) +
          ' at ' + istTime + ' IST | 4H bias: ' + biasLabel +
          (res.rangeHigh != null ? ' | opening range ' + res.rangeLow + '–' + res.rangeHigh : '') +
          '\n' + res.reason + (res.detail ? '\n' + res.detail : '');
        broadcast({
          type: 'po3-phase-change',
          from: prev,
          to: res.phase,
          phase: res.phase,
          symbol,
          symLabel,
          bias: bias ? bias.direction : null,
          biasLabel,
          rangeHigh: res.rangeHigh,
          rangeLow: res.rangeLow,
          sweptTo: res.sweptTo,
          reason: res.reason,
          detail: res.detail,
          time: istTime,
          message: msg
        });
        console.log('[PO3 MONITOR][' + symLabel + '] ' + (prev || 'none') + ' -> ' + res.phase + ' | ' + res.reason);
      }
    }
  } catch (e) {
    console.error('[PO3 MONITOR] error:', e.message);
    broadcast({ type: 'po3-monitor-check', time: new Date().toISOString(), status: 'error: ' + e.message });
  }
}

function startPo3Monitor() {
  if (po3Monitor.running) return;
  po3Monitor.running = true;
  po3Monitor.lastPhase = null;
  broadcast({ type: 'po3-monitor-status', running: true });
  checkPo3Phase();
  po3Monitor.interval = setInterval(checkPo3Phase, PO3_MONITOR_INTERVAL_MS);
  console.log('Power of 3 monitor started (60s, mechanical)');
}

function stopPo3Monitor() {
  if (po3Monitor.interval) { clearInterval(po3Monitor.interval); po3Monitor.interval = null; }
  po3Monitor.running = false;
  broadcast({ type: 'po3-monitor-status', running: false });
  console.log('Power of 3 monitor stopped');
}

// Gathers multi-timeframe bars for the AMD read. Uses market_multi_tf, which
// switches timeframes and AUTO-RESTORES the original — important because this
// drives Anoop's live chart and must not leave it on the wrong TF mid-session.
async function gatherPO3Context() {
  const parts = [];
  if (!(mcpBridge.ready && mcpBridge.tvConnected)) {
    return '## CHART DATA: UNAVAILABLE (TradingView not connected) — cannot judge phase.';
  }
  try {
    const [state, quote, levels] = await Promise.all([
      mcpBridge.callTool('chart_get_state', {}).catch(() => null),
      mcpBridge.callTool('quote_get', {}).catch(() => null),
      mcpBridge.callTool('market_key_levels', {}).catch(() => null)
    ]);
    const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
    parts.push('## CURRENT CHART');
    parts.push('State: ' + txt(state));
    parts.push('Quote: ' + txt(quote));
    parts.push('Key levels (liquidity pools — PDH/PDL, swings, zones): ' + txt(levels));
  } catch (e) {
    parts.push('## CURRENT CHART: fetch failed (' + e.message + ')');
  }

  // Multi-timeframe bars. TF codes are plain minute strings — '240'/'60'/'15'/'5'.
  // VERIFICATION NOTE (2026-07-28): originally wrote '1D' for the daily anchor,
  // but every timeframe code proven to work in this file is a minute number
  // ('15'/'30'/'60'/'240' — see engulf/FVG monitor configs and get4HTrend).
  // '1D' was an unverified guess; TradingView daily codes vary ('D' vs '1D')
  // and a wrong code returns nothing silently. Using the PROVEN '240' (4H) as
  // the higher-timeframe bias anchor instead — it fills the same role, and the
  // mechanical 4H trend below corroborates it.
  // 2026-07-29 (Anoop): 4H dropped, 1H is now the higher-timeframe anchor for
  // Power of 3. AMD phases are session-scale events — a 4H candle is too coarse
  // to frame them (one 4H bar can contain the entire accumulation AND the
  // manipulation sweep), so 1H is the tightest useful HTF frame here. Daily
  // still supplies the directional bias via the MECHANICAL HTF BIAS block below.
  const PO3_TFS = ['60', '15', '5'];
  const PO3_LABELS = {
    '60':  '1H — higher-TF anchor (structure / liquidity pools)',
    '15':  '15-MIN — PRIMARY phase read (weight most)',
    '5':   '5-MIN — PRIMARY trigger read (displacement / FVG)'
  };
  try {
    const res = await mcpBridge.callTool('market_multi_tf', {
      timeframes: PO3_TFS,
      collect: ['ohlcv_summary']
    });
    const data = parseMultiTFResult(res);
    if (data) {
      parts.push('\n## MULTI-TIMEFRAME BARS (most recent last)');
      for (const tf of PO3_TFS) {
        const bars = getBarsFromMultiTF(data, tf);
        parts.push('\n### ' + PO3_LABELS[tf]);
        parts.push(bars && bars.length ? JSON.stringify(bars) : 'no bars returned for this timeframe');
      }
    } else {
      parts.push('\n## MULTI-TIMEFRAME BARS: could not parse result');
    }
  } catch (e) {
    parts.push('\n## MULTI-TIMEFRAME BARS: failed (' + e.message + ')');
  }

  // BIAS SOURCE — FIXED 2026-07-29. This previously called ONLY get4HTrend(),
  // which classifies just 5 bars of 4H with a 60%-of-bars threshold. That
  // returns 'unclear' in almost any non-trending market, so the HTF gate was
  // firing permanently and Power of 3 answered "PHASE: UNCLEAR" every single
  // time — exactly what Anoop reported ("power of 3 always unclear").
  // The app already computes a far better bias via getTrendForTF(), which
  // grades ~60 bars and produces the "STRONG BEAR · 60b" read shown in the
  // Analysis tab. That richer signal was being computed and displayed but
  // never handed to this agent. Feeding Daily + 1H now, with labels/scores,
  // so the gate has a real bias to work with instead of a near-permanent
  // 'unclear'. Daily is primary (matches Core Rule #1: Daily sets bias).
  try {
    const [h4Read, hourRead] = await Promise.all([
      po3TrendRead('240').catch(() => null),
      po3TrendRead('60').catch(() => null)
    ]);
    parts.push('\n## MECHANICAL BIAS (computed by the app, no AI — this is your bias source)');
    if (h4Read) {
      parts.push('4H (BIAS GATE): ' + (h4Read.label || h4Read.direction) +
        ' | direction=' + h4Read.direction +
        ' | score=' + (h4Read.score != null ? h4Read.score : 'n/a') +
        ' | bars=' + (h4Read.bars || 'n/a') +
        (h4Read.detail ? ' | ' + h4Read.detail : ''));
    } else {
      parts.push('4H (BIAS GATE): unavailable');
    }
    if (hourRead) {
      parts.push('1H: ' + (hourRead.label || hourRead.direction) +
        ' | direction=' + hourRead.direction +
        ' | score=' + (hourRead.score != null ? hourRead.score : 'n/a') +
        ' | bars=' + (hourRead.bars || 'n/a'));
    } else {
      parts.push('1H: unavailable');
    }
    const bDir = h4Read && h4Read.direction;
    const biasOk = bDir === 'bullish' || bDir === 'bearish';
    parts.push('GATE: 4H bias is ' + (biasOk ? 'ESTABLISHED (' + bDir + ') — proceed to read the phase on 15m/5m'
                                             : 'NOT established — phase call must be UNCLEAR'));
    parts.push('NOTE: Daily is deliberately NOT provided — Anoop reads the daily candle himself. Do not claim a daily read.');
  } catch (e) {
    parts.push('\n## MECHANICAL BIAS: failed to read (' + e.message + ')');
  }

  // Session context — accumulation is defined relative to the session open.
  const istNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  parts.push('\n## TIME: ' + istNow + ' IST (London 13:30-15:00, NY 19:00-21:00 IST)');

  return parts.join('\n');
}

async function handleIctPo3(ws, msg) {
  const { reqId, question } = msg;
  try {
    send(ws, { type: 'po3-status', reqId, phase: 'gathering' });
    const dataContext = await gatherPO3Context();
    send(ws, { type: 'po3-status', reqId, phase: 'analyzing' });

    const userMsg = (question && String(question).trim())
      ? String(question).trim() + '\n\nLIVE DATA:\n' + dataContext
      : 'Judge the current AMD phase from this live data.\n\n' + dataContext;

    await groqAgent.stream(
      [{ role: 'user', content: userMsg }],
      ICT_PO3_PERSONA,
      [],
      {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        temperature: 0.4,
        fallbackChain: [
          { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
          { provider: 'gemini', model: 'gemini-2.5-flash' },
          { provider: 'groq',   model: 'openai/gpt-oss-20b' }
        ],
        onToken: (text) => send(ws, { type: 'po3-token', reqId, text }),
        onDone:  (fullText) => send(ws, { type: 'po3-done', reqId, fullText }),
        onError: (errMsg) => send(ws, { type: 'po3-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleIctPo3] uncaught error:', e);
    send(ws, { type: 'po3-error', reqId, message: e.message || 'Power of 3 analysis failed.' });
  }
}

// ── Read-aloud (replay any chat message as speech) ───────────────────────────────
// 2026-07-28: Anoop wants a speaker button on chat messages so he can replay
// Jessi's coaching/analysis out loud instead of re-reading it — helps the
// psychology side actually land, and costs ZERO LLM tokens since it's pure
// text-to-speech on text that was already generated. Reuses the exact same
// Edge TTS neural pipeline (en-IN-NeerjaNeural, Indian female voice) already
// wired for voice mode — no new dependency, no new voice to configure.
// Second line of defense for "don't read symbols" — app.js already sanitizes
// before sending, but any future caller that hits this handler directly
// (skipping the button) gets the same treatment here rather than relying on
// the client to always remember to do it.
// Timestamp of the last Edge TTS failure — drives the circuit-breaker in
// handleTtsSpeak so a known-dead endpoint isn't retried on every click.
let edgeFailedAt = 0;

function sanitizeForSpeechServer(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[#*_`~|>]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function handleTtsSpeak(ws, msg) {
  const { text, voice, reqId } = msg;
  const clean = sanitizeForSpeechServer(text);
  if (!clean) {
    send(ws, { type: 'tts-result', reqId, ok: false, error: 'Nothing to speak.' });
    return;
  }

  // THREE-TIER TTS (2026-07-28). Anoop hit a hard 403 mid-session because
  // Edge TTS is an unofficial Microsoft endpoint that they changed under us.
  // Tier 1 = Edge (best voice, but not ours to rely on).
  // Tier 2 = local Windows SAPI (offline, cannot be revoked) — the tier that
  //          makes this actually dependable during trading hours.
  // Tier 3 = browser speechSynthesis, handled client-side in app.js if this
  //          whole handler reports failure.
  let lastErr = null;

  // EDGE CIRCUIT-BREAKER (2026-07-28). Anoop's diagnostic came back
  // edge='FAIL: 403', local='OK'. Edge is an unofficial endpoint Microsoft has
  // locked down; when it's failing it fails EVERY time, and waiting for that
  // round-trip before falling through to the local voice added a needless
  // delay to every single click. After a failure we skip Edge entirely for
  // EDGE_COOLDOWN_MS and go straight to the local Windows voice, then re-probe
  // once the cooldown lapses in case Microsoft (or a future fix) restores it.
  const EDGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
  const edgeInCooldown = edgeFailedAt && (Date.now() - edgeFailedAt) < EDGE_COOLDOWN_MS;

  if (!edgeInCooldown) {
    try {
      const clips = await edgeTts.synthesizeClips(clean.slice(0, 8000), voice || edgeTts.DEFAULT_VOICE);
      edgeFailedAt = 0; // recovered
      send(ws, { type: 'tts-result', reqId, ok: true, clips, mime: 'audio/mpeg', engine: 'edge' });
      return;
    } catch (e) {
      lastErr = e;
      edgeFailedAt = Date.now();
      console.error('[handleTtsSpeak] Edge TTS failed (' + e.message + ') — using local Windows voice, skipping Edge for 30 min.');
    }
  }

  try {
    if (localTts.isAvailable()) {
      const clips = await localTts.synthesizeClips(clean.slice(0, 8000));
      send(ws, { type: 'tts-result', reqId, ok: true, clips, mime: localTts.MIME, engine: 'local' });
      return;
    }
  } catch (e) {
    lastErr = e;
    console.error('[handleTtsSpeak] local Windows TTS also failed:', e.message);
  }

  send(ws, {
    type: 'tts-result', reqId, ok: false,
    error: 'Server voices unavailable (' + ((lastErr && lastErr.message) || 'unknown') + ')'
  });
}

// ── Post-Session Analyst (standalone agent, auto-fires after CSV ingest) ────────
// 2026-07-28. Reads ALL data across every tab and agent, produces a structured
// post-session review: plan adherence, rule compliance, positives, negatives,
// and concrete next-session guidance. Runs on Gemini, no tools, no debate overhead.

const POST_SESSION_ANALYST_PERSONA = `You are the POST-SESSION ANALYST for Anoop Habib's MNQ/MGC prop trading co-pilot app.

## YOUR ROLE
You fire AFTER a trading session is over and Anoop has uploaded his Performance CSV. Your job is a forensic, numbers-first breakdown of the session. You are NOT a coach or cheerleader — you are an auditor who also gives forward-looking guidance.

## OUTPUT FORMAT (strict, always follow this order)
1. **SESSION SUMMARY** — date, instrument, session window (London/NY), trade count, gross P&L, net P&L (after commission), max intraday drawdown, win rate.
2. **PLAN ADHERENCE** — Did Anoop write a pre-committed A+ cap before the session? Did he stay inside it? Grade: PASS or FAIL. (Rule #13 & #14: the plan-adherence grade overrides P&L — a green day that broke the cap is a FAIL.)
3. **RULE-BY-RULE COMPLIANCE** — Go through every applicable rule and score it:
   - Max 2 contracts per entry (rule #2)
   - Daily loss tiers: yellow/red/hard (rule #3)
   - Trade count: per-session (5 qualifying) and per-day (10) (rule #5)
   - Session window compliance (rule #6)
   - 15-minute break between trades (rule #7)
   - Pre-marked zones (rule #8)
   - One instrument per day (rule #9)
   - No sizing up while day is negative (rule #2 enforcement addendum)
   Mark each: ✅ COMPLIANT, ⚠️ PARTIAL, or 🚨 VIOLATED — with the specific data point (timestamp, trade #, size) that proves it.
4. **POSITIVES** — What went right, with evidence. Even on bad days, find the process wins.
5. **NEGATIVES** — What went wrong, with evidence. No softening. Cite the exact trade(s).
6. **PATTERN CHECK** — Compare today against Anoop's 6 documented failure modes (trade count escalation, revenge clusters, inverted R:R, holding losers, multi-instrument, accounts up-then-crashed). Flag ANY match.
7. **NEXT SESSION GUIDANCE** — 2-3 concrete, actionable items for tomorrow. Not platitudes — specific behavioral instructions tied to what you found above. If today was a FAIL, the first item should address the primary failure mode.

## RULES
- Reference actual numbers from the data — timestamps, P&L, sizes, hold times. No generalizing.
- If data is missing for a check, say "DATA MISSING — cannot verify" rather than guessing.
- Commission estimate: $0.59/contract/side (from rules.json).
- The trader has blown 16 accounts with $0 payouts lifetime. Zero margin for error in your assessment.
- Do NOT give investment advice or trade recommendations. You analyze the session that already happened.
- Keep the entire review under 600 words. Dense, not padded.`;

async function handlePostSessionReview(ws, msg) {
  const { reqId } = msg;

  // BUGFIX (2026-07-28): same top-level try/catch fix as handleDebateChat —
  // no throw in here used to reach the client, leaving the UI stuck on the
  // stop icon until the client's 5-min timeout fired.
  try {
    send(ws, { type: 'post-review-status', reqId, phase: 'gathering' });

    // Gather ALL data
    const parts = [];

    // Rules
    const rules = getActiveRules();
    parts.push('## ACTIVE RULES (rules.json)\n' + JSON.stringify(rules, null, 2));

    // Full account + trade + insights data
    const appData = jessiAppGetData('all');
    if (appData) parts.push('\n## FULL ACCOUNT & TRADE DATA\n' + appData);

    // Jessi context (journal, recent history)
    const jessiCtx = buildJessiContext();
    if (jessiCtx) parts.push('\n## JESSI CONTEXT (journal, recent history)\n' + jessiCtx);

    // Scalper's notebook (2026-08-01) — the Scalper agent records durable
    // per-day/per-trade behavioural notes during video reviews. Feeding them
    // in here is what makes the agents coordinate instead of each starting
    // from zero: the analyst can cite a pattern the Scalper already named.
    try {
      const scalpNotes = scalperNotesRead(null, 7);
      if (scalpNotes && !/^No scalper notes/.test(scalpNotes)) {
        parts.push('\n## SCALPER AGENT NOTES (behavioural observations from video reviews)\n' + scalpNotes);
      }
    } catch (e) {}

    // TradingView cache (end-of-session chart state)
    if (jessiTVCache.text) {
      const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
      parts.push('\n## CHART STATE (cached, ' + ageSec + 's old)\n' + jessiTVCache.text);
    }

    // Session history (prior sessions for pattern comparison)
    try {
      const sessDir = path.join(DATA_DIR, 'sessions');
      if (fs.existsSync(sessDir)) {
        const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).sort().slice(-5);
        const recent = files.map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); }
          catch { return null; }
        }).filter(Boolean);
        if (recent.length) parts.push('\n## RECENT SESSION HISTORY (last ' + recent.length + ')\n' + JSON.stringify(recent, null, 2));
      }
    } catch (e) {}

    const dataContext = parts.join('\n');

    send(ws, { type: 'post-review-status', reqId, phase: 'analyzing' });

    // Stream the review
    await groqAgent.stream(
      [{ role: 'user', content: 'Analyze my just-completed trading session. Here is ALL the data:\n\n' + dataContext }],
      POST_SESSION_ANALYST_PERSONA,
      [], // no tools
      {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        temperature: 0.8,
        fallbackChain: [
          { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
          { provider: 'gemini', model: 'gemini-2.5-flash' },
          { provider: 'groq',   model: 'openai/gpt-oss-20b' }
        ],
        onToken:  (text) => send(ws, { type: 'post-review-token', reqId, text }),
        onDone:   (fullText) => {
          send(ws, { type: 'post-review-done', reqId, fullText });
          saveReviewRecord('post-session', fullText, {});
        },
        onError:  (errMsg) => send(ws, { type: 'post-review-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handlePostSessionReview] uncaught error:', e);
    send(ws, { type: 'post-review-error', reqId, message: e.message || 'Post-session review failed unexpectedly.' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SCALPER — dedicated scalping specialist agent (added 2026-08-01)
// ═══════════════════════════════════════════════════════════════════════════════
// Anoop's brief: an expert who "understands human greed of trading" but ALSO
// has real scalper competence, so it can identify the GAP between the two —
// specifically the gap between the levels he picks as an analyst (which are
// usually fine) and the size/hold/re-entry decisions he makes as a trader
// (which are what actually blow the accounts).
//
// Persona core is grounded in researched scalping practice (NinjaTrader's 10
// futures scalping principles, TradeAlgo's ES scalping guide, ForTraders'
// scalping strategy guide, plus the behavioural-finance literature on the
// disposition effect — Odean 1998, Barber & Odean 2000) rather than invented
// coaching platitudes. Key sourced facts embedded below:
//   - Scalping needs a HIGH win rate to survive commissions: ~60%+. A 55% win
//     rate on 4-tick stops LOSES money after commissions (TradeAlgo). So a
//     "good win rate" is not proof of edge on its own.
//   - Disposition effect: traders sell winners ~50% more readily than losers
//     (Odean 1998) and hold losers ~1.5x longer than winners. Cutting winners
//     early is an EMOTIONAL act, not a technical one.
//   - Time stop belongs alongside the price stop — the "it's not a scalp
//     anymore" rule. A scalp that has outlived its thesis is a different,
//     unplanned trade you never agreed to take.
//   - Fixed fractional sizing per scalp; the math is trivial, the discipline
//     is the hard part. Size is decided BEFORE the session, never live.
//   - Overtrading after losses is the single most-cited scalper killer.
//   - "Knowing when NOT to trade" is listed as a core skill, not a fallback.
const SCALPER_PERSONA = `You are THE SCALPER — Anoop Habib's specialist scalping coach inside his MNQ Co-Pilot app. You are not Jessi (the general accountability coach) and not the Post-Session Analyst (the forensic auditor). You are the one who understands the CRAFT of scalping AND the greed that destroys it, and your entire value is in spotting the gap between the two in Anoop specifically.

## WHO ANOOP IS (do not forget any of this)
- Trades MNQ/MGC micros on a Lucid prop account from Hubballi, India (IST). Currently a $50K EVALUATION, slot s1.
- Has blown 17 prop accounts lifetime. $0 payouts ever. Net position roughly -$10,784.
- EVERY blow-up died the same way: trade-count escalation, revenge re-entries within minutes, sizing UP while already down, holding losers, trading both instruments in one day, and giving back gains after being green.
- ~83% of his trades are scalps (under 10 minutes). The app runs a Scalper Mode with its own ruleset for exactly this reason.
- He is a COMPETENT ANALYST and a POOR RISK MANAGER. This is the central fact about him. His marked levels, zones and bias work are usually reasonable. His size, his re-entry timing, and his hold discipline are what kill him. Do not spend your time re-teaching him chart reading — spend it on the execution gap.

## THE GAP YOU EXIST TO CLOSE
On the analyst side he asks "where is price likely to go?" On the trader side he asks "how do I get that money back / how much can I get out of this?" The second question is greed wearing the costume of conviction. Your job every single time: separate the level from the size, and the thesis from the urgency. A correct level taken at 4 contracts 11 seconds after a loss is NOT a good trade that happened to be big — it is a bad trade that happened to be right.

## WHAT YOU KNOW ABOUT SCALPING (use this, it is sourced, not invented)
1. **Scalping requires a genuinely high win rate to clear costs.** ~60%+ is the working threshold; a 55% win rate on 4-tick stops actually loses money after commissions. So never congratulate him on a win rate alone — check it against hold time, size consistency, and commission drag before calling it edge.
2. **Time stop sits alongside the price stop.** The "it's not a scalp anymore" rule: if a scalp has outlived its thesis window, it has silently become a different trade he never planned. Exit on time, not on hope. In Scalper Mode the app's max hold is 30 minutes — anything past that is flagged hold-exceeded.
3. **The disposition effect is measurable and he has it.** Traders sell winners roughly 50% more readily than losers, and hold losers about 1.5x longer than winners. Cutting a winner early is an emotional act, not a technical one. When you see small avg-win against large avg-loss, name it as this, by name.
4. **Size is decided before the session, never live.** Fixed sizing per scalp. The arithmetic is trivial; the discipline is the entire game. Any size chosen DURING a session is an emotional number, no matter how it is justified afterwards.
5. **Overtrading after losses is the single most-cited scalper killer.** Not a style issue — the mechanism of ruin.
6. **Knowing when NOT to trade is a core skill, not a fallback.** Flat is a position. No setup is information, not failure.
7. **Execution consistency is what makes performance data meaningful at all.** If his size and hold vary trade to trade, his stats measure nothing and no edge can ever be proven or disproven.

## HOW YOU BEHAVE
- **Lead with the uncomfortable thing.** First line names the worst pattern in the data, not a greeting and not a positive.
- **Always cite trade numbers.** The Journal table is numbered (#1, #2, #3...). Say "trade 6" and "trade 7", never "that one short". He reads along with the numbers.
- **Green P&L is not a defence.** Per his own rule #14 a green day with a broken plan is a FAILED session, full stop. When the market rewarded a violation, say plainly that the reward is the danger — it is the reinforcement that trains the next blow-up. This is the most important thing you do.
- **Separate "was the level right" from "was the trade right".** Grade them independently, every time. He is allowed to be right about direction and still have taken a bad trade. Tell him which of the two failed.
- **Be specific about the fix.** Not "size down" but "trades 6 and 7 were 4 contracts against your 2-cap, taken 40s and 11s after a loss — the fix is the 15-minute timer, not smaller size, because size was a symptom of the re-entry urge."
- **Never help him rationalise.** "High conviction", "it was a clean setup", "I was already in profit", "I only need one more" — every one of these is the sound of the thing that blew 17 accounts. Name it as such, calmly, without moralising.
- **Do not be cruel and do not be soft.** You are an expert peer who takes him seriously enough to be blunt. No lectures, no shaming, no cheerleading.

## YOUR HARD ENFORCEMENT DUTIES
You must proactively call a STOP when you see any of these in the data or in what he tells you:
- Size above the active size cap (read it live from rules — never assume the number).
- ANY size increase relative to the previous trade while the day's running P&L is negative. This is the exact pattern that breached the $150K eval on 2026-07-21. It is a hard stop, not a caution.
- Re-entry inside the cooldown window (15 minutes; in Scalper Mode, after losses specifically).
- Trade count past the per-session or per-day cap.
- Both MNQ and MGC touched on the same day.
- Trading outside the London/NY session windows.
- Continuing after the daily loss tier is hit.
When you call a stop, state the rule, the evidence (trade number + timestamp + number), and what he does right now. Then stop talking. Do not soften it with a compliment afterwards.

## TOOLS
- app_get_data("scalp") — per-day hold times, median gaps, cooldown breaches, trade counts. Your primary data source. Call it before any per-day claim.
- app_get_data("trades") / ("insights") / ("status") — per-trade detail, discipline history, live account state and the ACTIVE rule numbers.
- scalp_note_add — record a durable note about a specific day or trade (behaviour observed, pattern, agreed fix). Use this whenever Anoop reviews session video with you, so the observation survives the chat.
- scalp_note_get — read back prior notes. ALWAYS call this before giving feedback on a new session, so you can say "this is the third time" instead of treating every day as new. Repetition across days is your strongest evidence.
- search_books — ground a point in his own trading library when it genuinely helps.

## OUTPUT
Compact. Trade-numbered. Evidence attached to every claim. No headers unless he asks for a full report. If you are guessing, say you are guessing.`;

// Per-account scalper notebook. Key routes to accounts/<slot>/scalper_notes.json
// via dataPathFor()'s '<key>__<slotId>' convention, so notes never leak between
// accounts (same isolation rule as gr_history/day_trades).
function scalperNotesKey() {
  const cfg = loadConfig();
  const slot = cfg.activeSlotId;
  return slot ? ('scalper_notes__' + slot) : 'scalper_notes';
}
function scalperNotesLoad() {
  return dataLoad(scalperNotesKey()) || { days: {} };
}
function scalperNotesAdd(date, entry) {
  const store = scalperNotesLoad();
  if (!store.days) store.days = {};
  if (!store.days[date]) store.days[date] = [];
  store.days[date].push(Object.assign({ ts: new Date().toISOString() }, entry));
  // Keep the notebook bounded — 120 most recent days.
  const keys = Object.keys(store.days).sort();
  while (keys.length > 120) { delete store.days[keys.shift()]; }
  dataSave(scalperNotesKey(), store);
  return store.days[date].length;
}
function scalperNotesRead(dateFilter, limitDays) {
  const store = scalperNotesLoad();
  const days = store.days || {};
  if (dateFilter) {
    const list = days[dateFilter] || [];
    if (!list.length) return `No scalper notes recorded for ${dateFilter}.`;
    return `SCALPER NOTES — ${dateFilter} (${list.length}):\n` + list.map((n, i) =>
      `${i + 1}. [${n.kind || 'note'}${n.trade != null ? ' · trade #' + n.trade : ''}] ${n.text}`).join('\n');
  }
  const dates = Object.keys(days).sort().slice(-(limitDays || 10));
  if (!dates.length) return 'No scalper notes recorded yet for this account.';
  const out = [`SCALPER NOTES — last ${dates.length} day(s) with notes:`];
  dates.forEach(d => {
    out.push(`\n${d}:`);
    (days[d] || []).forEach((n, i) => out.push(`  ${i + 1}. [${n.kind || 'note'}${n.trade != null ? ' · trade #' + n.trade : ''}] ${n.text}`));
  });
  return out.join('\n');
}

// Scalper's tool set — app data (incl. the scalp section) + its own notebook +
// the book library. Deliberately NO chart-drawing and NO trade execution: this
// agent reviews and enforces, it does not touch the market or the chart.
const SCALPER_TOOLS = [
  { type: 'function', function: {
    name: 'app_get_data',
    description: 'Read live data for the account currently open. Sections: "scalp" (PER-DAY hold times, median inter-trade gap, cooldown breaches, trade counts, hold-exceeded — your primary source, call this first for any per-day claim), "trades" (last 12 individual trades with side/size/entry/P&L/hold/flags), "insights" (discipline %, revenge count, over-cap count, giveback, per-day history), "status" (balance, floor, target, and the ACTIVE rule numbers — always read the size cap and loss tiers from here rather than assuming), "checklist", "roadmap", "cost", "all".',
    parameters: { type: 'object', properties: { section: { type: 'string', enum: ['scalp', 'trades', 'insights', 'status', 'checklist', 'roadmap', 'cost', 'all'] } }, required: ['section'] }
  } },
  { type: 'function', function: {
    name: 'scalp_note_add',
    description: 'Record a durable scalping note for a specific date, optionally tied to a specific trade number from the Journal table. Use this whenever you and Anoop review session video or discuss a specific trade, so the observation persists beyond this chat and can be cited on later days. Kinds: "behaviour" (what he did and the emotional driver), "pattern" (a repeating tendency across days), "fix" (the concrete agreed change), "level" (analysis-quality observation about the level/zone he chose).',
    parameters: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD the note is about' },
      kind: { type: 'string', enum: ['behaviour', 'pattern', 'fix', 'level'] },
      trade: { type: 'number', description: 'optional 1-based trade number from the Journal table' },
      text: { type: 'string', description: 'the note itself — specific and evidence-bearing, not vague' }
    }, required: ['date', 'kind', 'text'] }
  } },
  { type: 'function', function: {
    name: 'scalp_note_get',
    description: 'Read back previously recorded scalper notes. Call this BEFORE giving feedback on a new session so you can identify repeats across days ("third time this week") rather than treating each day as isolated. Omit date to get the last several days of notes.',
    parameters: { type: 'object', properties: {
      date: { type: 'string', description: 'optional YYYY-MM-DD; omit for recent days' },
      days: { type: 'number', description: 'optional number of recent days to return (default 10)' }
    }, required: [] }
  } },
  { type: 'function', function: {
    name: 'search_books',
    description: 'Search Anoop\'s trading book library (Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp\'s Guide to Proprietary Trading) for relevant passages when grounding a coaching point in a specific author helps more than your own framing.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, book: { type: 'string' } }, required: ['query'] }
  } }
];

function makeScalperToolExecutor() {
  return async (name, args) => {
    if (name === 'app_get_data') return jessiAppGetData((args && args.section) || 'scalp');
    if (name === 'scalp_note_add') {
      if (!args || !args.date || !args.text) return 'scalp_note_add needs at least "date" and "text".';
      const n = scalperNotesAdd(args.date, { kind: args.kind || 'note', trade: args.trade, text: args.text });
      return `Saved. ${args.date} now has ${n} scalper note(s) on file.`;
    }
    if (name === 'scalp_note_get') return scalperNotesRead(args && args.date, args && args.days);
    if (name === 'search_books') {
      const query = (args && args.query) || '';
      if (!query.trim()) return 'search_books needs a "query".';
      const results = booksIndex.searchBooks(query, { limit: 4, book: (args && args.book) || null });
      if (!results.length) return `No passages found for "${query}".`;
      return results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
    }
    return `Unknown tool "${name}".`;
  };
}

// ── Handler: Scalper chat ──────────────────────────────────────────────────────
// Same streaming/fallback shape as handleJessiChat and handlePostSessionReview.
// Seeds the turn with live scalp data + prior notes so the agent starts already
// knowing the numbers instead of burning a tool round-trip on every message.
async function handleScalperChat(ws, msg) {
  const { reqId, messages } = msg;
  try {
    const seed = [];
    try {
      const rules = getActiveRules();
      seed.push('## ACTIVE RULES (live — use these numbers, do not assume)\n'
        + `mode: ${rules.tradingMode || 'standard'} · sizeCap: ${rules.sizeCap} · tradesPerSession: ${rules.tradesPerSession} · tradesPerDay: ${rules.tradesPerDay}`
        + ` · lossTiers: ${rules.dailyLossTiers.yellow}/${rules.dailyLossTiers.red}/${rules.dailyLossTiers.hard}`
        + ` · cooldownMinutes: ${rules.cooldownMinutes}${rules.maxHoldSeconds ? ' · maxHoldSeconds: ' + rules.maxHoldSeconds : ''}`);
    } catch (e) {}
    try { seed.push('\n## SCALP STATS (per day)\n' + jessiAppGetData('scalp')); } catch (e) {}
    try { seed.push('\n## RECENT TRADES\n' + jessiAppGetData('trades')); } catch (e) {}
    try { seed.push('\n## YOUR PRIOR NOTES\n' + scalperNotesRead(null, 10)); } catch (e) {}

    const seeded = [{ role: 'user', content: 'CONTEXT (auto-attached, not typed by Anoop):\n' + seed.join('\n') }]
      .concat(Array.isArray(messages) ? messages : []);

    await groqAgent.stream(
      seeded,
      SCALPER_PERSONA,
      SCALPER_TOOLS,
      {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        temperature: 0.7,
        fallbackChain: [
          { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
          { provider: 'gemini', model: 'gemini-2.5-flash' },
          { provider: 'groq',   model: 'openai/gpt-oss-20b' }
        ],
        toolExecutor: makeScalperToolExecutor(),
        onToken: (text) => send(ws, { type: 'scalper-token', reqId, text }),
        onToolStart: (name) => send(ws, { type: 'scalper-tool', reqId, name, phase: 'start' }),
        onToolDone:  (name) => send(ws, { type: 'scalper-tool', reqId, name, phase: 'done' }),
        onDone: (fullText) => {
          send(ws, { type: 'scalper-done', reqId, fullText });
          saveReviewRecord('scalper', fullText, {});
        },
        onError: (errMsg) => send(ws, { type: 'scalper-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleScalperChat] uncaught error:', e);
    send(ws, { type: 'scalper-error', reqId, message: e.message || 'Scalper chat failed unexpectedly.' });
  }
}

// ── Handler: Jessi voice mode (voice in, voice out) ─────────────────────────────
// Added 2026-07-23. Reuses the exact same JESSI_PERSONA/context/tool pipeline
// as handleJessiChat above — voice is purely an I/O wrapper around the same
// brain, not a second Jessi. Flow: browser records mic audio with client-side
// silence detection (3-4s) → sends one WS message with the clip → this
// transcribes it (Whisper), runs it through the normal Jessi turn, then
// synthesizes the reply (Orpheus) and ships back base64 WAV clips for the
// client to play. No tokens are streamed mid-turn in voice mode (nothing to
// caption live-word-by-word usefully while waiting on audio synthesis
// anyway) — client gets transcript + full reply + audio in two messages.
async function handleJessiVoiceSend(ws, msg) {
  const { reqId, audioBase64, mimeType, messages } = msg;
  // 2026-07-23: two input paths now.
  //  (a) msg.transcript present → browser already did STT (Web Speech API,
  //      free/unlimited) — skip Groq Whisper entirely.
  //  (b) audioBase64 present → legacy path, Groq Whisper transcribes.
  // And msg.clientTts:true → the browser will speak the reply with its own
  // speechSynthesis (free/unlimited, Indian voice available) — so we skip the
  // Groq Orpheus call and just return the reply text. This removes 2 of the 3
  // Groq calls per turn, which is what was burning the daily token budget.
  const clientTts = msg.clientTts === true;
  try {
    // 2026-07-25: this used to hard-require a Groq key for ANY voice turn.
    // That became wrong once Gemini became the default brain: if the browser
    // does STT (msg.transcript) and TTS (clientTts), a voice turn needs no
    // Groq call at all, so a Gemini-only setup should work. Now only demands
    // a Groq key for the parts that genuinely still go through Groq —
    // server-side Whisper STT, server-side Orpheus TTS, or a Groq brain.
    const needsGroqStt = !(typeof msg.transcript === 'string' && msg.transcript.trim());
    const needsGroqTts = !clientTts;
    const brainIsGroq = (loadConfig().voiceBrain || 'gemini') === 'groq';
    if ((needsGroqStt || needsGroqTts || brainIsGroq) && !groqAgent.isReady()) {
      const why = needsGroqStt ? 'speech-to-text' : needsGroqTts ? 'speech playback' : 'the Groq voice brain';
      send(ws, { type: 'jessi-voice-error', reqId, message: `Groq API key needed for ${why}. Add a free key from console.groq.com in Settings (or switch the voice brain to Gemini and let the browser handle speech).` });
      return;
    }
    if (!brainIsGroq && !groqAgent.isGeminiReady() && !groqAgent.isReady()) {
      send(ws, { type: 'jessi-voice-error', reqId, message: 'No AI key configured. Add a free Gemini key (aistudio.google.com/apikey) or Groq key in Settings.' });
      return;
    }

    let transcript;
    if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
      transcript = msg.transcript.trim();
    } else {
      const audioBuffer = Buffer.from(audioBase64 || '', 'base64');
      if (!audioBuffer.length) {
        send(ws, { type: 'jessi-voice-error', reqId, message: 'No speech received — try again.' });
        return;
      }
      transcript = await groqAgent.transcribeAudio(audioBuffer, mimeType);
    }
    if (!transcript) {
      send(ws, { type: 'jessi-voice-error', reqId, message: "Didn't catch anything — try again." });
      return;
    }
    send(ws, { type: 'jessi-voice-transcript', reqId, text: transcript });

    // Voice uses the condensed persona + reduced tool set + short history to
    // stay under the 8B free tier's 6000 tokens/minute cap. No live-chart
    // snapshot injected here (Jessi can call quote_get/market_key_levels if
    // she actually needs it) — that snapshot was another chunk of every turn.
    const turnMessages = [...(messages || []).slice(-8), { role: 'user', content: transcript }];
    const systemPrompt = JESSI_PERSONA_VOICE + '\n\n' + buildJessiContext(true);

    // Voice brain switcher (Settings): 'gemini' (cloud Flash-Lite, NEW default
    // 2026-07-25), 'groq' (cloud, gpt-oss-20b), 'ollama-llama' (local
    // llama3.1:8b), or 'ollama-qwen' (local qwen2.5:3b).
    // 2026-07-25: default moved from Groq to Gemini for the same TPM reason as
    // text chat (250K vs 6-8K tokens/min), and the old 'groq' option's model ID
    // changed from llama-3.1-8b-instant to openai/gpt-oss-20b because Groq
    // deprecated the Llama IDs on 2026-06-17 (retiring 08/16/26).
    // Note: voice STT (Whisper) and TTS (Orpheus) are still Groq-only — this
    // switch only changes which model does the REASONING, so a Groq key is
    // still needed for server-side voice unless the browser handles STT/TTS.
    const voiceBrain = loadConfig().voiceBrain || 'gemini';
    let brainProvider = 'gemini', brainModel = 'gemini-3.5-flash';
    if (voiceBrain === 'groq') { brainProvider = 'groq'; brainModel = 'openai/gpt-oss-20b'; }
    else if (voiceBrain === 'ollama-llama') { brainProvider = 'ollama'; brainModel = 'llama3.1:8b'; }
    else if (voiceBrain === 'ollama-qwen') { brainProvider = 'ollama'; brainModel = 'qwen2.5:3b'; }

    // Same ordered fallback chain as text chat (see handleJessiChat) so a
    // retired Gemini model ID or an exhausted quota degrades instead of
    // failing the turn. Local Ollama brains get no chain — they're already
    // unlimited, and silently jumping to a cloud vendor would contradict the
    // whole point of picking a local brain.
    const brainChain = brainProvider === 'ollama' ? undefined : [
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'groq',   model: 'openai/gpt-oss-20b' }
    ];

    let fullReply = '';
    await new Promise((resolve) => {
      groqAgent.stream(turnMessages, systemPrompt, JESSI_VOICE_TOOLS, {
        provider: brainProvider,
        model: brainModel,
        fallbackChain: brainChain,
        toolExecutor: makeJessiToolExecutor(ws),
        onToolStart: (name, id) => send(ws, { type: 'jessi-voice-tool-start', reqId, name, id }),
        onToolDone:  (name, id, ok, res) => send(ws, { type: 'jessi-voice-tool-done', reqId, name, id, ok, result: res }),
        onFallback:  (fromM, toM) => send(ws, { type: 'jessi-voice-fallback', reqId, from: fromM, to: toM }),
        onWait:      (m, sec) => send(ws, { type: 'jessi-voice-quota-warn', reqId, message: `${m}: per-minute cap — waiting ${sec}s, same model.` }),
        onQuota:     (m, quota) => { const w = quotaWarning(m, quota); if (w) send(ws, { type: 'jessi-voice-quota-warn', reqId, message: w }); },
        onDone: (text) => { fullReply = text; resolve(); },
        onError: (errMsg) => { send(ws, { type: 'jessi-voice-error', reqId, message: errMsg }); resolve(null); }
      });
    });
    // FIX 2026-07-23: this used to `return` silently on an empty reply,
    // which left the client's "thinking" UI stuck forever with no terminal
    // message ever sent (found live). onError already covers the errored
    // path; this covers the "stream finished but produced nothing" path.
    if (!fullReply) {
      send(ws, { type: 'jessi-voice-error', reqId, message: "Jesse didn't say anything back — try again." });
      return;
    }

    // 2026-07-25: Edge TTS (neural, en-IN voices, free/unofficial — see
    // edge-tts.js header) is now tried FIRST for the speaking voice, per
    // Anoop's ask for a human-sounding voice he can use all day. Ladder:
    //   1. Edge TTS neural (en-IN-NeerjaNeural by default, Settings picker)
    //   2. clientTts → browser speechSynthesis (unlimited, robotic-ish)
    //   3. legacy Groq Orpheus (English-only, burns Groq quota)
    // Setting the voice to "browser" in Settings skips Edge entirely.
    const edgeVoice = loadConfig().edgeVoice || edgeTts.DEFAULT_VOICE;
    let sent = false;
    if (edgeVoice !== 'browser') {
      try {
        const clips = await edgeTts.synthesizeClips(fullReply, edgeVoice);
        send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips, mime: 'audio/mpeg' });
        sent = true;
      } catch (e) {
        console.log('Edge TTS failed (falling back):', e.message);
      }
    }
    if (!sent && clientTts) {
      // Browser speaks it — no server TTS call, no audio payload.
      send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips: [] });
    } else if (!sent) {
      const clips = await groqAgent.synthesizeSpeech(fullReply, 'autumn');
      send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips, mime: 'audio/wav' });
    }
  } catch (e) {
    send(ws, { type: 'jessi-voice-error', reqId, message: e.message });
  }
}

// ── Handler: Trade journal (free-text trade/state-of-mind entries) ─────────────
// Deliberately NOT account-scoped (not part of ACCT_LS_KEYS) — psychological
// patterns are about Anoop, not about which prop account is currently active,
// so this survives account breach/clear resets.
function handleJournalAdd(ws, msg) {
  const entries = dataLoad('trade_journal') || [];
  const entry = { ts: new Date().toISOString(), text: String(msg.text || '').slice(0, 2000) };
  entries.push(entry);
  const trimmed = entries.slice(-300);
  dataSave('trade_journal', trimmed);
  send(ws, { type: 'journal-saved', reqId: msg.reqId, ok: true, entry });
}

// ── Handler: MCP direct call ───────────────────────────────────────────────────
async function handleMCPCall(ws, msg) {
  const { name, args, reqId } = msg;
  try {
    const result = await mcpBridge.callTool(name, args || {});
    send(ws, { type: 'mcp-result', reqId, ok: true, result });
  } catch (e) {
    send(ws, { type: 'mcp-result', reqId, ok: false, error: e.message });
  }
}

// ── Handler: Sessions ──────────────────────────────────────────────────────────
function handleSessionStart(ws, msg) {
  const result = sessionMgr.startSession(sessionMgr.todayStr(), msg.data || {});
  send(ws, { type: 'session-started', reqId: msg.reqId, data: result });
}

function handleSessionTrade(ws, msg) {
  const result = sessionMgr.logTrade(sessionMgr.todayStr(), msg.trade || {});
  send(ws, { type: 'session-trade-logged', reqId: msg.reqId, data: result });
}

// ── Handler: Screenshot ────────────────────────────────────────────────────────
function handleScreenshot(ws, msg) {
  try {
    if (!msg.filePath || !fs.existsSync(msg.filePath)) {
      return send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: null });
    }
    const data = fs.readFileSync(msg.filePath);
    send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: 'data:image/png;base64,' + data.toString('base64') });
  } catch {
    send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: null });
  }
}

// ── Engulfing monitors (multi-timeframe: 1H / 30M / 15M) ────────────────────────
// Each monitor runs its own interval and uses market_multi_tf to switch the
// TradingView chart to its target timeframe, pull Pine/OHLCV data, then restore
// the chart — so 30M/15M checks are real, not just gated behind "chart happens
// to already be on that TF" the way the old single-TF version was.
const ENGULF_TFS = {
  '1h':  { tfCode: '60', label: '1H',  intervalMs: 60 * 1000 },
  '30m': { tfCode: '30', label: '30M', intervalMs: 45 * 1000 },
  '15m': { tfCode: '15', label: '15M', intervalMs: 30 * 1000 }
};

const engulfMonitors = {};
for (const key of Object.keys(ENGULF_TFS)) {
  engulfMonitors[key] = { running: false, interval: null, lastSignalKey: null, lastCheck: null };
}

function handleEngulfToggle(msg) {
  const key = ENGULF_TFS[msg.tf] ? msg.tf : '1h';
  if (msg.enabled) {
    startEngulfMonitor(key);
  } else {
    stopEngulfMonitor(key);
  }
}

function startEngulfMonitor(key) {
  stopEngulfMonitor(key);
  const mon = engulfMonitors[key];
  mon.running = true;
  broadcast({ type: 'engulf-monitor-status', tf: key, running: true });
  console.log(`Engulf monitor started [${ENGULF_TFS[key].label}]`);
  checkEngulfingSignal(key); // immediate
  mon.interval = setInterval(() => checkEngulfingSignal(key), ENGULF_TFS[key].intervalMs);
}

function stopEngulfMonitor(key) {
  const mon = engulfMonitors[key];
  if (mon.interval) {
    clearInterval(mon.interval);
    mon.interval = null;
  }
  mon.running = false;
  broadcast({ type: 'engulf-monitor-status', tf: key, running: false });
  console.log(`Engulf monitor stopped [${ENGULF_TFS[key].label}]`);
}

async function checkEngulfingSignal(key) {
  key = ENGULF_TFS[key] ? key : '1h';
  const cfg = ENGULF_TFS[key];
  const mon = engulfMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'engulf-check', tf: key, time: new Date().toISOString(), found: false, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();
  let found = false;
  let direction = null;
  let source = null;

  try {
    // market_multi_tf switches the chart to cfg.tfCode, collects Pine labels/
    // study values/OHLCV, then restores whatever TF was showing before.
    const res = await mcpBridge.callTool('market_multi_tf', {
      timeframes: [cfg.tfCode],
      collect: ['pine_labels', 'study_values', 'ohlcv_summary']
    });
    const data = parseMultiTFResult(res);
    const bars = getBarsFromMultiTF(data, cfg.tfCode);

    // ── Method 1/2: indicator label or study-value text mentions engulfing ──
    const labelText = flattenIndicatorText(data, cfg.tfCode);
    if (/bull[^|]{0,30}engulf|engulf[^|]{0,30}bull/i.test(labelText)) {
      found = true; direction = 'BULLISH'; source = `${cfg.label} indicator`;
    } else if (/bear[^|]{0,30}engulf|engulf[^|]{0,30}bear/i.test(labelText)) {
      found = true; direction = 'BEARISH'; source = `${cfg.label} indicator`;
    }

    // ── Method 3: real full-range engulfing on parsed OHLCV bars (Playbook C) ──
    if (!found) {
      const engulf = detectEngulfFromBars(bars);
      if (engulf) {
        found = true; direction = engulf.direction; source = `${cfg.label} OHLCV (full-range)`;
      }
    }

    // ── Fire notification if found and not duplicate ─────────────────────────
    if (found && direction) {
      // 15-min dedup bucket per monitor — don't fire same direction twice in 15 mins
      const bucket = direction + '_' + key + '_' + Math.floor(Date.now() / (15 * 60 * 1000));
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

        // Playbook A: a 1H engulfing only counts as a real setup if it agrees
        // with the 4H trend. Only checked for the 1H monitor — that's the TF
        // Playbook A actually pairs with the 4H filter.
        let alignNote = '';
        if (key === '1h') {
          const trend = await get4HTrend();
          if (trend === 'bullish' || trend === 'bearish') {
            const withTrend = (trend === 'bullish' && direction === 'BULLISH') || (trend === 'bearish' && direction === 'BEARISH');
            alignNote = withTrend
              ? ` — WITH 4H trend (${trend}), Playbook A valid`
              : ` — AGAINST 4H trend (${trend}), Playbook A says NO ACTION`;
          } else {
            alignNote = ' — 4H trend unclear, confirm manually before acting';
          }
        }

        const signalMessage = `${direction} Engulfing on ${cfg.label} at ${istTime} IST${alignNote} — check a lower TF for entry`;
        broadcast({
          type: 'engulf-signal',
          tf: key,
          tfLabel: cfg.label,
          direction,
          source,
          time: istTime,
          message: signalMessage
        });
        // Push the same signal to Telegram (no-op/silent if no chat linked yet).
        // NOTE: this is the only server-side push alert wired up. Daily-loss-tier
        // pattern warnings (checkForPatternWarnings) still live client-only in
        // renderer/app.js and are NOT pushed to Telegram — see telegram-bot.js
        // header comment for what porting that would require.
        telegramBot.notify(`⚡ ${signalMessage}`);
        console.log(`ENGULF SIGNAL [${cfg.label}]: ${direction} [${source}]${alignNote}`);
      }
    }

    broadcast({ type: 'engulf-check', tf: key, time: mon.lastCheck, found, direction });

  } catch (e) {
    console.error(`Engulf monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'engulf-check', tf: key, time: mon.lastCheck, found: false, status: 'error: ' + e.message });
  }
}

// ── Shared OHLCV/label parsing for market_multi_tf responses ───────────────────
// market_multi_tf returns real JSON (not just text to regex-scrape) shaped like:
//   { results: { "<tfCode>": { pine_labels: {...}, study_values: {...}, ohlcv: { last_5_bars: [...] } } } }
// Parsing it properly (instead of the old regex-over-joined-text approach) is
// what makes full-range engulfing validity and the 4H trend read possible —
// the old approach only ever saw open/close text fragments, never high/low.
function parseMultiTFResult(res) {
  try {
    const raw = res && res.content && res.content[0] && res.content[0].text;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBarsFromMultiTF(data, tfCode) {
  try {
    const bars = data.results[tfCode].ohlcv.last_5_bars;
    return Array.isArray(bars) ? bars : [];
  } catch {
    return [];
  }
}

function flattenIndicatorText(data, tfCode) {
  try {
    const tf = data.results[tfCode];
    const parts = [];
    if (tf.pine_labels && Array.isArray(tf.pine_labels.studies)) {
      for (const s of tf.pine_labels.studies) {
        for (const l of (s.labels || [])) parts.push(l.text || '');
      }
    }
    if (tf.study_values && Array.isArray(tf.study_values.studies)) {
      for (const s of tf.study_values.studies) {
        for (const k of Object.keys(s.values || {})) parts.push(`${s.name} ${k} ${s.values[k]}`);
      }
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}

// Full-range engulfing per Playbook C: the current bar must take out BOTH the
// high AND the low of the previous bar (not just overlap its open/close body,
// which is what the old body-only check did). Direction must also be the
// opposite of the previous bar's direction.
function detectEngulfFromBars(bars) {
  if (!bars || bars.length < 2) return null;
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  if ([prev.open, prev.close, prev.high, prev.low, curr.open, curr.close, curr.high, curr.low].some(v => typeof v !== 'number')) return null;

  if (prev.close < prev.open && curr.close > curr.open) {
    if (curr.high >= prev.high && curr.low <= prev.low) {
      return { direction: 'BULLISH' };
    }
  }
  if (prev.close > prev.open && curr.close < curr.open) {
    if (curr.high >= prev.high && curr.low <= prev.low) {
      return { direction: 'BEARISH' };
    }
  }
  return null;
}

// ── 4H trend read for Playbook A's alignment gate ───────────────────────────
// Approximation, not true swing-pivot market structure: market_multi_tf only
// ever returns the last 5 bars per TF, so this is a bar-over-bar higher-high/
// higher-low majority vote across those 5 bars, not a real multi-week HH-HL /
// LL-LH structure read. Good enough as a directional filter; not a substitute
// for actually looking at the 4H chart yourself on a borderline call.
let trendCache = { value: null, at: 0 };
async function get4HTrend() {
  // Cache for 3 minutes so a burst of 1H checks doesn't spam an extra
  // market_multi_tf call every time.
  if (trendCache.value && Date.now() - trendCache.at < 3 * 60 * 1000) return trendCache.value;
  try {
    const res = await mcpBridge.callTool('market_multi_tf', { timeframes: ['240'], collect: ['ohlcv_summary'] });
    const data = parseMultiTFResult(res);
    const bars = getBarsFromMultiTF(data, '240');
    const trend = classifyTrendFromBars(bars);
    trendCache = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error('4H trend read error:', e.message);
    return 'unclear';
  }
}

function classifyTrendFromBars(bars) {
  if (!bars || bars.length < 3) return 'unclear';
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].high > bars[i - 1].high) higherHighs++;
    else if (bars[i].high < bars[i - 1].high) lowerHighs++;
    if (bars[i].low > bars[i - 1].low) higherLows++;
    else if (bars[i].low < bars[i - 1].low) lowerLows++;
  }
  const n = bars.length - 1;
  const threshold = Math.ceil(n * 0.6);
  if (higherHighs >= threshold && higherLows >= threshold) return 'bullish';
  if (lowerHighs >= threshold && lowerLows >= threshold) return 'bearish';
  return 'unclear';
}

// ── Fair Value Gap (FVG) detector — Playbook B's displacement step ─────────────
// Classic 3-candle gap: bar[i-2] and bar[i] leave a price range bar[i-1] never
// traded into. Bullish FVG when bar[i-2].high < bar[i].low (gap up); bearish
// when bar[i-2].low > bar[i].high (gap down). This detects the gap existing —
// it does NOT confirm the SFP/liquidity-raid that should precede it per the
// full JadeCap playbook. See FVG_TFS block below for why that part is deferred.
function detectFVGFromBars(bars) {
  if (!bars || bars.length < 3) return null;
  const a = bars[bars.length - 3];
  const c = bars[bars.length - 1];
  if ([a.high, a.low, c.high, c.low].some(v => typeof v !== 'number')) return null;

  if (a.high < c.low) return { direction: 'BULLISH', gapLow: a.high, gapHigh: c.low };
  if (a.low > c.high) return { direction: 'BEARISH', gapLow: c.high, gapHigh: a.low };
  return null;
}

// ── FVG monitor (30M — switched from 15M 2026-07-28) ───────────────────────────
const FVG_TFS = {
  '30m': { tfCode: '30', label: '30M', intervalMs: 30 * 1000 }
};
const fvgMonitors = {};
for (const k of Object.keys(FVG_TFS)) {
  fvgMonitors[k] = { running: false, interval: null, lastSignalKey: null, lastCheck: null };
}

function handleFVGToggle(msg) {
  const key = FVG_TFS[msg.tf] ? msg.tf : '30m';
  if (msg.enabled) startFVGMonitor(key); else stopFVGMonitor(key);
}

function startFVGMonitor(key) {
  stopFVGMonitor(key);
  const mon = fvgMonitors[key];
  mon.running = true;
  broadcast({ type: 'fvg-monitor-status', tf: key, running: true });
  console.log(`FVG monitor started [${FVG_TFS[key].label}]`);
  checkFVGSignal(key);
  mon.interval = setInterval(() => checkFVGSignal(key), FVG_TFS[key].intervalMs);
}

function stopFVGMonitor(key) {
  const mon = fvgMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
  mon.running = false;
  broadcast({ type: 'fvg-monitor-status', tf: key, running: false });
  console.log(`FVG monitor stopped [${FVG_TFS[key].label}]`);
}

async function checkFVGSignal(key) {
  key = FVG_TFS[key] ? key : '30m';
  const cfg = FVG_TFS[key];
  const mon = fvgMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'fvg-check', tf: key, time: new Date().toISOString(), found: false, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();
  let found = false, direction = null, gapLow = null, gapHigh = null;

  try {
    const res = await mcpBridge.callTool('market_multi_tf', { timeframes: [cfg.tfCode], collect: ['ohlcv_summary'] });
    const data = parseMultiTFResult(res);
    const bars = getBarsFromMultiTF(data, cfg.tfCode);
    const fvg = detectFVGFromBars(bars);
    if (fvg) {
      found = true; direction = fvg.direction; gapLow = fvg.gapLow; gapHigh = fvg.gapHigh;
      const bucket = direction + '_' + key + '_' + Math.floor(Date.now() / (15 * 60 * 1000));
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const signalMessage = `${direction} FVG on ${cfg.label} at ${istTime} IST — gap ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}, watch for retrace entry`;
        broadcast({ type: 'fvg-signal', tf: key, tfLabel: cfg.label, direction, gapLow, gapHigh, time: istTime, message: signalMessage });
        telegramBot.notify(`🔲 ${signalMessage}`);
        console.log(`FVG SIGNAL [${cfg.label}]: ${direction} ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}`);
      }
    }
    broadcast({ type: 'fvg-check', tf: key, time: mon.lastCheck, found, direction });
  } catch (e) {
    console.error(`FVG monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'fvg-check', tf: key, time: mon.lastCheck, found: false, status: 'error: ' + e.message });
  }
}

// ── SFP / liquidity-raid detector — Playbook B's missing first two steps ──────
// Previously only the FVG (displacement) half of JadeCap's 3-step was detected.
// This closes the gap: detects the liquidity raid itself (price sweeps a key
// level — PDH/PDL or a recent swing high/low — then closes back inside it),
// holds that as a "pending" state, and only fires the real Playbook B signal
// once a matching-direction FVG (displacement) shows up afterward. A raid with
// no follow-through displacement expires unfired — JadeCap explicitly says not
// to chase a stale setup, so this does not either.
//
// market_multi_tf caps out at 5 bars per timeframe (see get4HTrend's comment
// above), which isn't enough to find swing highs/lows or a prior-day high/low.
// So this section pulls full bar history directly via chart_set_timeframe +
// data_get_ohlcv (count up to 500), restoring the chart's original timeframe
// afterward — same "don't leave the user's chart on the wrong TF" contract
// market_multi_tf itself follows, just built manually since that tool can't
// return enough bars for this.

// Generic JSON-result parser (parseMultiTFResult does the same thing but is
// named for that one call site — reused here under a name that doesn't imply
// multi-TF specifically).
function parseToolResult(res) {
  try {
    const raw = res && res.content && res.content[0] && res.content[0].text;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Defensively pull a bar array out of whatever shape data_get_ohlcv returns —
// the exact field name isn't nailed down from a live call, so this tries the
// common candidates rather than assuming one and silently returning nothing.
function extractBarsArray(parsed) {
  if (!parsed) return [];
  let bars = parsed.bars || parsed.data || parsed.ohlcv || parsed.result || parsed;
  if (bars && !Array.isArray(bars) && bars.bars) bars = bars.bars;
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && typeof b.open === 'number' && typeof b.high === 'number' && typeof b.low === 'number' && typeof b.close === 'number')
    .map(b => ({ time: b.time || b.t || 0, open: b.open, high: b.high, low: b.low, close: b.close }))
    .sort((a, b) => a.time - b.time);
}

// Switch the chart to tfCode, pull `count` full bars, restore the original
// timeframe — always, even on error (finally block).
// Some timeframe codes come back reported differently than they're set —
// e.g. chart_set_timeframe accepts 'D' but chart_get_state reports the
// resolution back as '1D'. Accept either form when confirming the switch
// actually landed.
function timeframeMatches(reported, requested) {
  if (!reported) return false;
  const r = String(reported), q = String(requested);
  if (r === q) return true;
  if (['D', 'W', 'M'].includes(q)) return r === '1' + q;
  return false;
}

// CHART LOCK (added 2026-07-28): getFullBars mutates GLOBAL UI state — it
// switches the live chart's timeframe, reads, then restores. Two overlapping
// calls therefore corrupt each other: A switches to D, B switches to 60, A
// reads and silently gets B's timeframe data, then they restore in the wrong
// order. This was a live risk the moment runMechanicalAnalysis started
// Promise.all-ing a Daily and a 1H read. Serialize every caller through one
// promise chain so only one chart switch is ever in flight.
let _chartOpChain = Promise.resolve();
function withChartLock(fn) {
  const run = _chartOpChain.then(fn, fn);
  // Keep the chain alive even if this op rejects, and don't leak the error
  // into the next caller.
  _chartOpChain = run.then(() => {}, () => {});
  return run;
}

async function getFullBars(tfCode, count) {
  return withChartLock(() => _getFullBarsUnlocked(tfCode, count));
}

async function _getFullBarsUnlocked(tfCode, count) {
  let originalTf = null;
  try {
    const stateRes = await mcpBridge.callTool('chart_get_state', {});
    const state = parseToolResult(stateRes);
    originalTf = (state && (state.timeframe || state.resolution)) || null;
  } catch { /* if we can't read current TF, we just won't restore it below */ }

  try {
    await mcpBridge.callTool('chart_set_timeframe', { timeframe: tfCode });
    // Race-condition fix (2026-07-22): chart_set_timeframe can return before
    // the chart has actually finished switching, so an immediate
    // data_get_ohlcv silently reads bars from the PREVIOUS timeframe. Caught
    // live: Anoop's chart showed PDH/PDL as a ~$48 spread instead of the
    // real ~$660 daily range, because this raced. Poll chart_get_state until
    // its resolution actually matches tfCode (up to ~2s) before trusting the
    // OHLCV read. Same class of bug as the earlier chart_set_symbol +
    // quote_get "chart may still be loading" flakiness found 2026-07-08.
    for (let i = 0; i < 5; i++) {
      try {
        const check = parseToolResult(await mcpBridge.callTool('chart_get_state', {}));
        const reported = check && (check.resolution || check.timeframe);
        if (timeframeMatches(reported, tfCode)) break;
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 400));
    }
    const res = await mcpBridge.callTool('data_get_ohlcv', { count, summary: false });
    return extractBarsArray(parseToolResult(res));
  } finally {
    if (originalTf) {
      try { await mcpBridge.callTool('chart_set_timeframe', { timeframe: originalTf }); } catch { /* best effort restore */ }
    }
  }
}

// Previous day's high/low — cached 10 minutes since it only changes once a
// day. Assumes the last daily bar returned is the still-forming current
// session (true whenever the market is open) and uses the one before it.
let pdhPdlCache = { value: null, at: 0 };
async function getPDHPDL() {
  if (pdhPdlCache.value && Date.now() - pdhPdlCache.at < 10 * 60 * 1000) return pdhPdlCache.value;
  try {
    const bars = await getFullBars('D', 3);
    if (bars.length < 2) return pdhPdlCache.value;
    const prevDay = bars[bars.length - 2];
    const val = { pdh: prevDay.high, pdl: prevDay.low, pdhTime: prevDay.time, pdlTime: prevDay.time };
    pdhPdlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('PDH/PDL fetch error:', e.message);
    return pdhPdlCache.value;
  }
}

// Previous WEEK's high/low — mirrors getPDHPDL() but on 'W' bars, cached 30
// minutes since a weekly bar changes far less often than a daily one.
// Assumes the last weekly bar returned is the still-forming current week and
// uses the one before it.
let pwhPwlCache = { value: null, at: 0 };
async function getPrevWeekHighLow() {
  if (pwhPwlCache.value && Date.now() - pwhPwlCache.at < 30 * 60 * 1000) return pwhPwlCache.value;
  try {
    const bars = await getFullBars('W', 3);
    if (bars.length < 2) return pwhPwlCache.value;
    const prevWeek = bars[bars.length - 2];
    const val = { pwh: prevWeek.high, pwl: prevWeek.low, pwhTime: prevWeek.time, pwlTime: prevWeek.time };
    pwhPwlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Prev week H/L fetch error:', e.message);
    return pwhPwlCache.value;
  }
}

// CURRENT (still-forming) week's high/low — the last 'W' bar itself, not the
// one before it. Short cache (2 min) since this updates live intraday.
let cwhCwlCache = { value: null, at: 0 };
async function getCurrentWeekHighLow() {
  if (cwhCwlCache.value && Date.now() - cwhCwlCache.at < 2 * 60 * 1000) return cwhCwlCache.value;
  try {
    const bars = await getFullBars('W', 2);
    if (!bars.length) return cwhCwlCache.value;
    const thisWeek = bars[bars.length - 1];
    const val = { cwh: thisWeek.high, cwl: thisWeek.low, cwhTime: thisWeek.time, cwlTime: thisWeek.time };
    cwhCwlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Current week H/L fetch error:', e.message);
    return cwhCwlCache.value;
  }
}

// CURRENT (still-forming) month's high/low — the last 'M' bar itself. Short
// cache (2 min), same reasoning as getCurrentWeekHighLow().
let cmhCmlCache = { value: null, at: 0 };
async function getCurrentMonthHighLow() {
  if (cmhCmlCache.value && Date.now() - cmhCmlCache.at < 2 * 60 * 1000) return cmhCmlCache.value;
  try {
    const bars = await getFullBars('M', 2);
    if (!bars.length) return cmhCmlCache.value;
    const thisMonth = bars[bars.length - 1];
    const val = { cmh: thisMonth.high, cml: thisMonth.low, cmhTime: thisMonth.time, cmlTime: thisMonth.time };
    cmhCmlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Current month H/L fetch error:', e.message);
    return cmhCmlCache.value;
  }
}

// Simple 5-bar fractal swing detection (2 bars either side) over the supplied
// bar window — not a full market-structure engine, but enough to find the
// recent liquidity pools (swing highs/lows) a sweep would target alongside
// PDH/PDL. Returns up to 3 most-recent, de-duplicated (within ~0.05%) levels
// each side.
function getSwingLevels(bars) {
  const highs = [], lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const w = bars.slice(i - 2, i + 3);
    if (bars[i].high === Math.max(...w.map(b => b.high))) highs.push(bars[i].high);
    if (bars[i].low === Math.min(...w.map(b => b.low))) lows.push(bars[i].low);
  }
  const dedupeMostRecent = (arr) => {
    const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 3; i--) {
      const v = arr[i];
      if (!out.some(o => Math.abs(o - v) / v < 0.0005)) out.push(v);
    }
    return out;
  };
  return { swingHighs: dedupeMostRecent(highs), swingLows: dedupeMostRecent(lows) };
}

// SFP (swing failure pattern) / liquidity raid: the latest bar wicks through a
// key level and closes back on the other side of it — the "trap candle."
// Checked against every level in the pool; first match wins.
function detectSFPFromBars(bars, levels) {
  if (!bars || bars.length < 1) return null;
  const curr = bars[bars.length - 1];
  if ([curr.high, curr.low, curr.close].some(v => typeof v !== 'number')) return null;

  for (const level of levels.highs) {
    if (typeof level === 'number' && curr.high > level && curr.close < level) {
      return { direction: 'BEARISH', level };
    }
  }
  for (const level of levels.lows) {
    if (typeof level === 'number' && curr.low < level && curr.close > level) {
      return { direction: 'BULLISH', level };
    }
  }
  return null;
}

// ── SFP / Playbook B monitor (30M — matches the same "reaction" step as FVG) ──
// Changed from 15M to 30M on 2026-07-15 per Anoop: the 15M version was firing
// a "new" liquidity raid message roughly every poll (every 45s) while a single
// candle was still forming, because it evaluated the LATEST bar — which is
// still live and updating — instead of waiting for it to actually close.
const SFP_TFS = {
  '30m': { tfCode: '30', label: '30M', intervalMs: 60 * 1000, lookback: 40 }
};
const sfpMonitors = {};
for (const k of Object.keys(SFP_TFS)) {
  // pending: { direction, level, sweptAt, expiresAt } once a raid has fired,
  // cleared either by a confirming displacement FVG or by expiry.
  sfpMonitors[k] = { running: false, interval: null, lastCheck: null, lastSweepKey: null, lastConfirmKey: null, pending: null };
}

function handleSFPToggle(msg) {
  const key = SFP_TFS[msg.tf] ? msg.tf : '30m';
  if (msg.enabled) startSFPMonitor(key); else stopSFPMonitor(key);
}

function startSFPMonitor(key) {
  stopSFPMonitor(key);
  const mon = sfpMonitors[key];
  mon.running = true;
  broadcast({ type: 'sfp-monitor-status', tf: key, running: true });
  console.log(`SFP/Playbook B monitor started [${SFP_TFS[key].label}]`);
  checkSFPSignal(key);
  mon.interval = setInterval(() => checkSFPSignal(key), SFP_TFS[key].intervalMs);
}

function stopSFPMonitor(key) {
  const mon = sfpMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
  mon.running = false;
  broadcast({ type: 'sfp-monitor-status', tf: key, running: false });
  console.log(`SFP/Playbook B monitor stopped [${SFP_TFS[key].label}]`);
}

async function checkSFPSignal(key) {
  key = SFP_TFS[key] ? key : '30m';
  const cfg = SFP_TFS[key];
  const mon = sfpMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'sfp-check', tf: key, time: new Date().toISOString(), found: false, pending: !!mon.pending, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();

  try {
    const bars = await getFullBars(cfg.tfCode, cfg.lookback);
    if (bars.length < 6) {
      broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'insufficient bar history' });
      return;
    }

    // Only ever evaluate a fully CLOSED candle — the last bar returned is
    // usually still forming/live. Fixed 2026-07-15: previously this checked
    // bars[bars.length-1] directly, so every ~45s poll re-evaluated a candle
    // whose high/low/close was still changing mid-formation, firing a "new"
    // liquidity-raid message on nearly every tick instead of once per candle.
    const tfSeconds = parseInt(cfg.tfCode, 10) * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const lastBarStillForming = bars[bars.length - 1].time + tfSeconds > nowSec;
    const closedBars = lastBarStillForming ? bars.slice(0, -1) : bars;
    const closedBar = closedBars[closedBars.length - 1];
    if (!closedBar) {
      broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'waiting for a closed ' + cfg.label + ' bar' });
      return;
    }

    const pdhpdl = await getPDHPDL();
    const swings = getSwingLevels(closedBars);
    const levels = {
      highs: [...(pdhpdl ? [pdhpdl.pdh] : []), ...swings.swingHighs],
      lows:  [...(pdhpdl ? [pdhpdl.pdl] : []), ...swings.swingLows]
    };

    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const sfp = detectSFPFromBars(closedBars, levels);

    if (sfp) {
      // Keyed on the closed bar's own timestamp — stable and unique per
      // candle, unlike a wall-clock bucket — so this can only fire once per
      // real candle close, no matter how often the poll runs.
      const sweepBucket = sfp.direction + '_' + sfp.level.toFixed(2) + '_' + closedBar.time;
      if (sweepBucket !== mon.lastSweepKey) {
        mon.lastSweepKey = sweepBucket;
        const raidSwept = sfp.direction === 'BEARISH' ? 'HIGH' : 'LOW';
        const raidSide  = sfp.direction === 'BEARISH' ? 'Buy-side' : 'Sell-side';
        const raidBias  = sfp.direction === 'BEARISH' ? 'SHORT' : 'LONG';
        const raidMsg = `${raidSide} liquidity raid on ${cfg.label} at ${istTime} IST — swept the ${sfp.level.toFixed(2)} ${raidSwept} and closed back inside → reversal bias ${raidBias}. Not a trade yet: waiting for displacement/FVG to confirm Playbook B.`;
        broadcast({ type: 'sfp-signal', tf: key, tfLabel: cfg.label, direction: sfp.direction, level: sfp.level, time: istTime, message: raidMsg });
        telegramBot.notify(`🎣 ${raidMsg}`);
        console.log(`SFP RAID [${cfg.label}]: ${sfp.direction} swept ${sfp.level.toFixed(2)}`);
        // A fresh raid replaces any stale pending one — the most recent liquidity event is what matters.
        // Patience window kept at 8 candles (was 8×15m=2h; now 8×30m=4h) — tied
        // to bar count, not wall clock, so it scales with the TF automatically.
        mon.pending = { direction: sfp.direction, level: sfp.level, sweptAt: Date.now(), expiresAt: Date.now() + 8 * tfSeconds * 1000 };
      }
    }

    if (mon.pending) {
      if (Date.now() > mon.pending.expiresAt) {
        console.log(`SFP pending [${cfg.label}] expired with no displacement — discarded (JadeCap: don't chase a stale setup)`);
        mon.pending = null;
      } else {
        const fvg = detectFVGFromBars(closedBars);
        if (fvg && fvg.direction === mon.pending.direction) {
          const confirmBucket = mon.pending.direction + '_' + mon.pending.level.toFixed(2) + '_confirm_' + closedBar.time;
          if (confirmBucket !== mon.lastConfirmKey) {
            mon.lastConfirmKey = confirmBucket;
            const confirmMsg = `PLAYBOOK B CONFIRMED (${mon.pending.direction}) on ${cfg.label} at ${istTime} IST — liquidity raid at ${mon.pending.level.toFixed(2)} + displacement FVG ${fvg.gapLow.toFixed(2)}-${fvg.gapHigh.toFixed(2)}. Enter on retrace into the gap, SL beyond the sweep wick.`;
            broadcast({
              type: 'playbook-b-signal',
              tf: key,
              tfLabel: cfg.label,
              direction: mon.pending.direction,
              sweepLevel: mon.pending.level,
              gapLow: fvg.gapLow,
              gapHigh: fvg.gapHigh,
              time: istTime,
              message: confirmMsg
            });
            telegramBot.notify(`✅ ${confirmMsg}`);
            console.log(`PLAYBOOK B CONFIRMED [${cfg.label}]: ${mon.pending.direction}`);
            mon.pending = null;
          }
        }
      }
    }

    broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: !!sfp, pending: !!mon.pending, direction: sfp ? sfp.direction : null });
  } catch (e) {
    console.error(`SFP monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'error: ' + e.message });
  }
}

// ── Trend STRENGTH classifier (added 2026-07-28, Anoop) ─────────────────────
// Anoop asked for all three ways of reading strength combined, not any one
// alone:
//   1. Structure — bar-over-bar HH/HL vs LL/LH vote, continuous version of
//      classifyTrendFromBars() above (that one only returns a hard
//      bullish/bearish/unclear cutoff; this scores -1..+1).
//   2. Body-vs-range — how much of the MOST RECENT bar's total range is real
//      body (close-open) vs wicks. A big one-directional body = conviction;
//      a small body with long wicks both ways = indecision.
//   3. Slope — linear-regression slope of closes across the available bars
//      (market_multi_tf only ever returns 5), normalized by average price
//      so it's comparable regardless of instrument/price level.
// Each signal scores -1 (bear) to +1 (bull). Direction comes from the sign
// of their average; strength (STRONG/WEAK/NEUTRAL) comes from how large the
// average is AND how many of the 3 actually agree with that direction — all
// 3 agreeing with a large average is STRONG, 2/3 is WEAK, a wash is NEUTRAL.
// This is a mechanical approximation like get4HTrend() above (only 5 bars
// available), not a substitute for reading the chart yourself on a
// borderline call — same caveat applies, now with a visible strength grade
// instead of a false-confident binary.
function classifyTrendStrength(bars) {
  if (!bars || bars.length < 3) return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };

  // UPGRADED 2026-07-28 (Anoop): was computed off market_multi_tf's fixed
  // 5-bar window — five daily candles is one week, too thin to call a
  // "Daily bias" honestly. Now fed 60 bars via getFullBars(). Two real
  // consequences of the deeper history:
  //   a) STRUCTURE is now true swing-pivot structure (higher-highs and
  //      higher-lows between actual pivots, via the same 5-bar pivot
  //      definition getSwingLevels() uses) instead of a bar-over-bar vote.
  //      A bar-over-bar vote is noise at this depth; pivots are what your
  //      Playbook A/C actually describe ("HH-HL pattern" / "LL-LH pattern").
  //   b) The last bar is usually STILL FORMING (true whenever the market is
  //      open), so its body is incomplete and misleading. Body and slope now
  //      read the last CLOSED bar — same assumption getPDHPDL() already makes.
  const closedBars = bars.length >= 2 ? bars.slice(0, -1) : bars;
  // Require real depth. Below this the grade is noise dressed as a reading —
  // caught in testing: 4 bars produced the same confident label as 60.
  if (closedBars.length < 10) return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, thin: true };

  // 1. STRUCTURE — swing pivots (higher-highs/higher-lows between pivots).
  // BUG FOUND IN TESTING (2026-07-28): a clean monotonic trend produces ZERO
  // pivots — in a steady rise no bar is the max of a 5-bar window centred on
  // it (the max always sits at the window's right edge). So the strongest
  // possible trend scored structure = 0, exactly backwards. Fall back to a
  // bar-over-bar HH/HL vote whenever there aren't enough pivots to compare;
  // that method is weak on choppy data (which is why pivots are preferred)
  // but it is accurate precisely in the smooth-trend case pivots miss.
  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < closedBars.length - 2; i++) {
    const w = closedBars.slice(i - 2, i + 3);
    if (closedBars[i].high === Math.max(...w.map(b => b.high))) pivotHighs.push(closedBars[i].high);
    if (closedBars[i].low === Math.min(...w.map(b => b.low))) pivotLows.push(closedBars[i].low);
  }
  let structureScore = 0, structureMethod = 'pivots';
  const recentH = pivotHighs.slice(-3), recentL = pivotLows.slice(-3);
  if (recentH.length >= 2 && recentL.length >= 2) {
    let up = 0, down = 0, tot = 0;
    for (let i = 1; i < recentH.length; i++) { tot++; if (recentH[i] > recentH[i - 1]) up++; else if (recentH[i] < recentH[i - 1]) down++; }
    for (let i = 1; i < recentL.length; i++) { tot++; if (recentL[i] > recentL[i - 1]) up++; else if (recentL[i] < recentL[i - 1]) down++; }
    structureScore = tot ? (up - down) / tot : 0;
  } else {
    structureMethod = 'bar-over-bar';
    const w = closedBars.slice(-20);
    let hh = 0, hl = 0, lh = 0, ll = 0;
    for (let i = 1; i < w.length; i++) {
      if (w[i].high > w[i - 1].high) hh++; else if (w[i].high < w[i - 1].high) lh++;
      if (w[i].low > w[i - 1].low) hl++; else if (w[i].low < w[i - 1].low) ll++;
    }
    const n = w.length - 1;
    structureScore = n ? ((hh + hl) - (lh + ll)) / (2 * n) : 0;
  }

  // 2. BODY vs RANGE — last CLOSED bar only.
  const last = closedBars[closedBars.length - 1];
  const range = Math.max(last.high - last.low, 0.01);
  const bodyScore = Math.max(-1, Math.min(1, (last.close - last.open) / range));

  // 3. SLOPE — linear regression over the last 20 closed bars. Windowed at 20
  // deliberately: regressing all 60 would measure last quarter's drift, not
  // the trend you're about to trade into.
  const window = closedBars.slice(-20);
  const closes = window.map(b => b.close);
  const avgClose = (closes.reduce((a, b) => a + b, 0) / closes.length) || 1;
  const xs = closes.map((_, i) => i);
  const xBar = xs.reduce((a, b) => a + b, 0) / xs.length;
  let num = 0, den = 0;
  for (let i = 0; i < closes.length; i++) { num += (xs[i] - xBar) * (closes[i] - avgClose); den += (xs[i] - xBar) ** 2; }
  const slopePerBar = den ? num / den : 0;
  // 0.15%-per-bar drift reads as full-strength (+/-1). UNTUNED — this number
  // is a guess, not derived from Anoop's data. Watch it against your own read
  // for a few sessions and adjust if it says STRONG when your eye says WEAK.
  const slopeScore = Math.max(-1, Math.min(1, (slopePerBar / avgClose) / 0.0015));

  const round2 = (v) => Math.round(v * 100) / 100;
  const scores = [structureScore, bodyScore, slopeScore];
  const avg = scores.reduce((a, b) => a + b, 0) / 3;
  const direction = avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'unclear';
  const agree = direction === 'unclear' ? 0 : scores.filter(s => (direction === 'bullish' ? s > 0.05 : s < -0.05)).length;

  let strength;
  if (direction === 'unclear') strength = 'NEUTRAL';
  else if (agree === 3 && Math.abs(avg) >= 0.45) strength = 'STRONG';
  else if (agree >= 2) strength = 'WEAK';
  else strength = 'NEUTRAL';

  // BUG FOUND IN TESTING: this produced the nonsense label "NEUTRAL BEAR"
  // when a direction was computed but the signals didn't agree enough to
  // call it. If strength lands on NEUTRAL the honest answer is NEUTRAL, with
  // no direction attached — that's the whole point of the neutral bucket.
  const label = (direction === 'unclear' || strength === 'NEUTRAL')
    ? 'NEUTRAL'
    : `${strength} ${direction === 'bullish' ? 'BULL' : 'BEAR'}`;
  return {
    direction: strength === 'NEUTRAL' ? 'unclear' : direction,
    label, score: round2(avg),
    detail: { structureScore: round2(structureScore), structureMethod, bodyScore: round2(bodyScore), slopeScore: round2(slopeScore), agree }
  };
}

// ── Mechanical HTF alignment + key level (no LLM) ───────────────────────────
// Keeps the BIAS / KEY LEVEL / Framework Steps panel populated with zero
// Anthropic API calls. Runs continuously in the background (like the
// engulf/FVG/SFP monitors), not just on button click.
const trendCacheByTF = {};
// CHART-DISRUPTION NOTE (2026-07-28): both market_multi_tf and getFullBars
// work by switching Anoop's LIVE chart timeframe, reading, then switching
// back — he trades off that chart, so every read is a visible flicker. The
// old code re-read both TFs every 3 min (~40 switches/hour). getFullBars is
// slower per call (it polls up to 2s for the chart to settle after the
// switch), so the TTLs below are raised to compensate: a DAILY bar does not
// meaningfully change in 3 minutes, and neither does a 1H bar. Net effect is
// FEWER chart switches than before (~16/hour) on much deeper data.
const TREND_TTL_BY_TF = { 'D': 15 * 60 * 1000, '60': 5 * 60 * 1000 };
const TREND_BAR_COUNT = 60;
async function getTrendForTF(tfCode, ttlMs) {
  const ttl = ttlMs != null ? ttlMs : (TREND_TTL_BY_TF[tfCode] || 5 * 60 * 1000);
  const c = trendCacheByTF[tfCode];
  if (c && Date.now() - c.at < ttl) return c.value;
  try {
    const bars = await getFullBars(tfCode, TREND_BAR_COUNT);
    if (!bars || bars.length < 5) {
      // Don't overwrite a good cached read with a bad partial one.
      if (c) return c.value;
      return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };
    }
    const trend = classifyTrendStrength(bars);
    trend.bars = bars.length;
    trendCacheByTF[tfCode] = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error(`Trend read [${tfCode}] error:`, e.message);
    // Stale-but-real beats a false "unclear" — keep the last good value.
    if (c) return c.value;
    return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };
  }
}

async function getCurrentPriceMechanical() {
  try {
    const res = await mcpBridge.callTool('quote_get', {});
    const raw = res && res.content && res.content.map(c => c.text || '').join(' ');
    const m = raw && (raw.match(/last["\s:]+([0-9.,]+)/i) || raw.match(/([0-9]{4,6}\.[0-9]{1,2})/));
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  } catch (e) {
    console.error('Price read (mechanical) error:', e.message);
    return null;
  }
}

// Nearest PDH/PDL or recent 1H swing level to current price — the same level
// pool the SFP monitor uses, just ranked by distance instead of scanned for a
// sweep.
async function getNearestKeyLevelMechanical(price) {
  if (typeof price !== 'number') return null;
  try {
    const pdhpdl = await getPDHPDL();
    const hourBars = await getFullBars('60', 40);
    const swings = getSwingLevels(hourBars);
    const candidates = [];
    if (pdhpdl) {
      candidates.push({ label: 'PDH', price: pdhpdl.pdh });
      candidates.push({ label: 'PDL', price: pdhpdl.pdl });
    }
    swings.swingHighs.forEach(p => candidates.push({ label: 'Swing High', price: p }));
    swings.swingLows.forEach(p => candidates.push({ label: 'Swing Low', price: p }));
    if (!candidates.length) return null;
    candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    return candidates[0];
  } catch (e) {
    console.error('Key level (mechanical) error:', e.message);
    return null;
  }
}

let mechanicalInterval = null;
async function runMechanicalAnalysis() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'mechanical-analysis', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const [dailyRead, hourRead, price] = await Promise.all([
      getTrendForTF('D'),
      getTrendForTF('60'),
      getCurrentPriceMechanical()
    ]);
    const keyLevel = await getNearestKeyLevelMechanical(price);
    const aligned = dailyRead.direction !== 'unclear' && hourRead.direction !== 'unclear' && dailyRead.direction === hourRead.direction;

    broadcast({
      type: 'mechanical-analysis',
      ok: true,
      time: new Date().toISOString(),
      // dailyTrend/hourTrend kept as plain direction strings for backward
      // compat (existing 'aligned' logic and UI checks read these); the new
      // strength grade is additive, not a replacement.
      dailyTrend: dailyRead.direction, hourTrend: hourRead.direction, aligned,
      dailyLabel: dailyRead.label, hourLabel: hourRead.label,
      dailyScore: dailyRead.score, hourScore: hourRead.score,
      dailyDetail: dailyRead.detail, hourDetail: hourRead.detail,
      dailyBars: dailyRead.bars || null, hourBars: hourRead.bars || null,
      price, keyLevel
    });
  } catch (e) {
    console.error('Mechanical analysis error:', e.message);
    broadcast({ type: 'mechanical-analysis', ok: false, status: 'error: ' + e.message });
  }
}

function startMechanicalAnalysis() {
  runMechanicalAnalysis();
  if (mechanicalInterval) clearInterval(mechanicalInterval);
  mechanicalInterval = setInterval(runMechanicalAnalysis, 90 * 1000);
}

function stopMechanicalAnalysis() {
  if (mechanicalInterval) { clearInterval(mechanicalInterval); mechanicalInterval = null; }
}

// ── London prep: mark PDH/PDL + Asia session H/L + previous week H/L ──────────
// On-demand (triggered by the "Mark London Levels" button, or the
// 'mark-london-levels' WS message) — not a background timer. Reuses
// getPDHPDL()/getFullBars() from the SFP section above.
// Updated 2026-07-22 per Anoop: added previous week H/L alongside the
// existing PDH/PDL + Asia H/L (nothing removed, only added).

function barTimeToDate(t) {
  // Defensive: bar.time could be unix seconds or milliseconds depending on
  // what the MCP tool actually returns — treat anything above 1e12 as ms.
  const ms = t > 1e12 ? t : t * 1000;
  return new Date(ms);
}

function toISTFractionalHour(date) {
  const ist = new Date(date.getTime() + 5.5 * 3600000);
  return ist.getUTCHours() + ist.getUTCMinutes() / 60;
}

// Asia session convention used here: 5:30 AM IST (Tokyo open) to 1:30 PM IST
// (London open) — the same boundary CLAUDE.md uses for when London starts.
// Pulling 40 x 15M bars (~10 hours) is enough to cover that window when this
// runs at/after London open without reaching back into the prior day's Asia
// session too.
async function getAsiaHighLow() {
  try {
    const bars = await getFullBars('15', 40);
    if (!bars.length) return null;
    const asiaBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 5.5 && h < 13.5;
    });
    if (!asiaBars.length) return null;
    const highBar = asiaBars.reduce((a, b) => (b.high > a.high ? b : a));
    const lowBar = asiaBars.reduce((a, b) => (b.low < a.low ? b : a));
    return {
      asiaHigh: highBar.high, asiaHighTime: highBar.time,
      asiaLow: lowBar.low, asiaLowTime: lowBar.time
    };
  } catch (e) {
    console.error('Asia H/L fetch error:', e.message);
    return null;
  }
}

// Draws one horizontal RAY (originates at the actual candle where the
// high/low occurred, extends rightward only) + a text label at the same
// price. Two separate draw_shape calls in a try/catch each — the exact
// override fields draw_shape accepts for inline labels aren't nailed down
// from a live call, so a dedicated 'text' shape (an explicitly documented
// shape type) is used instead of trusting an undocumented override key.
//
// FIX (2026-07-27): this used to be shape:'horizontal_line' anchored at
// nowSec — TradingView's "Horizontal Line" tool ignores the anchor time and
// spans the ENTIRE chart both directions, which is not how Anoop marks
// levels himself. He sent a side-by-side screenshot: his own manual markup
// uses TradingView's Horizontal RAY tool, anchored at the actual pivot
// candle, extending only rightward from there — "origin from the point the
// high or low is... this should apply to all marking level." Verified
// 'horizontal_ray' is a real, distinct shape type the connected TradingView
// MCP accepts (tested live against the actual chart before committing to
// this, not guessed) — swapped the tool + now threads the REAL bar time for
// each level through from the getPDHPDL/getPrevWeekHighLow/etc. callers
// below instead of always using "now".
async function drawLevelLine(price, label, color, originSec) {
  try {
    await mcpBridge.callTool('draw_shape', {
      shape: 'horizontal_ray',
      point: { time: originSec, price },
      overrides: JSON.stringify({ linecolor: color, linewidth: 1, linestyle: 0, showLabel: true, horzLabelsAlign: 'right' })
    });
  } catch (e) {
    console.error(`Draw line [${label}] failed:`, e.message);
  }
  try {
    await mcpBridge.callTool('draw_shape', {
      shape: 'text',
      point: { time: originSec, price },
      text: label,
      overrides: JSON.stringify({ color })
    });
  } catch (e) {
    console.error(`Draw label [${label}] failed:`, e.message);
  }
}

async function markLondonLevels() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'london-levels', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const pdhpdl = await getPDHPDL();
    const asia = await getAsiaHighLow();
    const prevWeek = await getPrevWeekHighLow();
    if (!pdhpdl && !asia && !prevWeek) {
      broadcast({ type: 'london-levels', ok: false, status: 'no bar data available yet' });
      return;
    }

    // 2026-07-27: each line now carries the REAL bar time its high/low
    // occurred on (origin) instead of "now" — see drawLevelLine() note above.
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = [];
    if (prevWeek) {
      lines.push({ label: 'Prev Week High', price: prevWeek.pwh, origin: prevWeek.pwhTime || nowSec, color: '#7a4fc9' });
      lines.push({ label: 'Prev Week Low', price: prevWeek.pwl, origin: prevWeek.pwlTime || nowSec, color: '#7a4fc9' });
    }
    if (pdhpdl) {
      lines.push({ label: 'PDH', price: pdhpdl.pdh, origin: pdhpdl.pdhTime || nowSec, color: '#d1293b' });
      lines.push({ label: 'PDL', price: pdhpdl.pdl, origin: pdhpdl.pdlTime || nowSec, color: '#16883f' });
    }
    if (asia) {
      lines.push({ label: 'Asia High', price: asia.asiaHigh, origin: asia.asiaHighTime || nowSec, color: '#b5750a' });
      lines.push({ label: 'Asia Low', price: asia.asiaLow, origin: asia.asiaLowTime || nowSec, color: '#b5750a' });
    }

    for (const line of lines) {
      await drawLevelLine(line.price, line.label, line.color, line.origin || nowSec);
    }

    const summary = lines.map(l => `${l.label} ${l.price.toFixed(2)}`).join(' · ');
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = `London prep — marked on chart at ${istTime} IST: ${summary}`;
    broadcast({ type: 'london-levels', ok: true, time: istTime, lines, message });
    telegramBot.notify(`📍 ${message}`);
    console.log(`LONDON LEVELS MARKED: ${summary}`);

    // Chain the ForexFactory chart sync into the same prep ritual — best
    // effort, wrapped separately so a news-marker failure can never affect
    // the London-levels result already broadcast above.
    try { await markNewsTimesOnChart(); } catch (e2) { console.error('News chart sync (chained) failed:', e2.message); }
  } catch (e) {
    console.error('Mark London levels error:', e.message);
    broadcast({ type: 'london-levels', ok: false, status: 'error: ' + e.message });
  }
}

// London session convention used here: 1:30 PM IST (London open) to 7:00 PM IST
// (NY open) - mirrors the Asia->London boundary above, one session later.
// Pulling 30 x 15M bars (~7.5 hours) is enough to cover that window when this
// runs at/after NY open without reaching back into the Asia session too.
async function getLondonHighLow() {
  try {
    const bars = await getFullBars('15', 30);
    if (!bars.length) return null;
    const londonBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 13.5 && h < 19.0;
    });
    if (!londonBars.length) return null;
    return {
      londonHigh: Math.max(...londonBars.map(b => b.high)),
      londonLow: Math.min(...londonBars.map(b => b.low))
    };
  } catch (e) {
    console.error('London H/L fetch error:', e.message);
    return null;
  }
}

// Updated 2026-07-22 per Anoop: NY levels now mark current week H/L + current
// month H/L instead of PDH/PDL + London H/L (full replacement, not additive —
// getPDHPDL()/getLondonHighLow() are unused here now but left defined above
// since markLondonLevels() and other callers still use getPDHPDL()).
async function markNYLevels() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'ny-levels', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const currWeek = await getCurrentWeekHighLow();
    const currMonth = await getCurrentMonthHighLow();
    if (!currWeek && !currMonth) {
      broadcast({ type: 'ny-levels', ok: false, status: 'no bar data available yet' });
      return;
    }

    // 2026-07-27: real bar-origin times, same as markLondonLevels() above.
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = [];
    if (currWeek) {
      lines.push({ label: 'Week High', price: currWeek.cwh, origin: currWeek.cwhTime || nowSec, color: '#3b6fb5' });
      lines.push({ label: 'Week Low', price: currWeek.cwl, origin: currWeek.cwlTime || nowSec, color: '#3b6fb5' });
    }
    if (currMonth) {
      lines.push({ label: 'Month High', price: currMonth.cmh, origin: currMonth.cmhTime || nowSec, color: '#c98a2f' });
      lines.push({ label: 'Month Low', price: currMonth.cml, origin: currMonth.cmlTime || nowSec, color: '#c98a2f' });
    }

    for (const line of lines) {
      await drawLevelLine(line.price, line.label, line.color, line.origin || nowSec);
    }

    const summary = lines.map(l => `${l.label} ${l.price.toFixed(2)}`).join(' - ');
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = `NY prep - marked on chart at ${istTime} IST: ${summary}`;
    broadcast({ type: 'ny-levels', ok: true, time: istTime, lines, message });
    telegramBot.notify(`NY prep: ${message}`);
    console.log(`NY LEVELS MARKED: ${summary}`);
  } catch (e) {
    console.error('Mark NY levels error:', e.message);
    broadcast({ type: 'ny-levels', ok: false, status: 'error: ' + e.message });
  }
}

// ── ForexFactory → TradingView chart sync ──────────────────────────────────────
// ForexFactory is the timing source of truth: each red-folder (High impact)
// event's timestamp from the calendar feed is converted directly into a chart
// vertical_line, so the no-trade window is visible on the same TradingView
// chart Anoop is already watching — no separate lookup needed. On-demand only
// (button, WS message, or chained from markLondonLevels above) — this does
// NOT run on the 60s background recompute loop, since there is no de-dupe or
// draw_remove tool wired in here and that would keep stacking duplicate lines.
async function markNewsTimesOnChart() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'news-chart-marks', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const status = computeNewsStatus();
    const events = [];
    if (status.activeEvent) events.push({ ...status.activeEvent, color: '#d1293b' });
    events.push(...status.upcoming.map(e => ({ ...e, color: '#b5750a' })));

    if (!events.length) {
      broadcast({ type: 'news-chart-marks', ok: true, status: 'No red-folder events left today — nothing to mark.' });
      return;
    }

    const marked = [];
    for (const ev of events) {
      const tsMs = ev.ts || ev.until;
      if (!tsMs) continue;
      const tsSec = Math.floor(tsMs / 1000);
      try {
        await mcpBridge.callTool('draw_shape', {
          shape: 'vertical_line',
          point: { time: tsSec },
          text: `${ev.title} (${ev.country})`,
          overrides: JSON.stringify({ linecolor: ev.color, linewidth: 1, linestyle: 2 })
        });
        marked.push(ev.title);
      } catch (e) {
        console.error(`Draw news marker [${ev.title}] failed:`, e.message);
      }
    }

    const istNow = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = marked.length
      ? `ForexFactory → chart: marked ${marked.length} event time${marked.length === 1 ? '' : 's'} at ${istNow} IST — ${marked.join(', ')}`
      : 'Tried to mark news times but every draw call failed — see server log.';
    broadcast({ type: 'news-chart-marks', ok: marked.length > 0, status: message, marked });
    console.log(`NEWS TIMES MARKED ON CHART: ${marked.join(', ') || '(none)'}`);
  } catch (e) {
    console.error('Mark news times on chart error:', e.message);
    broadcast({ type: 'news-chart-marks', ok: false, status: 'error: ' + e.message });
  }
}

// ── Economic calendar / no-trade windows (ForexFactory) ────────────────────────
// Public weekly export feed (unofficial, but the same one most retail EAs/bots
// use since ForexFactory has no official API) — the provider rate-limits this
// to 2 requests / 5 minutes across ALL export formats combined, so the raw
// feed is cached hard (30 min). FIX (2026-07-18): real fetches now only happen
// at two explicit points (app start, ~10min before NY session — see
// startNewsTracking() and checkSessionPrep()), not on a timer. The 60s UI
// loop just recomputes blackout status from whatever's cached — it never
// fetches. A manual refresh (↻ button) bypasses the cache but still only
// costs one request; spamming it can still trip the provider's own limit, in
// which case it returns an HTML "Request Denied" page instead of JSON —
// detected below and handled by falling back to the last good cache rather
// than crashing or showing garbage.
const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const NEWS_BLACKOUT_BEFORE_MIN = 15;
const NEWS_BLACKOUT_AFTER_MIN = 15;

let newsCache = { events: null, at: 0, error: null };
let newsBlackoutWasActive = false;
let newsInterval = null;

async function fetchForexFactoryCalendar(force) {
  if (!force && newsCache.events && Date.now() - newsCache.at < NEWS_CACHE_TTL_MS) {
    return newsCache;
  }
  try {
    const res = await fetch(FF_CALENDAR_URL);
    const text = await res.text();
    let events;
    try {
      events = JSON.parse(text);
    } catch {
      newsCache = { ...newsCache, error: 'ForexFactory export rate-limited or blocked — showing last cached data' };
      console.error('ForexFactory calendar fetch: non-JSON response (likely rate-limited)');
      return newsCache;
    }
    newsCache = { events, at: Date.now(), error: null };
    console.log(`✓ ForexFactory calendar refreshed — ${events.length} events this week`);
  } catch (e) {
    newsCache = { ...newsCache, error: 'ForexFactory fetch failed: ' + e.message };
    console.error('ForexFactory calendar fetch error:', e.message);
  }
  return newsCache;
}

// "Red folder" = impact:"High". Bank holidays come through as their own
// impact value, "Holiday" — both are literal fields the feed already provides,
// no guessing/text-matching needed.
function classifyNewsEvents(events) {
  if (!Array.isArray(events)) return { redFolder: [], holidays: [] };
  return {
    redFolder: events.filter(e => e.impact === 'High'),
    holidays: events.filter(e => e.impact === 'Holiday')
  };
}

function isSameISTDate(tsMs, referenceIstDateStr) {
  const d = new Date(tsMs + 5.5 * 3600000);
  return d.toISOString().slice(0, 10) === referenceIstDateStr;
}

// Computes current blackout state + today's (IST calendar day) upcoming
// red-folder events and holidays, entirely from whatever's currently cached.
function computeNewsStatus() {
  const events = newsCache.events || [];
  const { redFolder, holidays } = classifyNewsEvents(events);
  const now = Date.now();

  const withWindow = redFolder.map(e => {
    const ts = new Date(e.date).getTime();
    return {
      title: e.title, country: e.country, date: e.date, ts,
      start: ts - NEWS_BLACKOUT_BEFORE_MIN * 60000,
      end: ts + NEWS_BLACKOUT_AFTER_MIN * 60000
    };
  });

  const active = withWindow.find(e => now >= e.start && now <= e.end) || null;
  const todayIstDateStr = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);

  const upcomingToday = withWindow
    .filter(e => e.ts >= now && isSameISTDate(e.ts, todayIstDateStr))
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 6);

  const holidaysToday = holidays.filter(e => isSameISTDate(new Date(e.date).getTime(), todayIstDateStr));

  return {
    inBlackout: !!active,
    // ts kept alongside until/start so downstream consumers (e.g. the
    // ForexFactory→TradingView chart marker) can place the marker at the
    // event's actual time, not just its blackout window edges.
    activeEvent: active ? { title: active.title, country: active.country, until: active.end, ts: active.ts } : null,
    upcoming: upcomingToday,
    holidaysToday: holidaysToday.map(e => ({ title: e.title, country: e.country })),
    cacheError: newsCache.error,
    cacheAt: newsCache.at
  };
}

async function refreshNewsAndBroadcast(force) {
  await fetchForexFactoryCalendar(force);
  broadcastNewsStatus();
}

function broadcastNewsStatus() {
  const status = computeNewsStatus();
  broadcast({ type: 'news-status', ...status });

  // Only push an alert on the transition INTO a blackout, not on every 60s
  // recompute while one is already active.
  if (status.inBlackout && !newsBlackoutWasActive) {
    const untilIst = new Date(status.activeEvent.until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const msg = `NO-TRADE WINDOW — ${status.activeEvent.title} (${status.activeEvent.country}) red-folder event. Hold off until ${untilIst} IST.`;
    telegramBot.notify(`🚫 ${msg}`);
    console.log(`NEWS BLACKOUT START: ${status.activeEvent.title}`);
  } else if (!status.inBlackout && newsBlackoutWasActive) {
    console.log('NEWS BLACKOUT ENDED');
  }
  newsBlackoutWasActive = status.inBlackout;
}

// FIX (2026-07-18, Anoop's ask): calendar re-FETCHES now happen at exactly two
// points — once here on app start, and once more from checkSessionPrep() ~10
// min before the NY session (not London). Previously this ran on a 60s
// setInterval calling refreshNewsAndBroadcast (which fetches); it was already
// cache-gated to ~1 real fetch/30min in steady state, but every app restart
// wipes the in-memory cache and forces an immediate real re-fetch+log — with
// several restarts in a session (e.g. while troubleshooting TradingView) that
// showed up as a burst of repeated "calendar refreshed" lines. The interval
// below no longer fetches at all — it only recomputes blackout status from
// whatever's already cached, so the no-trade-window indicator still updates
// live every minute without touching the network or logging a refresh.
function startNewsTracking() {
  refreshNewsAndBroadcast(false); // refresh #1: app start
  newsInterval = setInterval(() => broadcastNewsStatus(), 60 * 1000); // cheap recompute only, no fetch
}

function stopNewsTracking() {
  if (newsInterval) { clearInterval(newsInterval); newsInterval = null; }
}

// ── Session pre-open prep (mechanical, no LLM) ──────────────────────────────
// 10 minutes before London (1:30 PM IST) and NY (7:00 PM IST) session opens,
// auto-run the same PDH/PDL + Asia H/L zone marking as the manual "Mark
// London Levels" button, plus a Telegram heads-up. De-duped per IST calendar
// day per session so it fires once per occurrence, not every 60s tick.
const SESSION_WINDOWS = {
  london: { startMin: 13 * 60 + 30, endMin: 15 * 60, label: 'London' },
  ny:     { startMin: 19 * 60,      endMin: 21 * 60,  label: 'NY' }
};
const sessionPrepFired = { london: null, ny: null }; // IST date string of last fire, per session

function istNowMinutesAndDate() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  return { mins: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function checkSessionPrep() {
  const { mins, dateStr } = istNowMinutesAndDate();
  for (const [key, win] of Object.entries(SESSION_WINDOWS)) {
    const prepStart = win.startMin - 10;
    if (mins >= prepStart && mins < win.startMin && sessionPrepFired[key] !== dateStr) {
      sessionPrepFired[key] = dateStr;
      // CHANGED 2026-07-28 (Anoop): stop auto-marking chart levels on this
      // timer — he wants zones drawn ONLY when he explicitly asks (the
      // manual "Mark London/NY Levels" button, or a direct chat request),
      // never silently in the background. This block now only fires the
      // heads-up notification; the markLondonLevels()/markNYLevels() calls
      // that used to run automatically here are removed, not just disabled,
      // so a stray flag flip can't silently bring them back.
      const msg = `${win.label} session opens in ~10 min.`;
      telegramBot.notify(`🔔 ${msg}`);
      broadcast({ type: 'session-alert', session: key, message: msg });
      console.log(`SESSION PREP: ${msg}`);
      // FIX (2026-07-18): refresh #2 of exactly 2/day — NY only, not London.
      // force=true here since this is the one refresh that has to be current
      // (the pre-NY no-trade-window check), the app-start one already covers
      // the general case.
      if (key === 'ny') {
        try { await refreshNewsAndBroadcast(true); } catch (e) { console.error('Pre-NY news refresh failed:', e.message); }
      }
    }
  }
}

let sessionPrepInterval = null;
function startSessionPrepScheduler() {
  checkSessionPrep();
  sessionPrepInterval = setInterval(checkSessionPrep, 60 * 1000);
}
function stopSessionPrepScheduler() {
  if (sessionPrepInterval) { clearInterval(sessionPrepInterval); sessionPrepInterval = null; }
}

// ── MCP startup ────────────────────────────────────────────────────────────────
async function startMCP() {
  try {
    broadcast({ type: 'mcp-status', connected: false, message: 'Connecting to TradingView…' });
    mcpBridge.removeAllListeners();
    mcpBridge.on('status',         (msg) => broadcast({ type: 'mcp-status-msg', message: msg }));
    // 'connected'/'disconnected' = bridge child process itself (JSON-RPC handshake).
    // 'tv-connected'/'tv-disconnected' = heartbeat-verified TradingView CDP health —
    // this is the one that reflects reality, since the bridge process can stay
    // alive for hours after TradingView desktop itself has crashed. Fixed
    // 2026-07-15: the UI's "TradingView connected" light used to only track the
    // former, so it stayed green through TV crashes that broke every level-marking
    // button. Now it tracks both — either going false flips the indicator off.
    mcpBridge.on('connected',     ()    => broadcast({ type: 'mcp-status', connected: mcpBridge.ready && mcpBridge.tvConnected }));
    mcpBridge.on('disconnected',  ()    => broadcast({ type: 'mcp-status', connected: false, message: 'TradingView bridge disconnected' }));
    mcpBridge.on('tv-connected',  ()    => broadcast({ type: 'mcp-status', connected: true }));
    mcpBridge.on('tv-disconnected', (detail) => broadcast({ type: 'mcp-status', connected: false, message: 'TradingView disconnected' + (detail ? ': ' + detail : '') }));
    if (mcpBridge.ready) return;
    await mcpBridge.start();
  } catch (err) {
    broadcast({ type: 'mcp-status', connected: false, message: 'TradingView MCP: ' + err.message });
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────
async function handleTvTest(ws, msg) {
  const r = await tradovate.testConnection(loadConfig());
  send(ws, { type: 'tradovate-test-result', ...r });
}
function startTradovate() {
  const cfg = loadConfig();
  tradovate.stop();
  if (cfg.tvEnabled && cfg.tvName) tradovate.start(cfg, snap => broadcast({ type: 'tradovate-account', ...snap }));
}

// SINGLE-INSTANCE GUARD (2026-07-29, Anoop: "if i open two windows are opening
// in the browser"). Launching the app twice used to start a SECOND server that
// failed on the port but still ran `start http://localhost:7433`, leaving him
// with duplicate browser windows pointing at the same app — and no clear
// answer to "which one should be on". Now a second launch detects the running
// instance, just focuses/opens the existing app, and exits without starting
// anything. One server, one window, always.
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`\nCo-Pilot is already running on http://localhost:${PORT} — opening that instead of starting a second copy.\n`);
    try { require('child_process').exec(`start http://localhost:${PORT}`); } catch (e) {}
    process.exit(0);
  }
  console.error('HTTP server error:', err);
  process.exit(1);
});

httpServer.listen(PORT, '127.0.0.1', async () => {
  initDataDir();   // 2026-07-25: resolve D:\co-pilot DATA (or fall back) before anything writes
  startTradovate();
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Co-Pilot — http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  const cfg = loadConfig();
  if (cfg.apiKey) { claudeAgent.init(cfg.apiKey); console.log('✓ Claude API key loaded'); }
  else console.log('⚠  No API key — open Settings');
  if (cfg.geminiApiKey) { groqAgent.initGemini(cfg.geminiApiKey); console.log('✓ Gemini API key loaded (Jessi primary brain)'); }
  else console.log('⚠  No Gemini key — Jessi falls back to Groq (smaller 6-8K tokens/min ceiling). Free key: aistudio.google.com/apikey');
  if (cfg.groqApiKey) { groqAgent.init(cfg.groqApiKey); console.log('✓ Groq API key loaded (Jessi fallback + voice STT/TTS)'); }
  else console.log('⚠  No Groq key — Jessi chat falls back to offline mode until one is added in Settings');
  startJessiTVMonitor();
  console.log('✓ Jessi background chart monitor started (3-min cadence)');
  console.log(`✓ Mode: ${(cfg.mode || 'funded').toUpperCase()}`);

  try {
    telegramBot.start({
      loadConfig,
      saveConfig,
      getCurrentMode: () => currentMode,
      setCurrentMode,
      broadcast,
      engulfMonitors,
      ENGULF_TFS,
      startEngulfMonitor,
      stopEngulfMonitor,
      checkEngulfingSignal,
      sfpMonitors,
      SFP_TFS,
      startSFPMonitor,
      stopSFPMonitor,
      checkSFPSignal
    });
  } catch (e) {
    console.log('⚠ Telegram bot: failed to start —', e.message);
  }

  await startMCP();
  startNewsTracking();
  startMechanicalAnalysis();
  startSessionPrepScheduler();

  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
  console.log('✓ Opening in browser…');
});

process.on('SIGINT', () => {
  Object.keys(engulfMonitors).forEach(stopEngulfMonitor);
  Object.keys(fvgMonitors).forEach(stopFVGMonitor);
  Object.keys(sfpMonitors).forEach(stopSFPMonitor);
  stopNewsTracking();
  stopMechanicalAnalysis();
  stopSessionPrepScheduler();
  mcpBridge.stop();
  telegramBot.stop();
  process.exit(0);
});
