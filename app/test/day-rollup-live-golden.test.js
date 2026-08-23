'use strict';
// LIVE GOLDEN — runs ONLY where the production DATA dir exists (Anoop's
// machine). Verifies rollupDay against summaries the OLD inline csvApply code
// produced in production. Skipped silently elsewhere. A day whose rows were
// rewritten after its summary was stored cannot pass its pnl field and is
// reported, not failed.
//
// AUDIT (2026-08-22): the search was over sizeCap ONLY, and the assertion was
// `passed > 0`. Both were too weak. The historical rules changed more than
// once over the stored window — 2026-07-28/29/31 were graded when the cooldown
// was loss-only (rules.cooldownAfterLossOnly), which the harness never varied,
// so their revenge flags could not reproduce and they were written off as
// "rows rewritten". Adding that dimension takes the byte-identical count from
// 2/7 to 4/7 and, more importantly, brings the remaining three to zero-or-one
// differing row. Real drift in gradeTrades would blow the grade diff across
// MANY rows on EVERY day at once, so the floor is now stated as both a
// majority of days reproducing exactly and NO day drifting by more than one
// row's grade — either of which a one-day `passed > 0` would have let through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { rollupDay, gradeTrades } = require('../renderer/day-rollup.js');

const CANDIDATES = ['G:\\MNQ-CoPilot\\DATA\\accounts', 'D:\\co-pilot DATA\\accounts'];
const WINS = [{ name: 'London', startMin: 810, endMin: 900 }, { name: 'NY', startMin: 1140, endMin: 1260 }];

function findDataDir() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

test('LIVE GOLDEN: real stored days reproduce byte-identically', { skip: !findDataDir() }, () => {
  const root = findDataDir();
  let checked = 0, passed = 0;
  const near = [];
  for (const slot of fs.readdirSync(root)) {
    const dir = path.join(root, slot);
    const dtF = path.join(dir, 'day_trades.json');
    const grF = path.join(dir, 'gr_history.json');
    if (!fs.existsSync(dtF) || !fs.existsSync(grF)) continue;
    const dt = JSON.parse(fs.readFileSync(dtF, 'utf8'));
    const gr = JSON.parse(fs.readFileSync(grF, 'utf8'));
    for (const sum of Array.isArray(gr) ? gr : []) {
      const rows = dt[sum.date] || [];
      if (!rows.length) continue;
      checked++;
      let dayPassed = false;
      let best = null;
      // Search BOTH historical dimensions: the size cap in force that day, and
      // whether the 15-min cooldown was loss-only (scalper) or after every
      // trade (standard). maxHoldSeconds is set out of range so the scalper
      // pass never invents a hold-exceeded flag the stored row cannot have.
      for (const lossOnly of [false, true]) {
        for (let cap = 1; cap <= 8; cap++) {
          const mode = lossOnly ? 'scalper' : (sum.tradingMode || 'standard');
          const opts = { tradingMode: mode, cooldownAfterLossOnly: lossOnly, maxHoldSeconds: Infinity, sessionWindowsIST: WINS, sizeCapCsv: cap };
          const graded = gradeTrades(rows.map(r => ({ entryMs: r.t, exitMs: r.x, entryMin: null, holdSec: r.hold, size: r.size, pnl: r.pnl })), opts);
          const gDiffs = rows.filter((r, i) => JSON.stringify(r.flags) !== JSON.stringify(graded[i].flags) || r.g !== graded[i].g).length;
          const out = rollupDay(sum.date, rows, { commPerCt: 1.0, sizeCapCsv: cap, tradingMode: mode });
          const rollDiffs = Object.keys(sum).filter(k => JSON.stringify(out[k]) !== JSON.stringify(sum[k]));
          if (gDiffs === 0 && rollDiffs.length === 0) { dayPassed = true; break; }
          if (!best || rollDiffs.length + gDiffs < best.diffs.length + best.gDiffs) best = { cap, lossOnly, diffs: rollDiffs, gDiffs };
        }
        if (dayPassed) break;
      }
      if (dayPassed) { passed++; console.log('  live-golden PASS: ' + slot + ' ' + sum.date); }
      else {
        near.push({ day: slot + ' ' + sum.date, best });
        console.log('  live-golden NOTE: ' + slot + ' ' + sum.date + ' — no (cap, cooldown) matches exactly (rows may have been rewritten after the stored summary): ' + JSON.stringify(best));
      }
    }
  }
  assert.ok(checked > 0, 'no stored days found to check');
  // A MAJORITY must reproduce exactly. `passed > 0` let a single lucky day
  // stand in for the whole corpus.
  assert.ok(passed * 2 >= checked,
    'only ' + passed + '/' + checked + ' stored days reproduced byte-identically — extraction has drifted from production behaviour');
  // And no day may be far off. Post-hoc row edits move a day's pnl/over by a
  // field or two; a logic drift in gradeTrades moves MANY rows' grades. This
  // is the assertion that actually catches drift, because it does not depend
  // on any day happening to pass.
  for (const n of near) {
    assert.ok(n.best && n.best.gDiffs <= 1,
      n.day + ' has ' + (n.best ? n.best.gDiffs : '?') + ' rows whose grade/flags do not reproduce under any historical (cap, cooldown) — that is grading drift, not a rewritten row');
  }
  console.log('  live-golden: ' + passed + '/' + checked + ' stored days reproduced byte-identically'
    + (near.length ? '; ' + near.length + ' within one row of grade (' + near.map(n => n.day).join(', ') + ')' : ''));
});
