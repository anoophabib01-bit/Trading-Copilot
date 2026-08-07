'use strict';
/**
 * resolve-data-dir.js — single source of truth for resolving the real,
 * currently-active DATA_DIR, shared by server.js (the live process),
 * call-logger.js (writes token-usage.jsonl from inside claude-agent.js),
 * and token-usage-report.js (a standalone script, never runs through
 * server.js's startup).
 *
 * Extracted 2026-08-03 after call-logger.js shipped its own simplified,
 * incomplete copy of this logic (it ignored the user-configurable
 * `dataDir` config field entirely) and silently wrote its log to a
 * different directory than the rest of the app's real data — the same
 * class of bug server.js already hit once (see server.js's "BUG FOUND
 * 2026-07-28" comment). One resolver, three callers, nothing left to drift.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.mnq-copilot-config.json');
const DEFAULT_DATA_DIR = 'G:\\MNQ-CoPilot\\DATA';
const FALLBACK_DATA_DIR = path.join(__dirname, 'data');

function loadConfiguredDataDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return (cfg && cfg.dataDir) || null;
  } catch {
    return null;
  }
}

// Resolves + validates (mkdir + write-access check) the real data directory,
// falling back to the in-project data/ folder if the configured/default path
// isn't writable. Returns the error too (not just the path) so a caller that
// cares — server.js's startup log — can report *why* it fell back, the same
// diagnostic detail the pre-extraction code had. Mirrors server.js's own
// resolution minus its server-specific lifetime-file recovery step, which
// stays in server.js since only server.js's data keys need it.
function resolveDataDir() {
  const wanted = loadConfiguredDataDir() || DEFAULT_DATA_DIR;
  try {
    fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    return { dir: wanted, isFallback: false, error: null };
  } catch (e) {
    try { fs.mkdirSync(FALLBACK_DATA_DIR, { recursive: true }); } catch {}
    return { dir: FALLBACK_DATA_DIR, isFallback: true, error: e };
  }
}

module.exports = { resolveDataDir, DEFAULT_DATA_DIR, FALLBACK_DATA_DIR };
