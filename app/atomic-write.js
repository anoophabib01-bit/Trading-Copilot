'use strict';
/**
 * atomic-write.js — crash-safe file writes (task #32, 2026-08-12)
 *
 * THE PROBLEM THIS SOLVES
 * Every persisted file in this app — trade history, guardrail history, rules,
 * config, session logs — was written with a bare fs.writeFileSync(). That call
 * TRUNCATES the target to zero bytes first, then writes. If the process dies in
 * between, the file is left empty or half-written.
 *
 * That is not theoretical here. server.js installs uncaughtException and
 * unhandledRejection handlers specifically because this process DOES hit
 * unexpected errors mid-session, and it runs monitors, three AI backends and a
 * CDP bridge while Anoop has live money on. A crash landing inside a write to
 * day_trades.json costs him a trade history that cannot be reconstructed from
 * anywhere — the broker CSV has fills, not his grades, flags or notes.
 *
 * THE FIX
 * Write to a temp file in the SAME directory, flush it to disk, then rename over
 * the target. rename() is atomic on POSIX and on Windows/NTFS for same-volume
 * moves, so a reader either sees the complete old file or the complete new one —
 * never a truncated one. Same-directory matters: a cross-volume rename silently
 * degrades to copy+delete and loses atomicity.
 *
 * The fsync before rename is the part that is easy to skip and wrong to skip:
 * without it the rename can reach disk before the data does, so a power loss
 * leaves a correctly-named file with garbage in it.
 */
const fs = require('fs');
const path = require('path');

/**
 * Atomically write `data` to `filePath`.
 * Falls back to a plain write if anything about the atomic path fails, because
 * a failed save is worse than a non-atomic save — losing today's trades to
 * protect against a hypothetical crash would be the wrong trade.
 *
 * @returns {{ok:boolean, atomic:boolean, error?:string}}
 */
function writeAtomic(filePath, data, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  // Same directory (so rename stays on one volume) + pid/time suffix so two
  // concurrent writers can never collide on the temp name.
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.tmp');
  let fd = null;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);          // force bytes to disk BEFORE the rename
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, filePath);
    return { ok: true, atomic: true };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    // Last resort: a plain write. Not atomic, but the data is saved.
    try {
      fs.writeFileSync(filePath, data, encoding);
      return { ok: true, atomic: false, error: e.message };
    } catch (e2) {
      return { ok: false, atomic: false, error: e2.message };
    }
  }
}

/** Convenience for the JSON.stringify(...) + write pattern used throughout. */
function writeJsonAtomic(filePath, value, indent = 2) {
  return writeAtomic(filePath, JSON.stringify(value, null, indent), 'utf8');
}

/**
 * Remove any temp files left behind by a crash mid-write. Safe to call at boot:
 * these are always disposable — a temp file that still exists is by definition
 * one whose rename never completed, so its contents were never the live file.
 */
function cleanupTemps(dir) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^\..*\.\d+\.\d+\.tmp$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (_) {}
      }
    }
  } catch (_) {}
  return removed;
}

module.exports = { writeAtomic, writeJsonAtomic, cleanupTemps };
