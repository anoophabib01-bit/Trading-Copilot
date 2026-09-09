'use strict';
// ── market-cli.js — the ONLY module in this repo allowed to spawn a CLI ─────
//
// Anoop, 2026-09-06: "make sure you name a NEW folder naming CLI and use only
// that folder for all the information related to CLI so that you can refer
// anytime". Everything about an external market CLI — the binary path, its
// on-disk state, the wrapper, the docs — lives under G:\MNQ-CoPilot\cli\.
//
// ── WHY THIS MODULE EXISTS AT ALL ──────────────────────────────────────────
// PRINTING_PRESS_INTEGRATION.md proposed a client that would have failed on
// its first call, in four separate ways. Each one is fixed here ONCE so that
// no caller can reintroduce it:
//
//   1. AWAIT PROPERLY. The old draft did `_runCLI('movers').slice(0, limit)`
//      and `_runCLI(...)[0]` — indexing a Promise. `.slice` is not a function
//      on a Promise; `[0]` is undefined. Every function here returns a Promise
//      and nothing indexes a return value directly.
//
//   2. TWO OUTPUT SHAPES. Some commands return `{meta, results}`; others
//      return a BARE array (`index-driver`) or a bare `null` (`delivery-spike`
//      before its store is warm). The old draft always read `.results`, so a
//      bare array silently became `undefined`.  `unwrap()` handles both and
//      reports which shape it saw.
//
//   3. EMPTY IS NOT AN ERROR, AND AN ERROR IS NOT EMPTY. Verified 2026-09-06:
//      `delivery-spike` prints `null` and `sector-breadth` prints `[]` — both
//      at EXIT CODE 0 — when the local store has not been synced. A caller
//      that cannot tell "no data yet" from "no signal" will read an unsynced
//      store as a calm market. So `empty:true` is returned explicitly and is
//      never collapsed into a falsy data value.
//
//   4. EXIT CODES ARE MEANINGFUL. Every printing-press CLI uses the same
//      table. A 7 should back off; a 4 should alarm once and stop retrying.
//      Treating them all as "failed" throws away the only retry signal there
//      is.
//
// ── THE SAFETY PROPERTY ────────────────────────────────────────────────────
// Same doctrine as autonomy-modes.js, which guarantees a per-mode config can
// only ever be TIGHTER than the global rules. Nothing this module returns may
// raise a size, loosen a gate, or add conviction. A CLI result may BLOCK a
// trade or ANNOTATE a record. It may never permit one. There is no code path
// from here into handleTradeConfirm, and there must not be one.
//
// Spawns a read-only child process, parses stdout, returns a structured
// result. Never throws on CLI failure — callers branch on `.ok`.

const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CLI_DIR = __dirname;
const PATHS_FILE = path.join(CLI_DIR, 'cli-paths.json');
const STATE_DIR = path.join(CLI_DIR, 'state');

// Exit codes, identical across every printing-press CLI (from each CLI's own
// "Agent Usage" section). `retryable` is what callers actually branch on.
const EXIT = {
  0: { key: 'ok', retryable: false, msg: 'success' },
  2: { key: 'usage', retryable: false, msg: 'usage error — bad flag or argument' },
  3: { key: 'not_found', retryable: false, msg: 'resource not found' },
  4: { key: 'auth', retryable: false, msg: 'auth error — credentials missing or rejected' },
  5: { key: 'api', retryable: true, msg: 'upstream API error' },
  7: { key: 'rate', retryable: true, msg: 'rate limited — back off' },
  10: { key: 'config', retryable: false, msg: 'config error' },
};

function exitInfo(code) {
  return EXIT[code] || { key: 'unknown', retryable: false, msg: 'unexpected exit code ' + code };
}

// ── Binary resolution ──────────────────────────────────────────────────────
// NEVER depend on PATH. The installer warns that its bin directory is not on
// PATH, and the app launches from a .bat whose PATH is not the one a developer
// tests in — exec('nse-india-pp-cli ...') would be ENOENT at runtime. Paths
// are resolved from cli-paths.json and verified to exist before spawning.
let _paths = null;
function loadPaths() {
  if (_paths) return _paths;
  try {
    _paths = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8'));
  } catch {
    _paths = { clis: {} };
  }
  return _paths;
}

function resolveBin(name) {
  const entry = loadPaths().clis[name];
  if (!entry || !entry.bin) return null;
  return fs.existsSync(entry.bin) ? entry.bin : null;
}

