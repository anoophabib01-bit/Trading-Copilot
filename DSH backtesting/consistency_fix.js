'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const bars = load('G:/MNQ-CoPilot/DATA/bars/mnq_60.json');
const span = (bars[bars.length-1].time-bars[0].time)/86400;
const buf = rules.playbooks.stopBufferPoints||3, rr = rules.playbooks.targetR||2, horizon = rules.playbooks.outcomeHorizonBars||12, pv = backtest.MNQ_POINT_VALUE;
const minPts = rules.playbooks.minRiskPoints||0, maxUsd = rules.perTradeMaxLoss||Infinity;

function runBreakout(lookback){
  const trades=[]; const seen=new Set(); const warmup=lookback+2;
  for (let i=warmup;i<bars.length;i++){
    const bar=bars[i]; let lo=Infinity,hi=-Infinity;
    for (let k=i-lookback;k<i;k++){ lo=Math.min(lo,bars[k].low); hi=Math.max(hi,bars[k].high); }
    let dir=null,stop=null;
    if (bar.close>hi && bar.close>bar.open){ dir='BULLISH'; stop=bar.low-buf; }
    else if (bar.close<lo && bar.close<bar.open){ dir='BEARISH'; stop=bar.high+buf; }
    if(!dir) continue;
    const entry=bar.close; const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const target=dir==='BULLISH'?entry+risk*rr:entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const riskUsd=risk*pv*1; if(minPts&&risk<minPts) continue; if(riskUsd>maxUsd) continue;
    const plan={playbook:'BRK',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    const net = sim.points*pv*1 - 0.95*2*1;
    trades.push({time:bar.time, dir, net, outcome:sim.outcome});
  }
  return trades;
}
function stats(t){
  if(!t.length) return {n:0};
  const netAll=t.reduce((a,b)=>a+b.net,0); const wins=t.filter(x=>x.net>0), losses=t.filter(x=>x.net<=0);
  const gw=wins.reduce((a,b)=>a+b.net,0), gl=-losses.reduce((a,b)=>a+b.net,0);
  let eq=0,peak=0,maxDD=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}
  const byDay={}; for(const x of t){const d=new Date(x.time*1000).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+x.net;}
  const days=Object.values(byDay); const maxDay=Math.max(...days);
  return {n:t.length, net:netAll, win:(t.filter(x=>x.net>0).length/t.length*100), pf:gl>0?+(gw/gl).toFixed(2):Infinity, dd:maxDD, bestDay:maxDay, consistency:netAll>0?+(maxDay/netAll*100).toFixed(0):null, days:days.length};
}
function applyDailyCap(t, cap){
  const s=[...t].sort((a,b)=>a.time-b.time); const byDay={}; const kept=[];
  for(const x of s){ const d=new Date(x.time*1000).toISOString().slice(0,10); const p=byDay[d]||0; if(p>=cap) continue; kept.push(x); byDay[d]=p+x.net; }
  return kept;
}
function line(label, s){
  console.log('  '+label.padEnd(28)+ 'n='+String(s.n).padEnd(4)+'win '+s.win.toFixed(0)+'%  net $'+s.net.toFixed(0).padStart(6)+'  PF '+String(s.pf).padEnd(5)+'  maxDD $'+s.dd.toFixed(0).padStart(5)+'  bestDay $'+s.bestDay.toFixed(0)+'  consist '+s.consistency+'%');
}

for (const L of [5,10]){
  const all = runBreakout(L);
  const short = all.filter(x=>x.dir==='BEARISH');
  const capAll = applyDailyCap(all, 1000);
  const capShort = applyDailyCap(short, 1000);
  console.log('=== BREAKOUT lookback '+L+' ===');
  line('all', stats(all));
  line('short-only', stats(short));
  line('all + $1000/day cap', stats(capAll));
  line('short-only + $1000/day cap', stats(capShort));
  console.log('');
}
