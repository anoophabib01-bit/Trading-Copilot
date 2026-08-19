// ── Persistent crash/console log (2026-08-13, /investigate) ──────────────────
// Root cause found: START CO-PILOT.bat launches the server as
// `start "Co-Pilot" cmd /k "node server.js"` — a plain console window with NO
// output redirection. The crash guards in server.js only console.error(). If
// that window is ever closed (overnight, Windows update, accidentally), every
// trace of a crash is gone permanently — which is exactly why "it crashes some
// evenings" could never be diagnosed: there was never any evidence to look at.
//
// This module mirrors console output to a dated file on disk WITHOUT changing
// what appears in the visible window — every console.log/warn/error still
// prints exactly as before, it's just ALSO written to logs/server-YYYY-MM-DD.log.
// Pure addition, nothing removed, nothing silenced.
//
// Deliberately its own tiny module (not inlined in server.js) so the mirroring
// logic is testable in isolation — the risk here is real: a bug in a logger
// that wraps console itself could break every log call in the app.

const fs = require('fs');
const path = require('path');

// One log file per calendar day (IST, matching every other date convention in
// this app), so a bad evening's log is easy to find without wading through a
// week of noise, and old days can be pruned independently.
function logFileNameFor(date) {
  const IST_OFF = 330 * 60 * 1000;
  const ist = new Date((date instanceof Date ? date.getTime() : Date.now()) + IST_OFF);
  return 'server-' + ist.toISOString().slice(0, 10) + '.log';
}

// Delete log files older than `keepDays` — logs/ is otherwise unbounded growth
// for a process meant to run every trading day indefinitely.
function pruneOldLogs(logsDir, keepDays) {
  keepDays = keepDays == null ? 14 : keepDays;
  let files;
  try { files = fs.readdirSync(logsDir); } catch (e) { return; }
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  files.forEach(f => {
    if (!/^server-\d{4}-\d{2}-\d{2}\.log$/.test(f)) return;
    try {
      const fp = path.join(logsDir, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch (e) { /* a locked/mid-write file failing to delete is fine, try next prune */ }
  });
}

// Wraps console.log/warn/error so every call ALSO appends a timestamped line
// to the current day's log file. Returns a restore() function (tests need to
// undo the patch; production never calls it — this runs for the process
// lifetime). Safe to call more than once — re-patching is a no-op if already
// patched, so requiring this module twice can't double-write every line.
let _patched = false;
function installConsoleMirror(logsDir) {
  if (_patched) return function restore() {};
  _patched = true;
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
  pruneOldLogs(logsDir);

  const original = { log: console.log, warn: console.warn, error: console.error };

  // Synchronous append, deliberately — NOT a buffered write stream. This
  // logger's entire purpose is to survive the moment the process crashes; an
  // async stream can still have the fatal line sitting unflushed in memory
  // when node exits, which would silently defeat the whole point. One
  // appendFileSync per log call costs a few microseconds and guarantees the
  // line is actually on disk before the next line of code runs.
  function mirror(level, args) {
    try {
      const line = '[' + new Date().toISOString() + '] [' + level + '] '
        + args.map(a => (a && a.stack) ? a.stack : (typeof a === 'string' ? a : safeStringify(a))).join(' ')
        + '\n';
      fs.appendFileSync(path.join(logsDir, logFileNameFor()), line);
    } catch (e) { /* mirroring must never be the thing that crashes the app it's logging */ }
  }

  function safeStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  console.log = function (...args) { original.log.apply(console, args); mirror('log', args); };
  console.warn = function (...args) { original.warn.apply(console, args); mirror('warn', args); };
  console.error = function (...args) { original.error.apply(console, args); mirror('error', args); };

  return function restore() {
    console.log = original.log; console.warn = original.warn; console.error = original.error;
    _patched = false;
  };
}

module.exports = { logFileNameFor, pruneOldLogs, installConsoleMirror };
