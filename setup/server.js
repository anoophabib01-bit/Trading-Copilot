#!/usr/bin/env node
/**
 * Trading Co-Pilot -- Setup Wizard server.
 *
 * STANDALONE. Runs on its own port (7434) and never touches the trading app,
 * its port (7433), or its live UI. It exists to answer one question for a new
 * trader: can this machine run the Co-Pilot, and what are YOUR rules?
 *
 * It reads and writes app/rules.json, backing up the previous file first.
 * It also writes app/profile.json for the non-rule metadata (name, firm).
 *
 * Nothing here places or reads orders.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Env overrides exist so the wizard can be tested against a COPY of rules.json
// instead of a live trading file. Normal use sets none of these.
const PORT = Number(process.env.COPILOT_SETUP_PORT) || 7434;
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const RULES_PATH = process.env.COPILOT_RULES_PATH || path.join(APP, 'rules.json');
const PROFILE_PATH = process.env.COPILOT_PROFILE_PATH || path.join(APP, 'profile.json');
const BACKUP_DIR = process.env.COPILOT_BACKUP_DIR || path.join(ROOT, 'setup', 'backups');
const MCP_DIR = path.join(ROOT, 'tradingview-mcp');
const SERVER_JS = path.join(APP, 'server.js');
const WIZARD = path.join(__dirname, 'wizard.html');

const CDP_PORT = 9222;

/* ---------------------------------------------------------------- utils */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    let tooBig = false;
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > 512 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', function () {
      if (tooBig) return reject(new Error('body too large'));
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + os.EOL, 'utf8');
  fs.renameSync(tmp, p);
}

function backupFile(p) {
  if (!fs.existsSync(p)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, path.basename(p) + '.' + stamp + '.bak');
  fs.copyFileSync(p, dest);
  return dest;
}

/* ------------------------------------------------------- environment probes */

function findTradingView() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:' + path.sep + 'Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:' + path.sep + 'Program Files (x86)';
  const candidates = [];
  if (local) {
    candidates.push(path.join(local, 'Programs', 'TradingView', 'TradingView.exe'));
    candidates.push(path.join(local, 'TradingView', 'TradingView.exe'));
    candidates.push(path.join(local, 'Microsoft', 'WindowsApps', 'TradingView.exe'));
  }
  candidates.push(path.join(pf, 'TradingView', 'TradingView.exe'));
  candidates.push(path.join(pf86, 'TradingView', 'TradingView.exe'));
  for (let i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
  }

  // Microsoft Store / MSIX installs land in WindowsApps under a versioned package
  // folder, so a fixed path will never match. Modern TradingView Desktop ships
  // this way, so scan the folder for any TradingView package.
  const waDirs = [
    path.join(pf, 'WindowsApps'),
    local ? path.join(local, 'Microsoft', 'WindowsApps') : null
  ].filter(Boolean);
  for (let d = 0; d < waDirs.length; d++) {
    try {
      const entries = fs.readdirSync(waDirs[d]);
      for (let i = 0; i < entries.length; i++) {
        if (/^31178TradingViewInc\.TradingView/i.test(entries[i]) || /tradingview/i.test(entries[i])) {
          const exe = path.join(waDirs[d], entries[i], 'TradingView.exe');
          try { if (fs.existsSync(exe)) return exe; } catch (e) {}
        }
      }
    } catch (e) {
      // WindowsApps is ACL-locked for normal users; a failure here is expected
      // and is exactly why the CDP check below is the authoritative signal.
    }
  }
  return null;
}

function checkPort(port) {
  return new Promise(function (resolve) {
    const sock = new net.Socket();
    let settled = false;
    function finish(open) {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve(open);
    }
    sock.setTimeout(1200);
    sock.once('connect', function () { finish(true); });
    sock.once('timeout', function () { finish(false); });
    sock.once('error', function () { finish(false); });
    sock.connect(port, '127.0.0.1');
  });
}

function getJson(pathname) {
  return new Promise(function (resolve) {
    const req = http.get(
      { host: '127.0.0.1', port: CDP_PORT, path: pathname, timeout: 2500 },
      function (res) {
        let body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      }
    );
    req.on('timeout', function () { req.destroy(); resolve(null); });
    req.on('error', function () { resolve(null); });
  });
}

/**
 * Any Chromium can hold port 9222, so "the port answers" is NOT proof the Co-Pilot
 * can run. The only trustworthy signal is a TradingView chart page in the target
 * list. Without this, a trader with Chrome remote debugging on gets a false PASS
 * and then the app silently fails against the wrong browser.
 */
