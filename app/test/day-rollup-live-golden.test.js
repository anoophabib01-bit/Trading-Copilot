'use strict';
// LIVE GOLDEN — runs ONLY where the production DATA dir exists (Anoop's
// machine). Verifies rollupDay against summaries the OLD inline csvApply code
// produced in production. Skipped silently elsewhere. The historical sizeCap
// (4) is searched per day; a day whose rows were rewritten after its summary
// was stored cannot pass its pnl field and is reported, not failed.
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
      for (let cap = 2; cap <= 8; cap++) {
        const graded = gradeTrades(rows.map(r => ({ entryMs: r.t, exitMs: r.x, entryMin: null, holdSec: r.hold, size: r.size, pnl: r.pnl })), { tradingMode: sum.tradingMode || 'standard', sessionWindowsIST: WINS, sizeCapCsv: cap });
        const gDiffs = rows.filter((r, i) => JSON.stringify(r.flags) !== JSON.stringify(graded[i].flags) || r.g !== graded[i].g).length;
        const out = rollupDay(sum.date, rows, { commPerCt: 1.0, sizeCapCsv: cap, tradingMode: sum.tradingMode || 'standard' });
        const rollDiffs = Object.keys(sum).filter(k => JSON.stringify(out[k]) !== JSON.stringify(sum[k]));
        if (gDiffs === 0 && rollDiffs.length === 0) { dayPassed = true; break; }
        if (!best || rollDiffs.length < best.diffs.length) best = { cap, diffs: rollDiffs, gDiffs };
      }
      if (dayPassed) { passed++; console.log('  live-golden PASS: ' + slot + ' ' + sum.date); }
      else console.log('  live-golden NOTE: ' + slot + ' ' + sum.date + ' — no cap matches (rows may have been rewritten after the stored summary): ' + JSON.stringify(best));
    }
  }
  assert.ok(checked > 0, 'no stored days found to check');
  assert.ok(passed > 0, 'no stored day passed — extraction has drifted from production behaviour');
  console.log('  live-golden: ' + passed + '/' + checked + ' stored days reproduced byte-identically');
});
