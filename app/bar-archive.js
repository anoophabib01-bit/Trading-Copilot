'use strict';
// F0.2 bar archive — durable append-only per-instrument+timeframe+day history.
// The forward-testing dataset. 1m is the load-bearing series (a 14-second trade
// is unmeasurable on 5m bars). Normalises BOTH on-disk schemas via bar-recorder.
const fs = require('fs');
const path = require('path');
const barRecorder = require('./bar-recorder');
const NL = String.fromCharCode(10);

function normalizeBar(b) { return barRecorder.normalizeBar(b); }
function normaliseLegacy(bars) { return barRecorder.normalizeAll(bars); }

// Append bars to one day's NDJSON, deduping by t (later data wins on a tie: a
// re-poll of the same forming bar overwrites; a closed bar is immutable).
// Returns the count of NEW timestamps actually added.
function appendToArchiveFile(filePath, incoming) {
  const existing = new Map();
  if (fs.existsSync(filePath)) {
    for (const line of fs.readFileSync(filePath, 'utf8').split(NL)) {
      if (!line.trim()) continue;
      try { const b = JSON.parse(line); if (b && Number.isFinite(b.t)) existing.set(b.t, b); } catch (e) {}
    }
  }
  let added = 0;
  for (const b of (Array.isArray(incoming) ? incoming : [])) {
    const n = normalizeBar(b);
    if (!n) continue;
    if (!existing.has(n.t)) added++;
    existing.set(n.t, n);
  }
  const sorted = Array.from(existing.values()).sort((a, b) => a.t - b.t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, sorted.map((b) => JSON.stringify(b)).join(NL) + (sorted.length ? NL : ''), 'utf8');
  return added;
}

// Read bars for [fromMs, toMs] across day files, oldest-first, normalised.
function readArchive(archiveDir, root, tf, fromMs, toMs) {
  // Archive keys are uppercase (MNQ/MGC), matching archiveBars and the backfill.
  const dir = path.join(archiveDir, String(root).toUpperCase(), String(tf));
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(NL)) {
      if (!line.trim()) continue;
      try {
        const b = JSON.parse(line);
        if (b && Number.isFinite(b.t) && (fromMs == null || b.t >= fromMs) && (toMs == null || b.t <= toMs)) out.push(b);
      } catch (e) {}
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

module.exports = { normalizeBar, appendToArchiveFile, readArchive, normaliseLegacy };