function cdpVersion() {
  return getJson('/json/version').then(function (v) {
    if (!v || !v.webSocketDebuggerUrl) return { ok: false, isTradingView: false };
    return getJson('/json/list').then(function (targets) {
      const list = Array.isArray(targets) ? targets : [];
      const tv = list.filter(function (t) {
        const u = String(t && t.url || '');
        const ti = String(t && t.title || '');
        return /tradingview\.com/i.test(u) || /tradingview/i.test(ti);
      });
      return {
        ok: true,
        browser: v.Browser || null,
        isTradingView: tv.length > 0,
        chartCount: tv.length,
        chartUrl: tv.length ? String(tv[0].url || '') : null,
        otherTargets: list.length - tv.length
      };
    });
  });
}

function probe() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const tv = findTradingView();
  return cdpVersion().then(function (cdp) {
    return checkPort(CDP_PORT).then(function (portOpen) {
      const rulesExists = fs.existsSync(RULES_PATH);
      let rulesWritable = false;
      if (rulesExists) {
        try { fs.accessSync(RULES_PATH, fs.constants.W_OK); rulesWritable = true; }
        catch (e) { rulesWritable = false; }
      }
      const checks = [
        {
          id: 'node',
          label: 'Node.js 18 or newer',
          status: nodeMajor >= 18 ? 'pass' : 'fail',
          detail: 'Found v' + process.versions.node,
          fix: nodeMajor >= 18 ? null : 'Install Node.js 20 LTS from nodejs.org, then run SETUP.bat again.'
        },
        {
          id: 'app',
          label: 'Co-Pilot app files present',
          status: fs.existsSync(SERVER_JS) ? 'pass' : 'fail',
          detail: fs.existsSync(SERVER_JS) ? SERVER_JS : 'server.js not found at ' + SERVER_JS,
          fix: null
        },
        {
          id: 'bridge',
          label: 'TradingView bridge present',
          status: fs.existsSync(MCP_DIR) ? 'pass' : 'fail',
          detail: fs.existsSync(MCP_DIR) ? MCP_DIR : 'tradingview-mcp folder missing',
          fix: null
        },
        {
          id: 'tradingview',
          label: 'TradingView Desktop installed',
          status: (tv || cdp.isTradingView) ? 'pass' : 'warn',
          detail: tv
            ? tv
            : (cdp.isTradingView
                ? 'Confirmed by a live TradingView chart on the debug port'
                : 'Not found in the usual install locations'),
          fix: (tv || cdp.isTradingView) ? null : 'Install TradingView Desktop from tradingview.com/desktop. The Co-Pilot reads your chart, so it needs the desktop app -- the browser version will not work.'
        },
        {
          id: 'cdp',
          label: 'TradingView debug port live (9222)',
          status: cdp.isTradingView ? 'pass' : (cdp.ok ? 'fail' : (portOpen ? 'warn' : 'pending')),
          detail: cdp.isTradingView
            ? 'Connected to TradingView. ' + cdp.chartCount + ' chart tab(s) open.'
            : (cdp.ok
                ? 'Port 9222 answered, but it is NOT TradingView (' + (cdp.browser || 'unknown browser') + (typeof cdp.otherTargets === 'number' && cdp.otherTargets > 0 ? ', ' + cdp.otherTargets + ' other tab(s)' : '') + '). The Co-Pilot would read the wrong window.'
                : (portOpen
                    ? 'Port 9222 is held by something that did not answer the debug handshake.'
                    : 'Not running yet. This is expected before your first launch.')),
          fix: cdp.isTradingView ? null : 'Start TradingView with START CO-PILOT.bat. If Chrome or another app already owns port 9222, close it first -- the Co-Pilot attaches to that port and would read the wrong window.'
        },
        {
          id: 'rules',
          label: 'Rules file present and writable',
          status: rulesExists ? (rulesWritable ? 'pass' : 'fail') : 'warn',
          detail: rulesExists ? RULES_PATH : 'No rules.json yet -- the wizard will create one',
          fix: (rulesExists && !rulesWritable) ? 'Close the Co-Pilot and any editor holding rules.json, then try again.' : null
        }
      ];
      const blocking = checks.filter(function (c) { return c.status === 'fail'; });
      return {
        ok: blocking.length === 0,
        node: process.versions.node,
        platform: process.platform,
        checks: checks,
        tradingViewPath: tv,
        cdp: cdp,
        rulesPath: RULES_PATH,
        profilePath: PROFILE_PATH
      };
    });
  });
}

/* ------------------------------------------------------------------ rules */

/**
 * Sanity checks on the answers, returned to the wizard so it can warn BEFORE
 * anything is written. These are warnings, never blocks -- the trader owns
 * these numbers, and the app has no business refusing to record a choice.
 */
