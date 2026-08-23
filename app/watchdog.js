'use strict';
// ── Server-process watchdog (2026-08-19, SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 1) ──
// The server crashed at 20:54 IST one night and stayed dead 15+ hours through
// an entire NY session with nothing telling Anoop. This is a SEPARATE process
// from server.js on purpose — if server.js dies (or the whole node process
// hangs), this must keep polling and alerting rather than dying with it.
//
// Deliberately dependency-free (plain http, child_process, fs — nothing from
// package.json) so it can never fail to start because npm install drifted.
//
// Run it with: watchdog.bat (same directory) — see that file for why it's a
// separate optional launch step, not wired into START CO-PILOT.bat directly.

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 7433;
const POLL_MS = 45 * 1000; // 30-60s window per spec; 45s splits the difference
const HEALTH_TIMEOUT_MS = 10 * 1000;
const RELAUNCH_COOLDOWN_MS = 5 * 60 * 1000; // never hammer launch.bat in a crash loop
const APP_DIR = __dirname;
const LOG_DIR = path.join(APP_DIR, 'logs');

let lastRelaunchAt = 0;

function istStamp() {
  const IST_OFF = 330 * 60 * 1000;
  const ist = new Date(Date.now() + IST_OFF);
  return ist.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

function logLine(msg) {
  const line = `[${istStamp()}] ${msg}`;
  // Console output is the last-resort channel if even file logging fails —
  // this watchdog must never throw its way into silence, which is the exact
  // failure mode it exists to catch for the thing it's watching.
  try { console.log(line); } catch (e) { /* nothing more we can do */ }
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const IST_OFF = 330 * 60 * 1000;
    const ist = new Date(Date.now() + IST_OFF);
    const fname = 'watchdog-' + ist.toISOString().slice(0, 10) + '.log';
    fs.appendFileSync(path.join(LOG_DIR, fname), line + '\n');
  } catch (e) { /* disk full / locked — still logged to console above */ }
}

// Windows-visible alert with no new dependency: msg.exe ships with every
// Windows install and pops a modal dialog to the interactive session, which
// is what a 15-hour-silent overnight crash actually needs — a console log
// line nobody is looking at is exactly the failure mode being fixed.
// Telegram is deliberately NOT used here — Anoop explicitly disabled it
// (see CLAUDE.md/TODOS.md, 2026-08-11 decision) and this task says not to
// re-enable it even for this.
function alertWindows(message) {
  try {
    const child = spawn('msg.exe', ['*', '/TIME:0', message], {
      windowsHide: false,
      stdio: 'ignore',
    });
    child.on('error', (e) => {
      // msg.exe can be missing/blocked on Home editions or by group policy —
      // fail soft, the file log above already has the record.
      logLine(`[alert] msg.exe unavailable (${e.message}) — alert only in log file`);
    });
  } catch (e) {
    logLine(`[alert] failed to spawn msg.exe: ${e.message}`);
  }
}

function checkHealth() {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.get({ host: 'localhost', port: PORT, path: '/', timeout: HEALTH_TIMEOUT_MS }, (res) => {
      // Any response at all (even a 404/500 from the app) proves the process
      // is alive and the port is bound — that's the fact this checks, not
      // whether a particular route returns 200.
      res.resume();
      if (!settled) { settled = true; resolve(true); }
    });
    req.on('error', () => { if (!settled) { settled = true; resolve(false); } });
    req.on('timeout', () => {
      if (!settled) { settled = true; resolve(false); }
      try { req.destroy(); } catch (e) { /* ignore */ }
    });
  });
}

function attemptRelaunch() {
  const now = Date.now();
  if (now - lastRelaunchAt < RELAUNCH_COOLDOWN_MS) {
    logLine(`[relaunch] skipped — last relaunch attempt was ${Math.round((now - lastRelaunchAt) / 1000)}s ago, cooldown is ${RELAUNCH_COOLDOWN_MS / 1000}s`);
    return;
  }
  lastRelaunchAt = now;
  const launchBat = path.join(APP_DIR, 'launch.bat');
  if (!fs.existsSync(launchBat)) {
    logLine(`[relaunch] launch.bat not found at ${launchBat} — cannot attempt relaunch`);
    return;
  }
  logLine('[relaunch] server unreachable — attempting one relaunch via launch.bat');
  try {
    // launch.bat itself kills whatever holds :7433 then starts fresh node
    // server.js — it does not touch TradingView, matching this task's
    // instruction not to. detached + unref so the watchdog's own process
    // isn't tied to the launched window and can keep polling immediately.
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/D', APP_DIR, 'launch.bat'], {
      cwd: APP_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    child.on('error', (e) => logLine(`[relaunch] spawn failed: ${e.message}`));
  } catch (e) {
    logLine(`[relaunch] exception during spawn: ${e.message}`);
  }
}

let consecutiveFailures = 0;
let alertedThisOutage = false;

async function pollOnce() {
  let healthy = false;
  try {
    healthy = await checkHealth();
  } catch (e) {
    // checkHealth() already resolves rather than rejects on any failure, but
    // this is the "more bulletproof than the thing it watches" belt-and-braces
    // catch anyway — nothing in this loop is allowed to throw uncaught.
    logLine(`[watchdog] checkHealth threw unexpectedly: ${e && e.message}`);
    healthy = false;
  }

  if (healthy) {
    if (consecutiveFailures > 0) {
      logLine(`[watchdog] server recovered after ${consecutiveFailures} failed check(s)`);
    }
    consecutiveFailures = 0;
    alertedThisOutage = false;
    return;
  }

  consecutiveFailures += 1;
  logLine(`[watchdog] health check FAILED (consecutive: ${consecutiveFailures}) — http://localhost:${PORT}/ unreachable`);

  if (!alertedThisOutage) {
    alertedThisOutage = true;
    const msg = `MNQ Co-Pilot server is DOWN (port ${PORT} unreachable) as of ${istStamp()}. Attempting one automatic relaunch.`;
    alertWindows(msg);
    attemptRelaunch();
  }
}

function main() {
  logLine(`[watchdog] starting — polling http://localhost:${PORT}/ every ${POLL_MS / 1000}s`);
  // Fire one check immediately (don't wait a full interval to notice a server
  // that was already down when the watchdog itself was started).
  pollOnce().catch((e) => logLine(`[watchdog] unexpected error in initial poll: ${e && e.message}`));
  setInterval(() => {
    pollOnce().catch((e) => logLine(`[watchdog] unexpected error in poll loop: ${e && e.message}`));
  }, POLL_MS);
}

process.on('uncaughtException', (e) => {
  // The watchdog must survive its own bugs too — this is the process meant to
  // outlive server.js's crash guards, so it needs the same discipline one
  // level up, with nothing left above it to catch anything further.
  try { logLine(`[watchdog] uncaughtException (survived): ${e && e.stack || e}`); } catch (_) { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
  try { logLine(`[watchdog] unhandledRejection (survived): ${e && e.stack || e}`); } catch (_) { /* ignore */ }
});

main();
