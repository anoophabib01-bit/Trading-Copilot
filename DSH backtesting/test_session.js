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

function sessionOk(t, filter){
  if(filter==='all') return true;
  const h = new Date(t*1000).getUTCHours();
  if(filter==='ny-open') return h>=13 && h<=16;       // 13:00-16:59 UTC (NY open kill zone)
  if(filter==='ny-full') return h>=13 && h<=20;       // 13:00-20:59 UTC (full NY session)
  if(filter==='london') return h>=8 && h<=9;          // London 8-9 UTC
  return true;
}
function runLong(lookback, filter){
  const trades=[]; const seen=new Set(); const warmup=lookback+2;
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    if(!sessionOk(bar.time, filter)) continue;
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

console.log('FILE '+file.split('/').pop()+' | span '+span.toFixed(1)+' days');
console.log('  LONG L10 all hours :  '+stats(runLong(10,'all')));
console.log('  LONG L10 NY-open   :  '+stats(runLong(10,'ny-open')));
console.log('  LONG L10 NY-full   :  '+stats(runLong(10,'ny-full')));
console.log('  LONG L10 London    :  '+stats(runLong(10,'london')));
