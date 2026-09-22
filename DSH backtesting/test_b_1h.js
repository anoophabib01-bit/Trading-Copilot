'use strict';
const fs = require('fs');
const backtest = require('G:/Trading-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/Trading-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const b60 = load('G:/Trading-CoPilot/DATA/bars/mnq_60.json');
const span = (b60[b60.length-1].time-b60[0].time)/86400;
const r = backtest.runPlaybookB(b60, rules, {});
const s = backtest.score(r.trades, rules, {contracts:1, spanDays:span});
console.log('PLAYBOOK B (SFP + FVG) on 1H, 65 days');
console.log('  liquidity raids:', r.raids.length);
const bc = {}; for (const b of r.blocked) bc[b.code]=(bc[b.code]||0)+1;
console.log('  blocked by risk:', r.blocked.length, JSON.stringify(bc));
console.log('  setups:', r.trades.length, '| filled:', s.filled, '| never-filled:', s.noFill);
console.log('  win:', s.winRate!=null?(s.winRate*100).toFixed(0)+'%':'n/a', '| net:', s.netUsd, '| PF:', s.profitFactor, '| maxDD:', s.maxDrawdownUsd);
console.log('  target/stop/timeout/flattened:', s.targets, s.stops, s.timeouts, s.flattened);
console.log('  avgWin / avgLoss:', s.avgWinUsd, '/', s.avgLossUsd);
console.log('  trades/day:', s.frequency?s.frequency.tradeableSetupsPerDay:'n/a');
