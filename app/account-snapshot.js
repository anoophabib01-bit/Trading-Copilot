// ── Snapshot-before-destroy for account data (2026-09-04) ────────────────────
//
// WHY THIS EXISTS
// On 2026-09-04 at 18:56, DATA/accounts/s1/ was emptied mid-session:
// day_trades.json (10 trading days, 97 trades), gr_history.json,
// balance_ledger.json and ALL TEN of their .bak-* files disappeared together.
// The data survived only by luck — account_archives.json happens to embed a
// whole localStorage blob, so it was recoverable to DATA/_recovered_20260904/.
// That is not a backup strategy, that is a coincidence.
//
// It was also the SECOND incident. day_trades.json.bak-clobbered-by-s2-20260903
// is still sitting in the repo from the first one.
//
// THE TWO DOORS, and why the per-file .bak convention did not hold either shut:
//
//   1. dataWipeAccount()  — fs.rmSync(accounts/<slot>, {recursive, force}).
//      The "Start fresh" button. It removes the folder, which takes the .bak
//      files with it. Every previous safety net lived INSIDE the thing being
//      deleted. That is the shape of the 18:56 loss exactly: the .json files
//      and their backups gone together, the folder recreated minutes later.
//
//   2. dataSave()         — atomic overwrite of one per-account file.
//      A breach/clear/payout reset writes an empty store over a full one. The
//      write is atomic, which makes it reliably complete — not reversible.
//
// So snapshots are written OUTSIDE the slot folder, to DATA/_snapshots/, where
// a recursive delete of the account cannot reach them.
//
// DESIGN RULES, each one load-bearing:
//
//   * NEVER throw into the caller. This runs immediately before a reset the
//     user asked for. A backup that turns "start fresh" into a crash on a live
//     trading account is worse than the data loss it prevents. Every entry
//     point returns a result object; nothing propagates.
//
//   * NEVER snapshot a growing write. dataSave() is called on every logged
//     trade. Snapshotting each one would write thousands of copies and bury
//     the four that matter. isDestructiveSave() below is the whole filter:
//     only a write that EMPTIES or SHRINKS an existing store qualifies.
//
//   * NEVER prune to zero. Retention drops the oldest beyond `keep`, but if
//     that ever computed "delete everything" it would reproduce the bug it
//     exists to prevent.
//
// The policy half is pure and unit-tested; the fs half is deliberately thin.

const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = 20;

// ── Policy (pure) ──────────────────────────────────────────────────────────

/**
 * How many records does a stored payload hold?
 * Arrays → length. Objects (the day-keyed stores) → key count. Anything else
 * (a scalar, a string) → null, meaning "not countable", which callers treat as
 * "cannot judge" rather than as zero.
 */
function countEntries(value) {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return null;
}

/**
 * Is this save about to destroy data that is already on disk?
 *
 * Deliberately conservative in BOTH directions:
 *   - returns false when there is nothing to lose (no prior file, empty prior),
 *     so a fresh slot does not accumulate snapshots of nothing;
 *   - returns false when either side is not countable, because guessing wrong
 *     in that direction only costs a missed snapshot, while guessing wrong the
 *     other way fires on every ordinary write and makes the feature useless.
 *
 * @returns {{destructive: boolean, reason: string, before: number|null, after: number|null}}
 */
function isDestructiveSave(prev, next) {
  const before = countEntries(prev);
  const after = countEntries(next);

  if (prev == null) return { destructive: false, reason: 'no prior data', before, after };
  if (before === null || after === null) {
    return { destructive: false, reason: 'not countable', before, after };
  }
  if (before === 0) return { destructive: false, reason: 'prior was empty', before, after };
  if (after === 0) return { destructive: true, reason: 'emptied', before, after };
  if (after < before) return { destructive: true, reason: 'shrank', before, after };
  return { destructive: false, reason: 'grew or unchanged', before, after };
}

/**
 * Directory name for one snapshot: sortable timestamp + why it was taken.
 * Colons are stripped because Windows will not accept them in a path — this
 * repo runs on Windows and that is not a hypothetical.
 */
