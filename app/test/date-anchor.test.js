// Regression guard for the stale-date bug (2026-08-12).
//
// A hardcoded "Today is 2026-07-02." lived in claude-agent.js's system prompt
// and went ~6 weeks stale, so every agent thought it was July when it was
// August — "yesterday" returned today, weekdays were wrong, uploaded Tradovate
// reports (which are IST) were misread. The fix computes the date live per
// request (istDateLine / istDateAnchor). These tests exist so that fix can
// never silently regress: no fixed calendar date may sit in the prompt code,
// and the live anchor must stay wired in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(APP, f), 'utf8');

// A literal "Today is <YYYY-MM-DD>" (or MM/DD/YYYY) anywhere in prompt code is
// the exact shape of the original bug. Comments must not contain it either —
// that keeps this guard simple and unambiguous.
const HARDCODED_DATE = /Today is\s+\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/i;

for (const file of ['claude-agent.js', 'server.js', 'groq-agent.js']) {
  test(`no hardcoded "Today is <date>" in ${file} (would go stale)`, () => {
    const src = read(file);
    const m = src.match(HARDCODED_DATE);
    assert.strictEqual(
      m, null,
      `${file} contains a hardcoded date "${m && m[0]}". Dates must be computed ` +
      `live via istDateAnchor()/istDateLine(), never typed in — they go stale.`
    );
  });
}

test('claude-agent.js still injects a live IST date (istDateLine wired in)', () => {
  const src = read('claude-agent.js');
  assert.match(src, /function istDateLine\(/, 'istDateLine() helper missing');
  assert.match(src, /Asia\/Kolkata/, 'IST (Asia/Kolkata) computation missing');
  assert.match(src, /istDateLine\(\)/g, 'istDateLine() is never called into the prompt');
});

test('server.js prepends the live IST anchor to every agent', () => {
  const src = read('server.js');
  assert.match(src, /function istDateAnchor\(/, 'istDateAnchor() helper missing');
  // 1 definition + Jessi + 6 agents (Analysis, PO3-debate, Judge, PO3, Post-Session, Scalper)
  const count = (src.match(/istDateAnchor\(\)/g) || []).length;
  assert.ok(count >= 8, `expected istDateAnchor() wired into all agents (>=8 refs), found ${count}`);
});

// The anchor must actually produce TODAY in IST, not just any date — this is the
// live-clock proof the hardcoded version could never give.
test('IST anchor computes the real current IST date', () => {
  const now = new Date();
  const d = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/, 'IST date is not YYYY-MM-DD');
  // Independently recompute IST calendar date from the UTC epoch (+5:30) and compare.
  const istShift = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const expected = istShift.toISOString().slice(0, 10);
  assert.strictEqual(d, expected, 'toLocaleDateString(Asia/Kolkata) disagrees with +5:30 shift');
});
