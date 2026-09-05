'use strict';
/**
 * The debate fallback alarm (2026-09-02).
 *
 * WHY THIS EXISTS
 * A DeepSeek failure mid-Debate swapped the Power-of-3 agent to Gemini while
 * every other card still said DeepSeek. Nothing warned. The chat path had a
 * loud banner; the debate path never passed onFallback to groq-agent at all,
 * so the ONLY trace was a small grey caption that Anoop happened to read.
 *
 * The fix put the check inside modelBadgeHtml(), which every agent surface
 * renders through. These tests load the REAL function out of renderer/app.js
 * and run it against stubs — deliberately NOT a re-implementation. A test that
 * restates the logic cannot detect the logic changing, which is exactly how
 * the provider-registry drift went unnoticed earlier the same day.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

// Pull the two real functions out of the renderer bundle.
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' not found in renderer/app.js — was it renamed?');
  let depth = 0, i = SRC.indexOf('{', start);
  const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

function load(deepSeekConfigured) {
  const systemMessages = [];
  const ctx = {
    state: { deepSeekConfigured },
    escHtml: (s) => String(s),
    addSystemMessage: (m) => systemMessages.push(m),
    console,
    _fallbackNoticed: new Set()
  };
  vm.createContext(ctx);
  vm.runInContext(
    'const _fallbackNoticed = new Set();\n' +
    extract('noteFallbackOffDeepSeek') + '\n' +
    extract('modelBadgeHtml') + '\n', ctx);
  return { badge: (a) => vm.runInContext('modelBadgeHtml(' + JSON.stringify(a) + ')', ctx), systemMessages };
}

const DS = { provider: 'deepseek', label: 'DeepSeek/deepseek-v4-flash-vision-exp' };
const GEM = { provider: 'gemini', label: 'Gemini/gemini-3.5-flash' };

test('THE PO3 BUG: a Gemini reply while DeepSeek is configured is flagged, not captioned', () => {
  const { badge, systemMessages } = load(true);
  const html = badge(GEM);
  assert.match(html, /FALLBACK/, 'the badge must say FALLBACK, not just name the model');
  assert.match(html, /model-answered-by-warn/, 'must carry the warning style');
  assert.strictEqual(systemMessages.length, 1, 'must also raise a chat-level notice');
  assert.match(systemMessages[0], /NOT DeepSeek/);
});

test('a DeepSeek reply is a quiet caption — no alarm, no chat noise', () => {
  const { badge, systemMessages } = load(true);
  const html = badge(DS);
  assert.doesNotMatch(html, /FALLBACK/);
  assert.strictEqual(systemMessages.length, 0);
});

test('without a DeepSeek key, Gemini is the INTENDED brain and must not be flagged', () => {
  // Otherwise every reply in a pre-DeepSeek or kill-switched session screams
  // fallback — an alarm that always fires is an alarm you learn to ignore.
  const { badge, systemMessages } = load(false);
  assert.doesNotMatch(badge(GEM), /FALLBACK/);
  assert.strictEqual(systemMessages.length, 0);
});

test('one debate = four badges, but only ONE chat notice per fallback target', () => {
  const { badge, systemMessages } = load(true);
  badge(GEM); badge(GEM); badge(GEM); badge(GEM);   // jessi, analysis, po3, judge
  assert.strictEqual(systemMessages.length, 1, 'four identical banners is the noise that trains you to ignore it');
});

test('a DIFFERENT fallback target still gets its own notice', () => {
  const { badge, systemMessages } = load(true);
  badge(GEM);
  badge({ provider: 'groq', label: 'Groq/openai/gpt-oss-20b' });
  assert.strictEqual(systemMessages.length, 2);
});

test('a missing/blank answeredBy renders nothing and never alarms', () => {
  const { badge, systemMessages } = load(true);
  assert.strictEqual(badge(null), '');
  assert.strictEqual(badge({}), '');
  assert.strictEqual(systemMessages.length, 0);
});
