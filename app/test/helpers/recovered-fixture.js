'use strict';
// ── recovered-fixture.js — a stable home for the REPLAY tests ───────────────
//
// (2026-09-05.)
//
// week-rollup.test.js and week-store.test.js each contain a REPLAY: they fold
// a week Anoop actually reviewed by hand and assert the exact figures he saw.
// Those are the most valuable tests in either file — they are the only thing
// proving the fold reproduces a real week rather than merely being internally
// consistent.
//
// They read `DATA/accounts/s1`, and on 2026-09-04 that account was archived and
// reset. Its history moved to `DATA/_recovered_20260904/` under a FLAT naming
// scheme (`s1_breached_20260829_gr_history.json`), while `week-store.buildWeek`
// needs the nested `<root>/accounts/<slot>/<name>.json` layout. So the tests
// went red, and the tempting repair was to delete them.
//
// This materialises the recovered snapshot into the layout the fold expects,
// in a temp directory, at test time. Two properties make it the right fix:
//
//   - The SOURCE is immutable. `_recovered_20260904/` is a frozen snapshot; a
//     replay anchored to it asserts the same numbers forever, which is exactly
//     what a regression test of a hand-checked week should do. Anchoring to a
//     live account was the original mistake — the account moved on and took the
//     test with it.
//   - Nothing is copied INTO the repo. The fixture is built in os.tmpdir() and
//     the snapshot stays the single copy of that data.
//
// If the snapshot is ever missing, `available()` returns false and the callers
// skip rather than fail: a replay you cannot source is untested, not broken.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RECOVERED = path.join(__dirname, '..', '..', '..', 'DATA', '_recovered_20260904');
const PREFIX = 's1_breached_20260829_';
// Everything buildWeek() reads out of an account directory. Files absent from
// the snapshot are simply not written — week-store already treats a missing
// file as an empty default, so the fold behaves exactly as it did in August.
const PARTS = ['gr_history', 'day_trades', 'balance_ledger', 'ck_history', 'notes'];

// Deliberately conspicuous: if this string ever shows up in the UI or a report,
// a test fixture has leaked into a real code path.
const FIXTURE_NOTE = 'FIXTURE NOTE - not a real journal entry (test/helpers/recovered-fixture.js)';

let cachedRoot = null;

function sourceFor(part) {
  return path.join(RECOVERED, PREFIX + part + '.json');
}

/** Is the frozen snapshot present with the two files a replay cannot do without? */
function available() {
  return fs.existsSync(sourceFor('gr_history')) && fs.existsSync(sourceFor('day_trades'));
}

/**
 * Materialise `<tmp>/accounts/s1/*.json` from the snapshot and return the DATA
 * root. Built once per process; the caller may treat it as read-only.
 */
function dataRoot() {
  if (cachedRoot) return cachedRoot;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnq-w35-'));
  const dir = path.join(root, 'accounts', 's1');
  fs.mkdirSync(dir, { recursive: true });
  for (const part of PARTS) {
    const src = sourceFor(part);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, part + '.json'));
  }

  // ── What the snapshot does NOT contain ───────────────────────────────────
  // The 2026-09-04 recovery captured three files per account — gr_history,
  // day_trades and balance_ledger. `ck_history.json` and `notes.json` were not
  // part of it.
  //
  // week-store tolerates both (readJson has defaults), but week-rollup's replay
  // reads ck_history with a bare readFileSync and throws without it, and one
  // week-store assertion checks that journal notes reach the fold at all.
  //
  // So they are supplied here, EMPTY and UNMISTAKABLY MARKED. This is the one
  // place in these tests where the data is not Anoop's. It must stay that way:
  // the money figures the replays assert come from the snapshot and nowhere
  // else — inventing a P&L to make a replay pass would destroy the only thing
  // these tests are for. The note below exists to prove notes are WIRED, not to
  // claim he wrote anything.
  const ck = path.join(dir, 'ck_history.json');
  if (!fs.existsSync(ck)) fs.writeFileSync(ck, '[]', 'utf8');
  const notes = path.join(dir, 'notes.json');
  if (!fs.existsSync(notes)) {
    const one = { text: FIXTURE_NOTE, mood: null, followedPlan: null, mistake: null, lesson: null };
    fs.writeFileSync(notes, JSON.stringify({
      '2026-08-24': one, '2026-08-25': one, '2026-08-26': one, '2026-08-27': one,
      '2026-08-28': one, '2026-08-29': one, '2026-08-30': one,
    }, null, 2), 'utf8');
  }

  cachedRoot = root;
  return root;
}

/** The account directory itself, for tests that read the files directly. */
function accountDir() {
  return path.join(dataRoot(), 'accounts', 's1');
}

module.exports = { available, dataRoot, accountDir, RECOVERED, FIXTURE_NOTE };
