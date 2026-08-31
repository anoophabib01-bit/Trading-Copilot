'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const pv=backtest.MNQ_POINT_VALUE, horizon=rules.playbooks.outcomeHorizonBars||12;
function runFixedDollar(bars, lookback, stopUsd, targetUsd){
  const stopPts=stopUsd/pv, tgtPts=targetUsd/pv;
  const trades=[]; const seen=new Set(); const warmup=lookback+2;
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    let hi=-Infinity; for(let k=i-lookback;k<i;k++) hi=Math.max(hi,bars[k].high);
    if(!(bar.close>hi && bar.close>bar.open)) continue;   // LONG breakout only
    const entry=bar.close, stop=entry-stopPts, target=entry+tgtPts;
    const id='L'+i; if(seen.has(id)) continue; seen.add(id);
    const plan={playbook:'FD',direction:'BULLISH',entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
const files = ['G:/MNQ-CoPilot/DATA/bars/mnq_1h_sepnov.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_60.json'];
const barsAll = files.map(load);
function agg(t){ if(!t.length) return null; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0),l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} return {n:t.length,net,pf:gl>0?gw/gl:Infinity,dd,win:w.length/t.length*100}; }

console.log('DOLLAR-BASED SL/TP on LONG breakout (close>10-bar high), 1 contract, 1H data.');
console.log('MNQ = $2/point.  stop/target in DOLLARS.  (5 regimes, ~10.6 months)');
console.log('  stop/tgt     trades  win%   net$    PF    DD$');
for (const [stopUsd, tgtUsd] of [[100,100],[100,150],[150,150],[150,225],[200,200],[200,300],[200,400]]){
  let all=[];
  for(const b of barsAll) all=all.concat(runFixedDollar(b,10,stopUsd,tgtUsd));
  all.sort((a,b)=>a.time-b.time);
  const s=agg(all);
  if(!s){ console.log('  $'+stopUsd+'/$'+tgtUsd+'  no trades'); continue; }
  console.log('  $'+String(stopUsd).padEnd(4)+'/$'+String(tgtUsd).padEnd(4)+'  '+String(s.n).padEnd(7)+String(s.win.toFixed(0)+'%').padEnd(6)+'$'+s.net.toFixed(0).padEnd(7)+s.pf.toFixed(2).padEnd(6)+'$'+s.dd.toFixed(0));
}
