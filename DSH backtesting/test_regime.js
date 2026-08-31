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
function run(lookback, shortOnly){
  const trades=[]; const seen=new Set(); const warmup=lookback+2;
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i]; let lo=Infinity,hi=-Infinity;
    for(let k=i-lookback;k<i;k++){lo=Math.min(lo,bars[k].low);hi=Math.max(hi,bars[k].high);}
    let dir=null,stop=null;
    if(bar.close>hi&&bar.close>bar.open){ if(shortOnly) continue; dir='BULLISH'; stop=bar.low-buf; }
    else if(bar.close<lo&&bar.close<bar.open){ dir='BEARISH'; stop=bar.high+buf; }
    if(!dir) continue;
    const entry=bar.close; const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const target=dir==='BULLISH'?entry+risk*rr:entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const ru=risk*pv*1; if(minPts&&risk<minPts) continue; if(ru>maxUsd) continue;
    const plan={playbook:'BRK',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,dir,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
function applyCap(t,cap){const s=[...t].sort((a,b)=>a.time-b.time);const byDay={};const kept=[];for(const x of s){const d=new Date(x.time*1000).toISOString().slice(0,10);const p=byDay[d]||0;if(p>=cap)continue;kept.push(x);byDay[d]=p+x.net;}return kept;}
function stats(t){ if(!t.length) return 'n=0'; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0); const l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0), gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} const pf=gl>0?(gw/gl).toFixed(2):'inf'; return 'n='+t.length+' win '+((w.length/t.length*100).toFixed(0))+'% net $'+net.toFixed(0)+' PF '+pf+' DD $'+dd.toFixed(0); }

console.log('FILE '+file+' | span '+span.toFixed(1)+' days | stop-buf '+buf+'pt target '+rr+'R');
console.log('  LONG  L5 :  '+stats(run(5,false).filter(x=>x.dir==='BULLISH')));
console.log('  LONG  L10:  '+stats(run(10,false).filter(x=>x.dir==='BULLISH')));
console.log('  SHORT L5 :  '+stats(run(5,false).filter(x=>x.dir==='BEARISH')));
console.log('  SHORT L10:  '+stats(run(10,false).filter(x=>x.dir==='BEARISH')));
console.log('  SHORT L10 +$1000/day cap:  '+stats(applyCap(run(10,false).filter(x=>x.dir==='BEARISH'),1000)));
