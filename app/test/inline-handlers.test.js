'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Dead-button guard (2026-09-02) ───────────────────────────────────────────
// The "Mark exit on chart" button shipped inert. It was wired with a bare
//     document.addEventListener("DOMContentLoaded", ...)
// registered ~6,600 lines into an ~11,700-line app.js — by which point the
// event has already fired, so the listener never ran. Clicking did nothing at
// all: no handler, no status text, no error. Nothing distinguished it from a
// feature that was never built.
//
// app.js already knew this: every other late registration (grInit,
// loopInjectFocus, init) guards with `document.readyState === 'loading'`, and
// every button in that panel uses inline onclick. The fix was to follow the
// convention; this test stops the class of bug from returning silently.
//
// It checks the cheap, decidable half: that every function named by an inline
// handler actually EXISTS somewhere the browser will see. It cannot prove a
// handler does the right thing — only that clicking it is not a no-op.

const APP = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');

function handlerNames(html) {
  const out = new Set();
  const rx = new RegExp('on(?:click|change|input|submit)="[ ]*([A-Za-z_$][A-Za-z0-9_$]*)[ ]*[(]', 'g');
  for (const m of html.matchAll(rx)) out.add(m[1]);
  return out;
}

// Everything the page loads: the renderer scripts, the UMD modules pulled from
// app/, and index.html's own inline <script> blocks (setTheme lives in one, and
// missing them produces a false alarm rather than a real finding).
function loadedSource() {
  let src = HTML;
  const dir = path.join(APP, 'renderer');
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) src += '\n' + fs.readFileSync(path.join(dir, f), 'utf8');
  for (const f of ['mind-log.js', 'armed-detectors.js', 'journal-notes.js']) {
    try { src += '\n' + fs.readFileSync(path.join(APP, f), 'utf8'); } catch (e) {}
  }
  return src;
}

function isDefined(name, src) {
  return src.includes('function ' + name + '(') || src.includes('function ' + name + ' (')
      || src.includes('window.' + name + ' =') || src.includes('window.' + name + '=')
      || src.includes('const ' + name + ' =') || src.includes('let ' + name + ' =')
      || src.includes('var ' + name + ' =');
}

test('every inline on* handler in index.html resolves to a real definition', () => {
  const src = loadedSource();
  const dead = [...handlerNames(HTML)].filter(n => !isDefined(n, src)).sort();
  assert.deepStrictEqual(dead, [], 'these buttons would be silently inert: ' + dead.join(', '));
});

test('the audit is actually looking at something', () => {
  const names = handlerNames(HTML);
  assert.ok(names.size > 20, 'expected many inline handlers, found ' + names.size);
});

test('a handler that does not exist IS caught (the guard is not vacuous)', () => {
  const fake = handlerNames('<button onclick="thisFunctionDoesNotExistAnywhere()">x</button>');
  assert.deepStrictEqual([...fake], ['thisFunctionDoesNotExistAnywhere']);
  assert.strictEqual(isDefined('thisFunctionDoesNotExistAnywhere', loadedSource()), false);
});

test('the exit-mark button is wired inline and its handler exists', () => {
  assert.match(HTML, /id="exit-mark-btn"[^>]*onclick="requestExitMark\(\)"/,
    'the button must carry an inline onclick — a late addEventListener never fires in this file');
  assert.ok(isDefined('requestExitMark', loadedSource()));
});

// The reason the inline wiring is required at all.
test('app.js does not re-introduce a bare late DOMContentLoaded listener', () => {
  const js = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  const lines = js.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    // Comments describing the bug (including the one that replaced it) are
    // not code. Without this, the guard flags its own explanation.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (n < 3000) return;                                  // early registrations are fine
    if (!/addEventListener\(\s*['"]DOMContentLoaded['"]/.test(line)) return;
    if (/readyState/.test(line)) return;                    // the guarded form
    offenders.push(n);
  });
  assert.deepStrictEqual(offenders, [],
    'late DOMContentLoaded listeners never fire here — guard with document.readyState or wire inline (lines: ' + offenders.join(', ') + ')');
});
