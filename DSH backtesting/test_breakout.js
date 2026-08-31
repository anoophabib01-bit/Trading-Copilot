'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const bars = load('G:/MNQ-CoPilot/DATA/bars/mnq_60.json');
const span = (bars[bars.length-1].time-bars[0].time)/86400;
const buf = rules.playbooks.stopBufferPoints || 3;
const rr = rules.playbooks.targetR || 2;
const horizon = rules.playbooks.outcomeHorizonBars || 12;
const pv = backtest.MNQ_POINT_VALUE;
const minPts = rules.playbooks.minRiskPoints || 0;
const maxUsd = rules.perTradeMaxLoss || Infinity;
const pad = (v,n)=>String(v).padEnd(n);

function runBreakout(lookback, trailMode){
  const trades=[], blocked=[]; const seen=new Set(); const warmup=lookback+2;
  for (let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    let lo=Infinity, hi=-Infinity;
    for (let k=i-lookback;k<i;k++){ lo=Math.min(lo,bars[k].low); hi=Math.max(hi,bars[k].high); }
    let dir=null, stop=null;
    if (bar.close > hi && bar.close > bar.open){ dir='BULLISH'; stop = trailMode==='beyond-range' ? hi-buf : bar.low-buf; }
    else if (bar.close < lo && bar.close < bar.open){ dir='BEARISH'; stop = trailMode==='beyond-range' ? lo+buf : bar.high+buf; }
    if (!dir) continue;
    const entry=bar.close;
    const risk = dir==='BULLISH' ? entry-stop : stop-entry;
    if (risk<=0) continue;
    const target = dir==='BULLISH' ? entry+risk*rr : entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const riskUsd=risk*pv*1;
    if (minPts && risk<minPts){ blocked.push('small'); continue; }
    if (riskUsd>maxUsd){ blocked.push('big'); continue; }
    const plan={playbook:'BRK', direction:dir, entry, stop, target, requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push(Object.assign({setupId:id,time:bar.time},plan,sim));
  }
  return {blocked:blocked.length, trades, score:backtest.score(trades,rules,{contracts:1,spanDays:span})};
}
function fmt(s){ const win=s.winRate!=null?(s.winRate*100).toFixed(0)+'%':'n/a'; const net=s.netUsd!=null?(s.netUsd<0?'-':'')+'$'+Math.abs(s.netUsd).toFixed(0):'n/a'; const pf=s.profitFactor!=null?s.profitFactor:'n/a'; const tpd=s.frequency?s.frequency.tradeableSetupsPerDay:'n/a'; return pad(s.filled,6)+pad(win,6)+pad(net,9)+pad(pf,6)+pad(tpd,9); }

console.log('MOMENTUM BREAKOUT (Donchian) - close beyond N-bar range, stop beyond breakout candle');
console.log('  lookback  filled  win%    net$      PF   trades/day');
for (const L of [5,10,20,40]){
  const r = runBreakout(L, 'candle');
  console.log('  '+pad(L,8)+fmt(r.score)+'   (blocked '+r.blocked+')');
}
console.log('');
console.log('MOMENTUM BREAKOUT - stop beyond the RANGE (tighter, vs beyond candle)');
for (const L of [10,20,40]){
  const r = runBreakout(L, 'beyond-range');
  console.log('  '+pad(L,8)+fmt(r.score)+'   (blocked '+r.blocked+')');
}
