'use strict';
// chat-restore-wiring.test.js — 2026-09-04.
//
// The bug this guards against is not a logic bug, it is a LOAD-ORDER bug, and
// it is invisible: if chat-restore.js loads after resilience.js, both paint,
// and the last 40 turns appear twice above the archive that already contains
// them. Nothing throws. The chat just quietly lies about what was said.
//
// Same doctrine as inline-handlers.test.js: some contracts in this app live in
// the wiring rather than in a function, and the only way to hold them is to
// read the files.
//
// Background — why the restore exists at all. On 2026-09-03 the archive
// captured 413 rows of chat and Anoop could see almost none of them the next
// day, because the only restore that existed repainted `state.messages`: a
// 40-turn, user/assistant-only extract (app.js trims it, deliberately, because
// it is the model context). See renderer/chat-restore.js's header.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');

test('index.html loads chat-restore.js BEFORE resilience.js', () => {
  const html = R('index.html');
  const restore = html.indexOf('src="chat-restore.js"');
  const resil = html.indexOf('src="resilience.js"');
  assert.ok(restore !== -1, 'chat-restore.js is not loaded at all');
  assert.ok(resil !== -1, 'resilience.js is not loaded at all');
  assert.ok(restore < resil,
    'chat-restore.js must load first — it claims the pane synchronously at parse ' +
    'time, and it can never win on timing because it needs a WS round-trip while ' +
    'resilience.js repaints synchronously from localStorage');
});

test('chat-archive.js still loads after both — replayed rows must be tagged first', () => {
  const html = R('index.html');
  assert.ok(html.indexOf('src="resilience.js"') < html.indexOf('src="chat-archive.js"'),
    'the capture side must load last, or its startup sweep archives replayed rows');
});

test('chat-restore.js claims the pane synchronously, not inside a callback', () => {
  // Scoped to the code below the IIFE opener: the file's header explains the
  // race in prose, and matching the word "DOMContentLoaded" in a comment
  // would fail this test for describing the bug it prevents.
  const whole = R('chat-restore.js');
  const iife = whole.indexOf('(function () {');
  assert.ok(iife !== -1, 'the IIFE opener moved — this test cannot locate the code');
  const src = whole.slice(iife);

  const claim = src.indexOf('window.__chatArchiveRestorePending = true');
  assert.ok(claim !== -1, 'the claim flag is gone — resilience.js will double-paint');
  // The claim must sit in the IIFE body, before anything that defers. If it
  // ever moves inside DOMContentLoaded or a promise, resilience.js's 300ms
  // timer can beat it and both will paint.
  const deferred = ['DOMContentLoaded', 'setTimeout(', '.then(']
    .map(s => src.indexOf(s))
    .filter(i => i !== -1);
  assert.ok(deferred.every(i => claim < i),
    'the claim must be the first thing the file does — it is deferred behind ' + JSON.stringify(deferred));
});

test('resilience.js restores state.messages even when the pane is claimed', () => {
  const src = R('resilience.js');
  // The context restore and the repaint were one function until 2026-09-04.
  // Skipping the repaint must never skip the context: state.messages is what
  // the model sees after a reload, and it is unrelated to who owns the pane.
  const i = src.indexOf('function restore()');
  assert.ok(i !== -1, 'restore() is gone — check what replaced it');
  const body = src.slice(i, i + 700);
  assert.ok(body.includes('restoreContext()'), 'restore() no longer restores the model context');
  assert.ok(body.indexOf('restoreContext()') < body.indexOf('__chatArchiveRestorePending'),
    'the context restore must run BEFORE the claim check, or a claimed pane ' +
    'costs the model its conversation history');
});

test('resilience.js exposes the repaint so the archive can hand the pane back', () => {
  const src = R('resilience.js');
  assert.ok(src.includes('window.__resilienceRepaint = repaint'),
    'without this handoff, an archive query failure leaves a blank chat');
  assert.ok(R('chat-restore.js').includes('window.__resilienceRepaint'),
    'chat-restore.js never calls the fallback — a failed query would show nothing');
});

test('every restored row is tagged data-replay so it is not re-archived', () => {
  const src = R('chat-restore.js');
  // Three row builders paint into #messages: the banner, the day separator and
  // the row itself. Every one must be tagged, or opening the app appends the
  // whole history to the archive again under fresh ids.
  const tags = (src.match(/dataset\.replay = '1'/g) || []).length;
  assert.ok(tags >= 4, 'expected the banner, separator, row and wrapper all tagged; found ' + tags);
  assert.ok(R('chat-archive.js').includes("dataset.replay === '1'"),
    'the capture side no longer skips replayed rows — restores would duplicate the archive');
});

test('a restored trade ticket loses its card class; a LOOP row keeps its marker', () => {
  const src = R('chat-restore.js');
  const m = src.match(/const DROP_CLASSES = \[([^\]]*)\]/);
  assert.ok(m, 'DROP_CLASSES is gone — check what replaced it');
  assert.ok(m[1].includes('trade-ticket-card'),
    'a restored ticket must not wear .trade-ticket-card: its Confirm control is ' +
    'gone, and a dead confirm button on a real-order path is worse than a plain row');
  // The inverse half of the same rule: everything NOT in the blocklist is
  // kept, which is what stops THE LOOP's interventions coming back as
  // anonymous assistant bubbles in the history it is meant to be held to.
  assert.ok(!m[1].includes('loop-feedback'),
    'loop-feedback must survive a restore — it is how a LOOP row stays identifiable');
  assert.ok(/kept\.indexOf\(base\) === -1/.test(src),
    'the role class must be forced on even when the archived classes omit it');
});

test('the restore does not widen the model context', () => {
  const src = R('chat-restore.js');
  assert.ok(!/state\.messages\s*=/.test(src),
    'chat-restore.js must never write state.messages — the pane is allowed to be ' +
    'much larger than the context, and every request pays for the context');
});