function validateAnswers(a) {
  const out = [];
  const loss = function (v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.abs(n) : null;
  };
  const y = loss(a.tierYellow);
  const r = loss(a.tierRed);
  const h = loss(a.tierHard);
  const dll = loss(a.firmDailyLossLimit);
  const dayEval = loss(a.dayStopEval);
  const dayFunded = loss(a.dayStopFunded);
  const perTrade = loss(a.perTradeMaxLoss);

  if (y != null && r != null && r < y) {
    out.push('Red warning (' + r + ') is tighter than yellow (' + y + '). Red should be the larger loss.');
  }
  if (r != null && h != null && h < r) {
    out.push('Hard stop (' + h + ') is tighter than red (' + r + '). Hard should be the largest loss.');
  }
  if (h != null && dll != null && h > dll) {
    out.push('Hard stop ' + h + ' is past your firm daily loss limit of ' + dll +
             '. Your firm will liquidate the account before your own stop is reached.');
  }
  if (dayEval != null && h != null && dayEval > h) {
    out.push('Evaluation day-stop ' + dayEval + ' is looser than your hard tier ' + h +
             '. The tier will end the session first, so the day-stop can never fire.');
  }
  if (dayFunded != null && h != null && dayFunded > h) {
    out.push('Funded day-stop ' + dayFunded + ' is looser than your hard tier ' + h + '.');
  }
  if (perTrade != null && h != null && perTrade > h) {
    out.push('Max loss per trade ' + perTrade + ' is larger than your hard daily tier ' + h +
             '. A single stop-out would end the day.');
  }
  const evalCap = loss(a.evalSizeCap);
  const fundCap = loss(a.fundedSizeCap);
  if (evalCap != null && fundCap != null && fundCap > evalCap) {
    out.push('Funded size cap (' + fundCap + ') is larger than the evaluation cap (' + evalCap +
             '). Funded is normally the tighter account.');
  }
  if (dll == null) out.push('No firm daily loss limit set. Everything that warns you depends on it.');
  return out;
}

/**
 * Take the wizard answers and apply ONLY the keys the wizard owns onto the
 * existing rules.json shape. Everything else -- comments, firm limits the
 * wizard does not model, scalper overlays -- is preserved untouched.
 */
