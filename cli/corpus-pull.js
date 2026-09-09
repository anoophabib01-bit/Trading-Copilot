'use strict';
// ── corpus-pull.js — put MNQ/MGC history on disk and keep it there ──────────
//
//   node cli/corpus-pull.js            # default set: MNQ + MGC + context
//   node cli/corpus-pull.js --full     # adds 1m/7d and 1h/2y
//   node cli/corpus-pull.js --symbol MNQ=F --interval 5m --range 60d
//
// ── WHY A LOCAL CORPUS AND NOT A LIVE CALL ─────────────────────────────────
// Two independent reasons, both already recorded against this repo:
//
//   1. Chart bars in this app are ROLLING SNAPSHOTS. Whatever was not captured
//      is gone, which is the thing blocking the forensics/replay work. Yahoo
//      is an INDEPENDENT source that can backfill a window nobody archived —
//      but only for as long as Yahoo's own window still covers it. 5m data
//      ages out at 60 days and 1m at 7. A month from now today's 1m bars are
//      unrecoverable from any source. Pulling on a schedule is the only way
//      the archive ever gets deeper than the vendor's retention.
//
//   2. A backtest that re-fetches is not reproducible. Base rates computed
//      from a moving window cannot be compared across runs, and "the number
//      changed" then has two possible causes instead of one.
//
// Writes newline-delimited JSON, one bar per line, to
// cli/corpus/<symbol>/<interval>.jsonl — append-only in spirit and merged by
// timestamp, so re-running never loses a bar that has aged out upstream. Same
// doctrine as chat-archive.js: the record is never trimmed to match what the
// vendor currently serves.

const fs = require('node:fs');
const path = require('node:path');
const { fetchBars, SYMBOLS, CONTEXT, MAX_RANGE } = require('./yahoo');

const CORPUS_DIR = path.join(__dirname, 'corpus');

// (symbol, interval) pairs worth keeping. Deliberately excludes 1d on the
// futures roots — see the DAILY-BAR TRAP note in yahoo.js.
const DEFAULT_SET = [
  { symbol: 'MNQ=F', interval: '5m', range: '60d' },
  { symbol: 'MNQ=F', interval: '15m', range: '60d' },
  { symbol: 'MGC=F', interval: '5m', range: '60d' },
  { symbol: 'MGC=F', interval: '15m', range: '60d' },
  { symbol: '^VIX', interval: '1d', range: '2y' },
];

const FULL_EXTRA = [
  { symbol: 'MNQ=F', interval: '1m', range: '7d' },
  { symbol: 'MGC=F', interval: '1m', range: '7d' },
  { symbol: 'MNQ=F', interval: '1h', range: '2y' },
  { symbol: 'MGC=F', interval: '1h', range: '2y' },
  { symbol: 'ES=F', interval: '15m', range: '60d' },
  { symbol: '^TNX', interval: '1d', range: '2y' },
  { symbol: 'DX=F', interval: '15m', range: '60d' },
];

function fileFor(symbol, interval) {
  // "^VIX" and "MNQ=F" are not filename-safe on Windows.
  const safe = symbol.replace(/[^A-Za-z0-9]/g, '_');
  return path.join(CORPUS_DIR, safe, interval + '.jsonl');
}

function readExisting(file) {
  const byT = new Map();
  if (!fs.existsSync(file)) return byT;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line);
      if (b && typeof b.t === 'number') byT.set(b.t, b);
    } catch { /* a torn last line survives as a skipped row, not a crash */ }
  }
  return byT;
}

// Merge rather than overwrite: a bar we captured 40 days ago is still ours
// even once Yahoo stops serving it.
function mergeAndWrite(file, fresh) {
  const existing = readExisting(file);
  const before = existing.size;
  let added = 0, revised = 0;
  for (const b of fresh) {
    const prev = existing.get(b.t);
    if (!prev) { existing.set(b.t, b); added++; }
    else if (prev.c !== b.c || prev.v !== b.v) { existing.set(b.t, b); revised++; }
  }
  const all = [...existing.values()].sort((a, b) => a.t - b.t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, all.map((b) => JSON.stringify(b)).join('\n') + '\n');
  fs.renameSync(tmp, file); // atomic-ish, same doctrine as atomic-write.js
  return { before, after: all.length, added, revised };
}

async function pullOne({ symbol, interval, range }) {
  const capped = MAX_RANGE[interval];
  const res = await fetchBars(symbol, { interval, range: range || capped });
  if (!res.ok) return { symbol, interval, ok: false, error: res.error };
  const file = fileFor(symbol, interval);
  const stats = mergeAndWrite(file, res.bars);
  return {
    symbol, interval, ok: true, fetched: res.bars.length,
    file: path.relative(path.join(__dirname, '..'), file), ...stats,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  let set;
  if (flag('--symbol')) {
    set = [{
      symbol: flag('--symbol'),
      interval: flag('--interval') || '5m',
      range: flag('--range') || undefined,
    }];
  } else {
    set = argv.includes('--full') ? DEFAULT_SET.concat(FULL_EXTRA) : DEFAULT_SET;
  }

  console.log('corpus-pull -> ' + CORPUS_DIR);
  console.log(set.length + ' series\n');

  const rows = [];
  for (const spec of set) {
    process.stdout.write('  ' + (spec.symbol + ' ' + spec.interval).padEnd(16) + ' ... ');
    const r = await pullOne(spec);
    rows.push(r);
    if (!r.ok) { console.log('FAILED — ' + r.error); continue; }
    console.log(
      String(r.fetched).padStart(6) + ' fetched  |  ' +
      String(r.after).padStart(6) + ' on disk  ' +
      '(+' + r.added + ' new' + (r.revised ? ', ' + r.revised + ' revised' : '') + ')'
    );
  }

  const ok = rows.filter((r) => r.ok).length;
  const bars = rows.filter((r) => r.ok).reduce((a, r) => a + r.after, 0);
  console.log('\n' + ok + '/' + rows.length + ' series, ' + bars.toLocaleString() + ' bars on disk');
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log('  ' + f.symbol + ' ' + f.interval + ': ' + f.error);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { pullOne, fileFor, readExisting, mergeAndWrite, CORPUS_DIR, DEFAULT_SET };