function installedClis() {
  const clis = loadPaths().clis;
  return Object.keys(clis).map((name) => ({
    name,
    bin: clis[name].bin,
    present: !!resolveBin(name),
    note: clis[name].note || '',
  }));
}

// ── Child environment ──────────────────────────────────────────────────────
// ── CORRECTED 2026-09-06 — THIS IS BEST-EFFORT, NOT A GUARANTEE ────────────
// The original comment here claimed these vars relocate every CLI's storage
// into cli/state/. That claim was WRONG and was asserted without testing.
// DSH found it for nse-india; re-measuring showed it is broader.
//
// `doctor` run WITH and WITHOUT the exact vars below, on both installed CLIs:
//
//   nse-india       db_path  C:\Users\Admin\.local\share\nse-india-pp-cli\data.db
//   nse-india + env db_path  C:\Users\Admin\.local\share\nse-india-pp-cli\data.db   ← identical
//   yahoo-finance       db_path  ...\.local\share\yahoo-finance-pp-cli\data.db
//   yahoo-finance + env db_path  ...\.local\share\yahoo-finance-pp-cli\data.db      ← identical
//
// Neither honours XDG_* or <NAME>_HOME. Both hardcode ~/.config and
// ~/.local/share. The four-path-kind ladder is documented on the NEWER CLIs'
// catalog pages (fpi-india, benzinga, mcpmarket) and absent from nse-india's
// and yahoo-finance's — so it is a per-CLI capability that this wrapper was
// treating as universal.
//
// These vars are therefore left in place because they cost nothing and DO work
// for the CLIs that implement the ladder — but NOTHING may depend on them.
// The only reliable relocation is an explicit flag: pass `db: true` to run()
// and it appends `--db cli/state/<name>/data.db`. Local-store commands
// (index-driver, delivery-spike, delivery-divergence, sector-breadth, sync)
// need it; live-API commands (market, movers, equity quote) take no --db and
// must not be given one.
function childEnv(name) {
  const home = path.join(STATE_DIR, name);
  const envName = name.toUpperCase().replace(/-/g, '_') + '_HOME';
  return {
    ...process.env,
    [envName]: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
  };
}

// Canonical local-store path for a CLI. The ONLY relocation that actually
// works — see the childEnv note above for why the env vars cannot be trusted.
function dbPathFor(name) {
  return path.join(STATE_DIR, name, 'data.db');
}

// ── Output unwrapping ──────────────────────────────────────────────────────
// Returns { data, shape, empty }. `shape` is recorded so a caller debugging a
// surprise can see whether it got an envelope or a bare value, which is the
// exact confusion that produced bug 2 above.
function unwrap(parsed) {
  if (parsed === null || parsed === undefined) {
    return { data: null, shape: 'null', empty: true };
  }
  if (Array.isArray(parsed)) {
    return { data: parsed, shape: 'bare-array', empty: parsed.length === 0 };
  }
  if (typeof parsed === 'object' && 'results' in parsed) {
    const r = parsed.results;
    const empty = r === null || r === undefined || (Array.isArray(r) && r.length === 0);
    return { data: r, shape: 'envelope', empty, meta: parsed.meta || null };
  }
  return { data: parsed, shape: 'bare-object', empty: false };
}

