'use strict';
// ── I0.1 — the firewall, as a test ─────────────────────────────────────────
// The whole reason the India Desk is a separate process is that NSE data cannot
// reach an MNQ trading decision. Encode that as a check, not a comment: this
// walks cli/india-desk/ and fails if any file can reach the app.
//
//   * no require/import whose resolved path enters app/
//   * no dynamic require(variable) at all
//   * the string "handleTradeConfirm" appears nowhere
//   * the string "TRADE_TICKET" appears nowhere
//   * no require('ws') — this page is HTTP-only, off the app's WebSocket bus
//
// It walks the directory, so a file added later is covered without editing this.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DESK_DIR = path.join(__dirname, '..', 'india-desk');
const APP_DIR = path.join(__dirname, '..', '..', 'app');

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function inApp(p) {
  const norm = path.resolve(p);
  return norm === APP_DIR || norm.startsWith(APP_DIR + path.sep);
}

test('I0.1 firewall: no file under cli/india-desk/ can reach the MNQ app', () => {
  const files = listFiles(DESK_DIR).filter((f) => /\.(js|mjs|cjs|html)$/.test(f));
  assert.ok(files.length > 0, 'cli/india-desk/ must contain files (did the build land?)');

  for (const f of files) {
    const rel = path.relative(DESK_DIR, f);
    const text = fs.readFileSync(f, 'utf8');

    // Forbidden strings — a comment counts as a violation too.
    assert.ok(!text.includes('handleTradeConfirm'), rel + ' mentions handleTradeConfirm');
    assert.ok(!text.includes('TRADE_TICKET'), rel + ' mentions TRADE_TICKET');

    // No WebSocket.
    assert.ok(!/require\(\s*['"]ws['"]\s*\)/.test(text), rel + ' requires "ws"');
    assert.ok(!/\bfrom\s+['"]ws['"]/.test(text), rel + ' imports from "ws"');
    assert.ok(!/\bimport\s+['"]ws['"]/.test(text), rel + ' imports "ws"');

    // No dynamic require.
    assert.ok(!/require\(\s*(?!['"])/.test(text), rel + ' uses a dynamic require(variable)');

    // Static require/import specifiers must not resolve into app/.
    const specs = [];
    const re = /(?:require\(\s*|\bfrom\s+|\bimport\s+)(['"])([^'"]+)\1/g;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[2]);
    for (const s of specs) {
      if (!s.startsWith('.') && !path.isAbsolute(s)) continue; // bare module name (already ws-checked)
      const resolved = path.resolve(path.dirname(f), s);
      assert.ok(!inApp(resolved), rel + ' resolves into app/: ' + s + ' -> ' + resolved);
    }

    // Belt-and-suspenders: catch a bare app/ path fragment even if it is not a require.
    assert.ok(!/['"]((\.\.\/)+app\/|app\/server)/.test(text), rel + ' references an app/ path literally');
  }
});
