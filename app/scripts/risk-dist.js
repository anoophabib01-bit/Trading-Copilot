// Distribution of stop distance (riskPoints) per playbook, over the cached
// bar sets. Answers: at sizeCap 2, how many setups fit under a $200 ceiling?
const path = require('path');
const APP = 'g:/MNQ-CoPilot/app';
const bt = require(path.join(APP, 'backtest.js'));
const rules = require(path.join(APP, 'rules.json'));

function load(f) {
  const j = require('g:/MNQ-CoPilot/DATA/bars/' + f);
  return j.bars || j;
}

const PV = 2; // MNQ $/point/contract

function stats(name, riskPoints) {
  const rp = riskPoints.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rp.length) { console.log(`${name}: no setups`); return; }
  const q = (p) => rp[Math.min(rp.length - 1, Math.floor(p * rp.length))];
  const usd2 = (pts) => pts * PV * 2;
  const under = (cap) => rp.filter((p) => usd2(p) <= cap).length;
  console.log(`\n${name}  (n=${rp.length} setups)`);
  console.log(`  stop points   min ${rp[0].toFixed(1)} | p25 ${q(.25).toFixed(1)} | median ${q(.5).toFixed(1)} | p75 ${q(.75).toFixed(1)} | max ${rp[rp.length-1].toFixed(1)}`);
  console.log(`  risk @2c ($)  min $${usd2(rp[0]).toFixed(0)} | median $${usd2(q(.5)).toFixed(0)} | max $${usd2(rp[rp.length-1]).toFixed(0)}`);
  for (const cap of [100, 200, 300]) {
    const n = under(cap);
    console.log(`  fits under $${cap} risk @2c: ${n}/${rp.length} (${(100*n/rp.length).toFixed(0)}%)  -> max stop ${(cap/(PV*2)).toFixed(1)} pts`);
  }
}

// ── Playbook B on 30m ──────────────────────────────────────────────────────
{
  const bars = load('mnq_30.json');
  const r = bt.runPlaybookB(bars, rules, { contracts: 2, pointValue: PV });
  const all = (r.trades || []).concat(r.blocked || []);
  stats('Playbook B (30m, ~9 days)', all.map((t) => t.riskPoints != null ? t.riskPoints : (t.plan && t.plan.riskPoints)));
}

// ── Engulf playbooks on 60m with 240m HTF ─────────────────────────────────
for (const pb of ['A', 'LTF-ENGULF']) {
  const bars = load('mnq_60.json');
  const htf = load('mnq_240.json');
  const r = bt.runEngulfPlaybook(pb, bars, htf, rules, { contracts: 2, pointValue: PV, htfSeconds: 4 * 3600 });
  const all = (r.trades || []).concat(r.blocked || []);
  stats(`Playbook ${pb} (60m, ~43 days)`, all.map((t) => t.riskPoints != null ? t.riskPoints : (t.plan && t.plan.riskPoints)));
}
