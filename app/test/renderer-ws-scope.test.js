'use strict';
// ── Guard against the dead-toggle bug (2026-08-26) ─────────────────────────
// The Standard/Scalper toggle shipped on 2026-08-01 and never worked. app.js
// did `if (ws && ws.readyState === 1) ws.send(...)`, but `ws` is declared with
// `let` INSIDE ws-client.js's IIFE and is never put on window. Every click
// threw ReferenceError, which also killed the applyTradingModeUI() call on the
// next line — so the button did not move and the server never heard.
//
// It survived nearly a month because it failed INVISIBLY in the most
// convincing way possible: ws-client.js sets the button from the server's
// config on every load, so it always showed the correct mode. It looked like
// a working toggle that "did nothing", which is exactly how Anoop described
// it. The same mistake was then copied verbatim into the new CONTROL toggle.
//
// A DOM test would be the thorough way to catch this; a static scope check is
// the one that actually runs in this repo's test setup, and it catches the
// precise mistake — reaching for a socket that only exists inside another
// file's closure.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');

// ws-client.js legitimately owns `ws`; everything else must go through
// window.api. .bak files are historical and deliberately not policed.
function rendererSources() {
  return fs.readdirSync(RENDERER)
    .filter((f) => f.endsWith('.js') && f !== 'ws-client.js' && !f.includes('.bak') && !f.includes('.tmp'))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(RENDERER, f), 'utf8') }));
}

test('no renderer file reaches for the bare `ws` socket — it lives in another closure', () => {
  const offenders = [];
  for (const { name, src } of rendererSources()) {
    src.split('\n').forEach((line, i) => {
      if (/(^|[^.\w])ws\s*\.\s*(send|readyState|close|onmessage)\b/.test(line)) {
        offenders.push(`${name}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'These reference ws-client.js\'s private socket and will throw ReferenceError at runtime.\n' +
    'Use window.api.send({...}) instead:\n  ' + offenders.join('\n  '));
});

test('ws-client.js exposes a send() on window.api, which is the supported path', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'ws-client.js'), 'utf8');
  assert.match(src, /send:\s*\(obj\)\s*=>/, 'window.api.send must exist');
  // It must report whether the message actually went out, so a caller can
  // tell "sent" from "socket was down" rather than assuming success.
  assert.match(src, /if\s*\(!ws\s*\|\|\s*ws\.readyState\s*!==\s*1\)\s*return false/,
    'send() must return false when the socket is down, not silently swallow');
});

test('both header toggles go through window.api.send', () => {
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  for (const msg of ['trading-mode-set', 'autonomy-set', 'autonomy-get']) {
    const re = new RegExp(`window\\.api\\.send\\(\\{[^}]*${msg}`);
    assert.match(app, re, `${msg} must be sent via window.api.send`);
  }
});

test('the trading-mode button only moves if the message actually went out', () => {
  // The original bug moved the UI optimistically on a line that could never
  // run; the fix must not swing to the opposite error of moving it when the
  // send failed, which would show a mode the server does not have.
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function switchTradingMode'), app.indexOf('function applyTradingModeUI'));
  assert.match(fn, /const sent = window\.api\.send/);
  assert.match(fn, /if \(sent\) applyTradingModeUI/);
});

test('the CONTROL toggle never moves itself — it waits for the server verdict', () => {
  // Requesting LIVE may be granted only as SHADOW. Lighting the clicked button
  // would claim an automated system is trading when it is not.
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function switchControl'), app.indexOf('function applyControlUI'));
  assert.ok(!/applyControlUI\(/.test(fn),
    'switchControl must not update the UI directly — only the autonomy-status broadcast may');
});