function snapshotDirName(when, reason) {
  const iso = (when instanceof Date ? when : new Date(when)).toISOString();
  const stamp = iso.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safe = String(reason || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return stamp + '__' + safe;
}

/**
 * Which snapshot directories to delete, keeping the newest `keep`.
 * Names sort lexicographically because snapshotDirName() is ISO-prefixed.
 * Returns [] whenever pruning would not clearly leave survivors.
 */
function prunePlan(dirNames, keep) {
  const k = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP;
  const names = (Array.isArray(dirNames) ? dirNames : []).filter(Boolean).slice().sort();
  if (names.length <= k) return [];
  return names.slice(0, names.length - k);
}

// ── Filesystem (thin) ──────────────────────────────────────────────────────

function safeSlotId(slotId) {
  return /^[a-zA-Z0-9_-]+$/.test(String(slotId || '')) ? String(slotId) : null;
}

function snapshotRoot(dataDir, slotId) {
  return path.join(dataDir, '_snapshots', slotId);
}

/**
 * Copy every top-level *.json in an account's folder to
 * DATA/_snapshots/<slot>/<stamp>__<reason>/ before something destroys it.
 *
 * Only top-level .json: that is the trading record. Screenshots live in a
 * subfolder and can be hundreds of megabytes; copying those on every reset
 * would make the guard expensive enough that someone eventually turns it off.
 *
 * @returns {{ok: boolean, skipped?: string, dir?: string, files?: string[], error?: string}}
 */
function snapshotSlot(opts) {
  const o = opts || {};
  try {
    const slotId = safeSlotId(o.slotId);
    if (!slotId) return { ok: false, skipped: 'bad-slot-id' };
    const dataDir = o.dataDir;
    if (!dataDir) return { ok: false, skipped: 'no-data-dir' };

    const srcDir = path.join(dataDir, 'accounts', slotId);
    if (!fs.existsSync(srcDir)) return { ok: false, skipped: 'no-slot-dir' };

    const names = fs.readdirSync(srcDir).filter((f) => {
      if (!f.toLowerCase().endsWith('.json')) return false;
      try { return fs.statSync(path.join(srcDir, f)).isFile(); } catch (e) { return false; }
    });
    if (!names.length) return { ok: false, skipped: 'nothing-to-copy' };

    const destDir = path.join(snapshotRoot(dataDir, slotId), snapshotDirName(o.now || new Date(), o.reason));
    fs.mkdirSync(destDir, { recursive: true });

    const copied = [];
    for (const name of names) {
      try {
        fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
        copied.push(name);
      } catch (e) {
        // One unreadable file must not abort the rest — a partial snapshot is
        // strictly better than none, and the manifest records what got through.
        console.warn('[snapshot] could not copy', name + ':', e.message);
      }
    }

    // The manifest is what makes a snapshot folder self-explaining six weeks
    // later, when nobody remembers which button produced it.
    try {
      fs.writeFileSync(path.join(destDir, '_manifest.json'), JSON.stringify({
        slotId,
        reason: o.reason || 'unknown',
        takenAt: (o.now instanceof Date ? o.now : new Date()).toISOString(),
        detail: o.detail || null,
        files: copied,
      }, null, 2), 'utf8');
    } catch (e) { /* the copies matter, the manifest is a convenience */ }

    pruneSnapshots(dataDir, slotId, o.keep);
    return { ok: true, dir: destDir, files: copied };
  } catch (e) {
    console.error('[snapshot] failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function pruneSnapshots(dataDir, slotId, keep) {
  try {
    const root = snapshotRoot(dataDir, slotId);
    if (!fs.existsSync(root)) return [];
    const dirs = fs.readdirSync(root).filter((f) => {
      try { return fs.statSync(path.join(root, f)).isDirectory(); } catch (e) { return false; }
    });
    const doomed = prunePlan(dirs, keep);
    for (const d of doomed) {
      try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch (e) {}
    }
    return doomed;
  } catch (e) { return []; }
}

/**
 * The dataSave() hook. Reads what is currently on disk, asks the policy whether
 * the incoming write destroys it, and snapshots only if so.
 *
 * `filePath` is read rather than passed in because dataSave() does not read the
 * old value — and adding a read to the hot path of every trade log would be a
 * worse trade than the one read this makes on a save that is already rare.
 */
function snapshotIfDestructive(opts) {
  const o = opts || {};
  try {
    if (!o.filePath || !fs.existsSync(o.filePath)) return { ok: false, skipped: 'no-existing-file' };
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(o.filePath, 'utf8')); }
    catch (e) { return { ok: false, skipped: 'unreadable-prior' }; }

    const verdict = isDestructiveSave(prev, o.next);
    if (!verdict.destructive) return { ok: false, skipped: verdict.reason };

    const res = snapshotSlot({
      dataDir: o.dataDir,
      slotId: o.slotId,
      reason: o.reason || 'overwrite',
      now: o.now,
      keep: o.keep,
      detail: { key: o.key || null, before: verdict.before, after: verdict.after, why: verdict.reason },
    });
    if (res.ok) {
      console.log(`[snapshot] ${o.slotId}: ${verdict.reason} (${verdict.before} → ${verdict.after}) — saved ${res.files.length} file(s) to ${path.basename(res.dir)}`);
    }
    return res;
  } catch (e) {
    console.error('[snapshot] hook failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  countEntries,
  isDestructiveSave,
  snapshotDirName,
  prunePlan,
  snapshotSlot,
  snapshotIfDestructive,
  pruneSnapshots,
  DEFAULT_KEEP,
};