function applyAnswers(base, a) {
  const out = JSON.parse(JSON.stringify(base || {}));

  const num = function (v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  // A loss threshold, normalised to a negative number. null when not supplied.
  const asLoss = function (v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return -Math.abs(n);
  };

  out.sizeCap = num(a.sizeCap, out.sizeCap);
  out.sizeFloor = num(a.sizeFloor, out.sizeFloor);
  out.perTradeMaxLoss = num(a.perTradeMaxLoss, out.perTradeMaxLoss);
  out.cooldownMinutes = num(a.cooldownMinutes, out.cooldownMinutes);
  out.tradesPerSession = num(a.tradesPerSession, out.tradesPerSession);
  out.tradesPerDay = num(a.tradesPerDay, out.tradesPerDay);

  out.tradeLimit = out.tradeLimit || {};
  out.tradeLimit.eval = num(a.tradeLimitEval, out.tradeLimit.eval);
  out.tradeLimit.funded = num(a.tradeLimitFunded, out.tradeLimit.funded);

  const dll = num(a.firmDailyLossLimit, 1000);

  // Warning tiers are the trader's OWN tighter stops, not a derivation from the
  // firm's limit -- so explicit values always win. Only when they are all blank
  // do we fall back to the 50/70/100% of the firm's daily loss limit. Accepts
  // either sign: -250 and 250 both mean a $250 loss.
  const tierY = asLoss(a.tierYellow);
  const tierR = asLoss(a.tierRed);
  const tierH = asLoss(a.tierHard);
  if (tierY != null && tierR != null && tierH != null) {
    out.dailyLossTiers = { yellow: tierY, red: tierR, hard: tierH };
  } else {
    out.dailyLossTiers = {
      yellow: -Math.round(dll * 0.5),
      red: -Math.round(dll * 0.7),
      hard: -dll
    };
  }

  out.dayStop = out.dayStop || {};
  out.dayStop.eval = num(a.dayStopEval, out.dayStop.eval);
  out.dayStop.funded = num(a.dayStopFunded, out.dayStop.funded);

  if (Array.isArray(a.sessionWindows) && a.sessionWindows.length) {
    out.sessionWindows = a.sessionWindows.map(function (w) {
      return {
        name: String(w.name || 'Session'),
        tz: String(w.tz || 'America/New_York'),
        startLocal: String(w.startLocal || '09:30'),
        endLocal: String(w.endLocal || '11:30')
      };
    });
  }

  out.firmLimits = out.firmLimits || {};
  out.firmLimits.firm = String(a.firm || out.firmLimits.firm || 'Unknown');
  out.firmLimits.product = String(a.product || out.firmLimits.product || 'Evaluation');
  out.firmLimits.dailyLossLimit = dll;
  if (a.eodThresholdDrawdown != null) {
    out.firmLimits.eodThresholdDrawdown = num(a.eodThresholdDrawdown, out.firmLimits.eodThresholdDrawdown);
  }
  if (a.profitTarget != null) {
    out.firmLimits.profitTarget = num(a.profitTarget, out.firmLimits.profitTarget);
  }
  out.firmLimits.confirmedOn = new Date().toISOString().slice(0, 10);
  out.firmLimits._wizardNote =
    'Written by the setup wizard on ' + new Date().toISOString() + '. Verify these numbers against your own prop firm dashboard before trading.';

  if (a.tradingMode === 'standard' || a.tradingMode === 'scalper') {
    out.tradingMode = a.tradingMode;
  }

  out.stageRules = out.stageRules || {};
  out.stageRules.eval = out.stageRules.eval || {};
  out.stageRules.funded = out.stageRules.funded || {};
  out.stageRules.eval.sizeCap = num(a.evalSizeCap, out.stageRules.eval.sizeCap);
  out.stageRules.funded.sizeCap = num(a.fundedSizeCap, out.stageRules.funded.sizeCap);
  out.stageRules.funded.sizeFloor = num(a.fundedSizeCap, out.stageRules.funded.sizeFloor);

  out._setupWizard = {
    completedAt: new Date().toISOString(),
    version: 1,
    note: 'Written by setup/wizard.html. Numbers here come from the trader, not from the original author. Re-run SETUP.bat to change them.'
  };

  return out;
}

/* ----------------------------------------------------------------- server */

const server = http.createServer(function (req, res) {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/setup' || url === '/index.html')) {
    fs.readFile(WIZARD, function (err, buf) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('wizard.html not found next to server.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url === '/api/probe') {
    probe().then(function (p) { sendJson(res, 200, p); })
      .catch(function (e) { sendJson(res, 500, { ok: false, error: String(e && e.message) }); });
    return;
  }

  if (req.method === 'GET' && url === '/api/current') {
    const rules = readJsonFile(RULES_PATH) || {};
    const profile = readJsonFile(PROFILE_PATH) || {};
    sendJson(res, 200, { rules: rules, profile: profile, exists: fs.existsSync(RULES_PATH) });
    return;
  }

  if (req.method === 'POST' && url === '/api/save') {
    readBody(req).then(function (body) {
      // A save writes the file the live app trades from. It must be something a
      // human deliberately asked for, never a stray request, a replayed one, or
      // an accidental reload. The UI sets confirm:true only on the button click.
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: 'refused: /api/save requires confirm:true (write it from the wizard button, not directly)' });
        return;
      }
      const answers = body.answers || {};
      const base = readJsonFile(RULES_PATH) || {};
      const next = applyAnswers(base, answers);

      const rulesBackup = backupFile(RULES_PATH);
      writeJsonAtomic(RULES_PATH, next);
      console.log('[save] ' + new Date().toISOString() + ' wrote ' + RULES_PATH + '  (backup: ' + (rulesBackup || 'none') + ')');

      const profile = {
        traderName: String(answers.traderName || '').trim(),
        instruments: Array.isArray(answers.instruments) ? answers.instruments : [],
        firm: String(answers.firm || ''),
        product: String(answers.product || ''),
        accountSize: Number(answers.accountSize) || null,
        timezone: String(answers.timezone || ''),
        playbooks: Array.isArray(answers.playbooks) ? answers.playbooks : [],
        writtenAt: new Date().toISOString()
      };
      const profileBackup = backupFile(PROFILE_PATH);
      writeJsonAtomic(PROFILE_PATH, profile);

      sendJson(res, 200, {
        ok: true,
        wrote: [RULES_PATH, PROFILE_PATH],
        backups: [rulesBackup, profileBackup].filter(Boolean),
        warnings: validateAnswers(answers),
        next: 'Run START CO-PILOT.bat, then complete the Checklist tab before your first entry.'
      });
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: String(e && e.message) });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', function () {
  const url = 'http://127.0.0.1:' + PORT + '/';
  console.log('');
  console.log('  Trading Co-Pilot -- Setup Wizard');
  console.log('  ------------------------------------------');
  console.log('  Open: ' + url);
  console.log('  Writes: ' + RULES_PATH);
  console.log('  Backups: ' + BACKUP_DIR);
  console.log('');
  console.log('  Leave this window open while you use the wizard.');
  console.log('  Press Ctrl+C here when you are done.');
  console.log('');
  if (process.platform === 'win32') {
    try {
      execFile('cmd', ['/c', 'start', '', url], function () {});
    } catch (e) {
      console.log('  (Could not open a browser automatically. Open the URL above by hand.)');
    }
  }
});
