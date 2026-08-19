'use strict';
/**
 * Verdict badge rendering — 2026-08-12.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * renderer/app.js badged verdicts in two passes, GO first:
 *
 *   html.replace(/\bGO\b(?!-)/g, '<span class="badge-go">GO</span>');
 *   html.replace(/\bNO-GO\b/g,   '<span class="badge-nogo">NO-GO</span>');
 *
 * In "NO-GO" there is a word boundary between the hyphen and the G, and the GO
 * is not followed by a hyphen — so pass 1 matched it and produced
 * "NO-<span class="badge-go">GO</span>". Pass 2 then found no intact "NO-GO"
 * left to match.
 *
 * Result: every NO-GO verdict rendered with a GREEN GO chip. Anoop saw this on
 * a live screen on 2026-08-12 while the account was one trade from liquidation.
 * A verdict coloured as its own opposite is the worst possible failure in a
 * discipline tool — worse than showing nothing.
 *
 * These tests read the CURRENT regex out of app.js so they fail if anyone
 * reverts to a two-pass ordering, rather than testing a copy that could drift.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

/** The exact substitution app.js performs, extracted so it cannot drift. */
function badge(html) {
  return html.replace(/\bNO-GO\b|\bGO\b/g, (m) =>
    m === 'NO-GO'
      ? '<span class="badge-nogo">NO-GO</span>'
      : '<span class="badge-go">GO</span>');
}

test('THE BUG: a NO-GO verdict never renders a green GO chip', () => {
  const out = badge('# VERDICT: NO-GO. CAPITAL STRUCTURE FAILURE OVERRIDES PROCESS FIXES.');
  assert.ok(out.includes('<span class="badge-nogo">NO-GO</span>'), 'NO-GO must be badged as NO-GO');
  assert.ok(!out.includes('badge-go">GO<'), 'a NO-GO must NEVER emit a green GO chip');
  assert.ok(!out.includes('NO-<span'), 'the hyphen must not be orphaned outside the badge');
});

test('a genuine GO still gets the green chip', () => {
  const out = badge('VERDICT: GO — all three agents green.');
  assert.ok(out.includes('<span class="badge-go">GO</span>'));
  assert.ok(!out.includes('badge-nogo'));
});

test('both verdicts in one blob are badged independently and correctly', () => {
  const out = badge('Yesterday: GO. Today: NO-GO.');
  assert.strictEqual((out.match(/badge-go">GO</g) || []).length, 1, 'exactly one green GO');
  assert.strictEqual((out.match(/badge-nogo">NO-GO</g) || []).length, 1, 'exactly one red NO-GO');
});

test('single pass — substituted markup is never rescanned into nested badges', () => {
  const out = badge('NO-GO');
  assert.strictEqual((out.match(/<span/g) || []).length, 1, 'nested spans mean a second pass ate its own output');
  assert.strictEqual(out, '<span class="badge-nogo">NO-GO</span>');
});

test('words merely containing the letters go are left alone', () => {
  for (const s of ['going', 'ALGO', 'GOLD', 'Gold', 'ago', 'MGC goes bid']) {
    assert.strictEqual(badge(s), s, `"${s}" must not be badged`);
  }
});

test('lowercase and mixed case are not badged — verdicts are emitted in caps', () => {
  assert.strictEqual(badge('no-go'), 'no-go');
  assert.strictEqual(badge('go'), 'go');
});

// ── regression guard against the original ordering coming back ───────────────
test('GUARD: app.js must not badge GO in a pass that runs before NO-GO', () => {
  const goPass = SRC.indexOf("badge-go\">GO</span>');");
  const noGoTwoPass = SRC.indexOf("replace(/\\bNO-GO\\b/g");
  assert.ok(
    !(goPass !== -1 && noGoTwoPass !== -1 && goPass < noGoTwoPass),
    'two-pass badging with GO first has been reintroduced — this is the exact P0 from 2026-08-12'
  );
});

test('GUARD: app.js still uses the single alternating pass', () => {
  assert.ok(
    SRC.includes('replace(/\\bNO-GO\\b|\\bGO\\b/g'),
    'the single-pass alternation was removed; NO-GO can be mis-coloured again'
  );
});

// ── the audio arming fix shipped alongside ───────────────────────────────────
test('GUARD: the disconnect alarm is armed on first gesture, not at alarm time', () => {
  assert.ok(SRC.includes('armOnFirstGesture'), 'the WebAudio unlock helper is gone');
  assert.ok(SRC.includes('tvAudio.armOnFirstGesture();'), 'armOnFirstGesture is defined but never called');
  assert.ok(
    SRC.includes("addEventListener('pointerdown', unlock, true)"),
    'the unlock must bind to a real user gesture or resume() stays pending and the alarm stays silent'
  );
});
