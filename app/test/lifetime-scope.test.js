'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Lifetime-view scope, enforced at the source (2026-09-19) ────────────────
// Anoop: "if i click lifetime tab the lifetime data should sync, not just that
// account data."
//
// The Lifetime view works by swapping four account stores (gr_history,
// day_trades, balance_ledger, ck_history) for a merged overlay — which means any
// reader that reaches localStorage DIRECTLY, instead of through acctRead(),
// silently keeps showing the ACTIVE account while the banner above it correctly
// claims "26 trading days across 3 accounts".
//
// That is exactly what had happened: window.grHistory() read
// localStorage.getItem(HKEY) and renderInsights() builds its whole page from
// grHistory(), so the Lifetime banner and the numbers under it disagreed. The
// code comments have warned about this since the feature shipped; nothing
// enforced it. This test enforces it.
//
// SCOPE OF THE RULE: every account-scoped store used by the history-shaped tabs
// must be read through acctRead. copilot_guardrail_v1 is deliberately EXEMPT —
// it is today's live guardrail state, which belongs to the active account by
// definition, not to the merged record.
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

// The stores the lifetime overlay carries, plus the ones that must simply not
// be read behind its back.
const LIFETIME_STORES = ['copilot_gr_history', 'copilot_balance_ledger', 'copilot_day_trades', 'copilot_ck_history'];
const OTHER_ACCOUNT_STORES = ['copilot_pb_tags', 'copilot_loop', 'copilot_eval_milestones', 'copilot_maemfe', 'copilot_checklist_plan'];
const EXEMPT = ['copilot_guardrail_v1'];

test('no account store is read straight out of localStorage', () => {
  const offenders = [];
  [...LIFETIME_STORES, ...OTHER_ACCOUNT_STORES].forEach(function (key) {
    const needle = "localStorage.getItem('" + key + "')";
    if (APP.indexOf(needle) !== -1) offenders.push(key);
  });
  assert.deepEqual(offenders, [],
    'these stores are read directly and will ignore lifetime mode: ' + offenders.join(', '));
});

test('the exempt live guardrail store is still allowed to be direct', () => {
  // Guards the rule above from being "fixed" by breaking today's live state.
  EXEMPT.forEach(function (key) {
    assert.ok(APP.indexOf("localStorage.getItem('" + key + "')") !== -1,
      key + ' should stay an active-account read — it is today, not history');
  });
});

test('grHistory goes through acctRead, which is what makes Insights lifetime-aware', () => {
  const m = APP.match(/window\.grHistory = function \(\) \{[^}]*\}/);
  assert.ok(m, 'window.grHistory must exist');
  assert.match(m[0], /acctRead\(HKEY\)/,
    'grHistory must read through acctRead(HKEY) — renderInsights() builds every Insights number from it');
  assert.doesNotMatch(m[0], /localStorage\.getItem/);
});

test('the day-archive WRITE path also honours the read-only view', () => {
  // acctWrite refuses while the merged view is on. A localStorage.setItem here
  // would attribute one account's day to whichever slot is active.
  const m = APP.match(/function archive\(sum\) \{[\s\S]{0,400}?\}/);
  assert.ok(m, 'archive() must exist');
  assert.match(m[0], /acctRead\(HKEY\)/);
  assert.doesNotMatch(m[0], /localStorage\.getItem\(HKEY\)/);
});

test('the journal/insights readers that take a variable key use acctRead', () => {
  const jr = APP.match(/function jrLS\(key, fb\) \{[\s\S]{0,600}?\n\}/);
  assert.ok(jr, 'jrLS must exist');
  assert.match(jr[0], /acctRead\(key\)/);
});
