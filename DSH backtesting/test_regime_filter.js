'use strict';
const fs = require('fs');
const backtest = require('G:/Trading-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/Trading-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const buf=rules.playbooks.stopBufferPoints||3, rr=rules.playbooks.targetR||2, horizon=rules.playbooks.outcomeHorizonBars||12, pv=backtest.MNQ_POINT_VALUE;
const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;

// Kaufman efficiency ratio (trendiness): |close[i]-close[i-N]| / sum |close[k]-close[k-1]|
function erSeries(bars, N){
  const out=new Array(bars.length).fill(NaN);
  for(let i=N;i<bars.length;i++){
    let net=Math.abs(bars[i].close-bars[i-N].close), sum=0;
    for(let k=i-N+1;k<=i;k++) sum+=Math.abs(bars[k].close-bars[k-1].close);
    out[i] = sum>0 ? net/sum : 0;
  }
  return out;
}
function runLong(bars, lookback, erMin, hFrom, hTo){
  const er = erMin>0 ? erSeries(bars,20) : null;
  const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2,20);
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    if(er && !(er[i]>=erMin)) continue;               // trendiness filter
    if(hFrom!=null){ const h=new Date(bar.time*1000).getUTCHours(); if(!(h>=hFrom&&h<hTo)) continue; }
    let lo=Infinity,hi=-Infinity;
    for(let k=i-lookback;k<i;k++){lo=Math.min(lo,bars[k].low);hi=Math.max(hi,bars[k].high);}
    if(!(bar.close>hi && bar.close>bar.open)) continue;
    const entry=bar.close, stop=bar.low-buf; const risk=entry-stop; if(risk<=0) continue;
    const target=entry+risk*rr;
    const id='L'+i; if(seen.has(id)) continue; seen.add(id);
    const ru=risk*pv*1; if(minPts&&risk<minPts) continue; if(ru>maxUsd) continue;
    const plan={playbook:'BRK',direction:'BULLISH',entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
function s(t){ if(!t.length) return 'n=0'; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0); const l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); const pf=gl>0?(gw/gl).toFixed(2):'inf'; return 'n='+t.length+' $'+net.toFixed(0)+' PF'+pf; }

const files = { 'uptrend':'G:/Trading-CoPilot/DATA/bars/mnq_1h_uptrend.json', 'downtrend':'G:/Trading-CoPilot/DATA/bars/mnq_1h_downtrend.json', 'in-sample':'G:/Trading-CoPilot/DATA/bars/mnq_60.json', 'flat(Nov-Jan)':'G:/Trading-CoPilot/DATA/bars/mnq_1h_flat.json' };
console.log('LONG L10 breakout, all hours, with trendiness (ER20) filter:');
console.log('filter         ' + Object.keys(files).map(f=>f.padEnd(15)).join(''));
for (const er of [0, 0.2, 0.25, 0.3]){
  let row = ('ER>='+er).padEnd(15);
  for (const f of Object.values(files)){ row += s(runLong(load(f),10,er,null,null)).padEnd(15); }
  console.log(row);
}
console.log('');
console.log('LONG L10 breakout, NY session (13-17 UTC), with ER filter:');
for (const er of [0, 0.2, 0.3]){
  let row = ('ER>='+er).padEnd(15);
  for (const f of Object.values(files)){ row += s(runLong(load(f),10,er,13,17)).padEnd(15); }
  console.log(row);
}