// ── run() — the single spawn point ─────────────────────────────────────────
// args is an ARRAY, passed to execFile without a shell, so a symbol like
// "MNQ=F" or an index name with spaces cannot be reinterpreted by cmd.exe.
async function run(name, args, opts = {}) {
  const timeout = opts.timeout ?? 120000;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024; // a 5m/60d chart is ~3MB
  const bin = resolveBin(name);

  if (!bin) {
    return {
      ok: false, empty: true, data: null, shape: 'none',
      code: 10, codeKey: 'config', retryable: false,
      error: 'CLI "' + name + '" not found. Check cli/cli-paths.json, or install it: '
        + 'npx -y @mvanhorn/printing-press-library install ' + name,
      cli: name, args,
    };
  }

  // ── WHY NOT `--agent` ────────────────────────────────────────────────────
  // `--agent` is documented as "set all agent-friendly defaults", and it looks
  // like the obvious flag for a programmatic caller. It expands to
  // `--json --compact --no-input --no-color --yes` — and `--compact` is the
  // problem: it "returns only key fields (id, name, status, timestamps) for
  // minimal token usage".
  //
  // Verified 2026-09-06: `nse-india movers --agent` returns rows of exactly
  // `{ identifier: "PCJEWELLEREQN" }` — no price, no change, no volume. The
  // same command with `--json` returns all 18 fields including lastPrice,
  // pChange and totalTradedValue. So the flag that advertises itself as the
  // agent default silently discards the data an agent actually wants, and does
  // it without any error.
  //
  // We therefore pass the agent flags INDIVIDUALLY, minus `--compact`. Callers
  // that genuinely want the trimmed payload opt in with `compact: true`.
  const AGENT_FLAGS = ['--json', '--no-input', '--no-color', '--yes'];

  // `db: true` -> the canonical cli/state/<name>/data.db; `db: '<path>'` -> that
  // path. Opt-in, because live-API commands (market, movers, equity quote)
  // reject --db. Applies to raw calls too: a raw NDJSON sync still needs it.
  const dbArgs = [];
  if (opts.db) {
    const dbPath = opts.db === true ? dbPathFor(name) : opts.db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    dbArgs.push('--db', dbPath);
  }

  const finalArgs = opts.raw
    ? args.concat(dbArgs)
    : args.concat(dbArgs, opts.compact ? AGENT_FLAGS.concat(['--compact']) : AGENT_FLAGS);

  return new Promise((resolve) => {
    execFile(bin, finalArgs, {
      timeout, maxBuffer, env: childEnv(name), windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const info = exitInfo(code);
      const base = {
        cli: name, args: finalArgs, code,
        codeKey: info.key, retryable: info.retryable,
      };

      if (err && err.killed) {
        return resolve({
          ...base, ok: false, empty: true, data: null, shape: 'none',
          retryable: true, error: 'timed out after ' + timeout + 'ms',
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // A non-zero exit with unparseable stdout is the normal failure path —
        // these CLIs put diagnostics on stderr and leave stdout empty.
        return resolve({
          ...base, ok: false, empty: true, data: null, shape: 'unparseable',
          error: (stderr || '').trim().split('\n')[0] || info.msg,
          stderr: (stderr || '').trim(),
        });
      }

      const u = unwrap(parsed);
      resolve({
        ...base,
        ok: code === 0,
        empty: u.empty,
        data: u.data,
        shape: u.shape,
        meta: u.meta || null,
        error: code === 0 ? null : ((stderr || '').trim().split('\n')[0] || info.msg),
      });
    });
  });
}

// ── runNdjson — for sync-style commands that emit NDJSON, not one JSON ────
// `sync --json` emits one {"event":"sync_warning"|...} per line and a final
// {"event":"sync_summary"}. JSON.parse would fail on that, so runNdjson parses
// line-by-line and returns { ok, code, codeKey, retryable, events, summary }.
// Same binary resolution and child env as run() — still the single spawn point.
async function runNdjson(name, args, opts = {}) {
  const timeout = opts.timeout ?? 600000; // a full sync is slow (rate-limited)
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const bin = resolveBin(name);

  if (!bin) {
    return {
      ok: false, code: 10, codeKey: 'config', retryable: false,
      events: [], summary: null,
      error: 'CLI "' + name + '" not found. Check cli/cli-paths.json, or install it: '
        + 'npx -y @mvanhorn/printing-press-library install ' + name,
      cli: name, args,
    };
  }

  const AGENT_FLAGS = ['--json', '--no-input', '--no-color', '--yes'];

  // `sync` is the single most important consumer of --db: without it the whole
  // store lands back in ~/.local/share and cli/state/ stays empty. Same opt-in
  // as run(); see the childEnv note for why the env vars cannot do this.
  const dbArgs = [];
  if (opts.db) {
    const dbPath = opts.db === true ? dbPathFor(name) : opts.db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    dbArgs.push('--db', dbPath);
  }

  const finalArgs = opts.raw
    ? args.concat(dbArgs)
    : args.concat(dbArgs, opts.compact ? AGENT_FLAGS.concat(['--compact']) : AGENT_FLAGS);

  return new Promise((resolve) => {
    execFile(bin, finalArgs, {
      timeout, maxBuffer, env: childEnv(name), windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const info = exitInfo(code);
      const events = [];
      let summary = null;
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try {
          const o = JSON.parse(s);
          if (o && o.event === 'sync_summary') summary = o;
          else if (o) events.push(o);
        } catch { /* skip non-JSON lines */ }
      }
      resolve({
        cli: name, args: finalArgs, code,
        codeKey: info.key, retryable: info.retryable,
        ok: code === 0, events, summary,
        error: code === 0 ? null : ((stderr || '').trim().split('\n')[0] || info.msg),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

module.exports = {
  run, runNdjson, resolveBin, installedClis, unwrap, exitInfo, dbPathFor,
  EXIT, CLI_DIR, STATE_DIR,
};
