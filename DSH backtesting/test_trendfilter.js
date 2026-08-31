'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
const file = process.argv[2];
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const bars = load(file);
const span = (bars[bars.length-1].time-bars[0].time)/86400;
const buf=rules.playbooks.stopBufferPoints||3, rr=rules.playbooks.targetR||2, horizon=rules.playbooks.outcomeHorizonBars||12, pv=backtest.MNQ_POINT_VALUE;
const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;

function smaSeries(period){ const out=new Array(bars.length).fill(NaN); let s=0; for(let i=0;i<bars.length;i++){ s+=bars[i].close; if(i>=period) s-=bars[i-period].close; if(i>=period-1) out[i]=s/period; } return out; }
function runLongBreakout(lookback, smaPeriod){
  const sma = smaPeriod?smaSeries(smaPeriod):null;
  const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2, smaPeriod||0);
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    if(sma && !(bar.close > sma[i])) continue;
    let lo=Infinity, hi=-Infinity;
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
function stats(t){ if(!t.length) return 'n=0'; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0); const l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0), gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} const pf=gl>0?(gw/gl).toFixed(2):'inf'; return 'n='+t.length+' win '+((w.length/t.length*100).toFixed(0))+'% net $'+net.toFixed(0)+' PF '+pf+' DD $'+dd.toFixed(0); }
function monthBreakdown(t){
  const byM={}; for(const x of t){const m=new Date(x.time*1000).toISOString().slice(0,7); byM[m]=(byM[m]||0)+x.net;}
  return Object.entries(byM).map(([m,n])=>m+':$'+n.toFixed(0)).join('  ');
}

console.log('FILE '+file.split('/').pop()+' | span '+span.toFixed(1)+' days');
console.log('  LONG L10 no filter :  '+stats(runLongBreakout(10,0)));
console.log('  LONG L10 +SMA100   :  '+stats(runLongBreakout(10,100)));
console.log('  LONG L10 +SMA200   :  '+stats(runLongBreakout(10,200)));
console.log('  LONG L10 +SMA200 monthly:  '+monthBreakdown(runLongBreakout(10,200)));
